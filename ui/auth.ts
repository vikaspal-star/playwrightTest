// ============================================================
// AUTH
// ------------------------------------------------------------
// Minimal, dependency-free session auth for Test Studio.
//   - Passwords hashed with scrypt (Node's built-in crypto).
//   - Sessions are random tokens in an httpOnly cookie, backed
//     by a JSON file so a server restart doesn't log everyone out.
//   - Two roles: "admin" (can manage users) and "member".
//
// Everything lives under ./ui/data (git-ignored). This is a
// local tool, not a hardened multi-tenant service: good enough
// hygiene (hashed passwords, random tokens, httpOnly cookies,
// timing-safe compares), not a replacement for a real IdP.
// ============================================================

import crypto from "crypto";
import path from "path";
import { IncomingMessage, ServerResponse } from "http";
import { FEATURE_IDS, Role, effectiveFeatures } from "./features";
import { DATA_DIR } from "./config";
import { readJson, writeJson } from "./storage";
import { ValidationError } from "../src/validation";

const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

const SESSION_COOKIE = "studio_sid";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_PASSWORD_LENGTH = 8;

export type { Role };

export interface User {
  id: string;
  username: string;
  role: Role;
  passwordHash: string; // hex
  salt: string; // hex
  createdAt: string;
  /** Explicit feature grants. Absent means "use the role defaults". */
  features?: string[];
}

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
  features?: string[];
  /** Resolved grants (role defaults merged with any explicit grants). */
  effectiveFeatures: string[];
}

interface Session {
  userId: string;
  expires: number; // epoch ms
}

// ------------------------------------------------------------
// Storage
// ------------------------------------------------------------

function loadUsers(): User[] {
  const users = readJson<User[]>(USERS_FILE, []);
  if (!Array.isArray(users) || users.some(u => !u || typeof u.id !== "string" || typeof u.username !== "string" || !["site_admin", "admin", "member"].includes(u.role))) {
    throw new Error("Invalid user storage. Restore a valid backup before continuing.");
  }
  if (!users.length) return users;

  // Migration for accounts created before site_admin existed: the earliest
  // admin (falling back to the earliest account) becomes the site admin, so
  // there is always exactly one topmost account.
  if (!users.some(u => u.role === "site_admin")) {
    const byAge = [...users].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const promote = byAge.find(u => u.role === "admin") ?? byAge[0];
    if (promote) {
      promote.role = "site_admin";
      saveUsers(users);
    }
  }
  return users;
}

function saveUsers(users: User[]): void {
  writeJson(USERS_FILE, users);
}

function loadSessions(): Record<string, Session> {
  const sessions = readJson<Record<string, Session>>(SESSIONS_FILE, {});
  const now = Date.now();
  let changed = false;
  for (const [token, s] of Object.entries(sessions)) {
    if (s.expires < now) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) writeJson(SESSIONS_FILE, sessions);
  return sessions;
}

function saveSessions(sessions: Record<string, Session>): void {
  writeJson(SESSIONS_FILE, sessions);
}

// ------------------------------------------------------------
// Passwords
// ------------------------------------------------------------

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function validatePassword(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 256) return "Password must be at most 256 characters.";
  return null;
}

// ------------------------------------------------------------
// Users
// ------------------------------------------------------------

export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _h, salt: _s, ...pub } = user;
  return { ...pub, effectiveFeatures: effectiveFeatures(user.role, user.features) };
}

export function hasAnyUser(): boolean {
  return loadUsers().length > 0;
}

export function listUsers(): PublicUser[] {
  return loadUsers().map(toPublicUser).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findUserByUsername(username: string): User | undefined {
  return loadUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
}

export function findUserById(id: string): User | undefined {
  return loadUsers().find(u => u.id === id);
}

export function createUser(username: string, password: string, role: Role, features?: string[]): PublicUser {
  const clean = username.trim();
  if (!clean) throw new ValidationError("Username is required.");
  if (clean.length > 80 || /[\x00-\x1f]/.test(clean)) throw new ValidationError("Username must be at most 80 characters without control characters.");
  if (findUserByUsername(clean)) throw new ValidationError(`User "${clean}" already exists.`);
  const pwError = validatePassword(password);
  if (pwError) throw new ValidationError(pwError);

  const salt = crypto.randomBytes(16).toString("hex");
  const user: User = {
    id: crypto.randomBytes(12).toString("hex"),
    username: clean,
    role,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
    ...(features ? { features: features.filter(f => FEATURE_IDS.includes(f)) } : {})
  };

  const users = loadUsers();
  users.push(user);
  saveUsers(users);
  return toPublicUser(user);
}

/** Site-admin only: change a user's role and/or their explicit feature grants. */
export function updateUser(id: string, changes: { role?: Role; features?: string[] | null }): PublicUser {
  const users = loadUsers();
  const user = users.find(u => u.id === id);
  if (!user) throw new ValidationError("User not found.");

  if (changes.role && changes.role !== user.role) {
    if (user.role === "site_admin" && users.filter(u => u.role === "site_admin").length <= 1) {
      throw new ValidationError("Promote another account to site admin first.");
    }
    user.role = changes.role;
  }

  if (changes.features === null) delete user.features;
  else if (Array.isArray(changes.features)) {
    user.features = changes.features.filter(f => FEATURE_IDS.includes(f));
  }

  saveUsers(users);
  return toPublicUser(user);
}

export function deleteUser(id: string): void {
  const users = loadUsers();
  const target = users.find(u => u.id === id);
  if (!target) throw new ValidationError("User not found.");
  if (target.role === "site_admin" && users.filter(u => u.role === "site_admin").length <= 1) {
    throw new ValidationError("Cannot remove the last site admin.");
  }
  saveUsers(users.filter(u => u.id !== id));

  const sessions = loadSessions();
  for (const [token, s] of Object.entries(sessions)) {
    if (s.userId === id) delete sessions[token];
  }
  saveSessions(sessions);
}

export function changePassword(id: string, newPassword: string): void {
  const pwError = validatePassword(newPassword);
  if (pwError) throw new ValidationError(pwError);
  const users = loadUsers();
  const user = users.find(u => u.id === id);
  if (!user) throw new ValidationError("User not found.");
  user.salt = crypto.randomBytes(16).toString("hex");
  user.passwordHash = hashPassword(newPassword, user.salt);
  saveUsers(users);
  const sessions = loadSessions();
  for (const [token, session] of Object.entries(sessions)) {
    if (session.userId === id) delete sessions[token];
  }
  saveSessions(sessions);
}

export function verifyLogin(username: string, password: string): User | null {
  if (username.length > 80 || password.length > 256) return null;
  const user = findUserByUsername(username);
  if (!user) return null;
  return verifyPassword(password, user.salt, user.passwordHash) ? user : null;
}

// ------------------------------------------------------------
// Sessions / cookies
// ------------------------------------------------------------

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = Object.create(null);
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try { out[key] = decodeURIComponent(value); } catch { /* Ignore malformed cookies. */ }
    }
  }
  return out;
}

export function createSession(userId: string, res: ServerResponse): void {
  const token = crypto.randomBytes(32).toString("hex");
  const sessions = loadSessions();
  sessions[token] = { userId, expires: Date.now() + SESSION_TTL_MS };
  saveSessions(sessions);

  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${process.env.COOKIE_SECURE === "1" ? "; Secure" : ""}`
  );
}

export function destroySession(req: IncomingMessage, res: ServerResponse): void {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const sessions = loadSessions();
    delete sessions[token];
    saveSessions(sessions);
  }
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${process.env.COOKIE_SECURE === "1" ? "; Secure" : ""}`);
}

/** Resolve the current request's user from its session cookie, if any. */
export function currentUser(req: IncomingMessage): PublicUser | null {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session || session.expires < Date.now()) return null;
  const user = findUserById(session.userId);
  return user ? toPublicUser(user) : null;
}
