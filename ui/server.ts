// ============================================================
// TEST STUDIO SERVER
// ------------------------------------------------------------
// Local web UI for the JSON-driven Playwright framework.
//   npm run ui   ->  http://localhost:4173
//
// - Lists / edits / creates the test cases in ./json, organized
//   into nested (virtual) folders and shareable per test.
// - Runs a test through the normal Playwright runner, or a suite
//   (an ordered chain of tests sharing one browser session) via
//   an in-process Playwright driver, streaming per-step progress
//   (with a screenshot after every step) over Server-Sent Events.
// - Keeps run history under ./runs/<runId>/
// - Gated behind a login (see ./auth.ts): the first person to
//   visit becomes admin, everyone else needs an account.
// - "Analyze with AI" on a failed step calls Anthropic's Claude
//   API (see ./anthropic.ts) when ANTHROPIC_API_KEY is set.
// ============================================================

import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { ChildProcess, spawn } from "child_process";
import { chromium, devices } from "playwright";
import { ActionExecutor, TestStep } from "../src/ActionExecutor";
import { ACTION_CATALOG, FIELD_META } from "../src/actionCatalog";
import {
  PublicUser,
  changePassword,
  createSession,
  createUser,
  currentUser,
  deleteUser,
  destroySession,
  hasAnyUser,
  listUsers,
  toPublicUser,
  updateUser,
  verifyLogin
} from "./auth";
import { FEATURES, Role, effectiveFeatures, normalizeRole } from "./features";
import { listFor, markRead, notify, unreadCount } from "./notifications";
import * as db from "./db";
import {
  Insight,
  LearnRun,
  buildKnowledge,
  buildRunReport,
  insightsForRun
} from "./learning";
import { RunLike, buildReport } from "./reports";
import { importTest } from "./importers";
import * as recorder from "./recorder";
import { AnalysisResult, analyzeFailure, analyzeRun, isConfigured as aiConfigured } from "./anthropic";
import { ROOT, WORKSPACE, JSON_DIR, SUITES_DIR, RUNS_DIR, DATA_DIR, HOST, PORT, MAX_ACTIVE_RUNS, RUN_TIMEOUT_MS } from "./config";
import { readJson, writeJson, acquireWorkspaceLock } from "./storage";
import { validateTest, ValidationError } from "../src/validation";
import { securityHeaders, sameOrigin, authRateLimit } from "./security";

const PUBLIC_DIR = path.join(__dirname, "public");
const TEST_META_FILE = path.join(DATA_DIR, "testMeta.json");
const FOLDERS_FILE = path.join(DATA_DIR, "folders.json");
const PLAYWRIGHT_CLI = path.join(ROOT, "node_modules", "@playwright", "test", "cli.js");

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";
type RunStatus = "running" | "passed" | "failed";
type RunKind = "test" | "suite";
type Access = "edit" | "view" | null;

interface StepResult {
  index: number;
  action: string;
  status: StepStatus;
  durationMs?: number;
  screenshot?: string;
  error?: string;
  analysis?: AnalysisResult;
  /** Suite runs only: which test file this step came from, and its index within that test. */
  testFile?: string;
  testStepIndex?: number;
}

interface RunRecord {
  id: string;
  file: string;
  name: string;
  kind?: RunKind; // absent on older records written before suites existed; treat as "test"
  status: RunStatus;
  startedAt: string;
  startedBy?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  steps: StepResult[];
  log: string[];
  /** Derived from run history when the run finishes. */
  insights?: Insight[];
  testFiles?: string[];
  error?: string;
  sourceAccess?: Record<string, TestMeta>;
}

interface ActiveRun {
  record: RunRecord;
  listeners: Set<Response>;
  stop: () => void;
}

interface TestFile {
  file: string;
  name: string;
  description: string;
  steps: Record<string, unknown>[];
}

interface SharedGrant {
  username: string;
  permission: "view" | "edit";
}

interface TestMeta {
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
  folder?: string;
  visibility?: "team" | "restricted";
  sharedWith?: SharedGrant[];
}

interface SuiteFile {
  file: string;
  name: string;
  description: string;
  continueOnFailure: boolean;
  tests: string[];
}

const activeRuns = new Map<string, ActiveRun>();

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------
// Auth helpers (throw HttpError so the shared error handler renders them)
// ------------------------------------------------------------

function requireAuth(req: Request): PublicUser {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, "Not authenticated");
  return user;
}

function isAdminish(user: PublicUser): boolean {
  return user.role === "admin" || user.role === "site_admin";
}

function requireAdmin(req: Request): PublicUser {
  const user = requireAuth(req);
  if (!isAdminish(user)) throw new HttpError(403, "Admin access required");
  return user;
}

function requireSiteAdmin(req: Request): PublicUser {
  const user = requireAuth(req);
  if (user.role !== "site_admin") throw new HttpError(403, "Site admin access required");
  return user;
}

/** Gate a route on a granted feature (site admins always pass). */
function requireFeature(req: Request, feature: string): PublicUser {
  const user = requireAuth(req);
  if (!effectiveFeatures(user.role, user.features).includes(feature)) {
    throw new HttpError(403, `Your account does not have the "${feature}" feature enabled.`);
  }
  return user;
}

// ------------------------------------------------------------
// Sharing / access control
// ------------------------------------------------------------

// Default (no visibility set, or "team"): every signed-in user can edit, exactly
// matching pre-sharing behavior so existing tests are unaffected until restricted.
function resolveAccess(meta: TestMeta, user: PublicUser): Access {
  if (isAdminish(user)) return "edit";
  if (meta.createdBy && meta.createdBy === user.username) return "edit";
  if (meta.visibility !== "restricted") return "edit";
  const grant = meta.sharedWith?.find(g => g.username === user.username);
  return grant ? grant.permission : null;
}

function requireDeleteAccess(meta: TestMeta, user: PublicUser): void {
  if (isAdminish(user)) return;
  if (meta.createdBy && meta.createdBy === user.username) return;
  throw new HttpError(403, "Only the creator or an admin can delete this.");
}

function requireShareAccess(meta: TestMeta, user: PublicUser): void {
  if (isAdminish(user)) return;
  if (meta.createdBy && meta.createdBy === user.username) return;
  throw new HttpError(403, "Only the creator or an admin can change sharing settings.");
}

function canReadTest(file: string, user: PublicUser): boolean {
  return resolveAccess(getTestMeta(file), user) !== null;
}

function canReadSuite(file: string, user: PublicUser): boolean {
  try { return readSuite(file).tests.every(test => canReadTest(test, user)); }
  catch { return isAdminish(user); }
}

function canReadRun(record: RunRecord, user: PublicUser): boolean {
  if (isAdminish(user)) return true;
  const accessible = (file: string) => {
    const current = getTestMeta(file);
    const original = record.sourceAccess?.[file];
    return resolveAccess(original && original.createdAt !== current.createdAt ? original : current, user) !== null;
  };
  if (record.kind !== "suite") return accessible(record.file);
  const files = record.testFiles ?? [...new Set(record.steps.map(step => step.testFile).filter((file): file is string => !!file))];
  // Old suite records with no source attribution cannot safely be exposed.
  return files.length > 0 && files.every(accessible);
}

function requireRun(req: Request): RunRecord {
  const user = requireAuth(req);
  const record = loadRun(String(req.params.id));
  if (!record || !canReadRun(record, user)) throw new HttpError(404, "Run not found");
  return record;
}

function requireRecording(req: Request): recorder.RecordingSession {
  const user = requireAuth(req);
  const session = recorder.get(String(req.params.id));
  if (!session || (session.startedBy !== user.username && !isAdminish(user))) throw new HttpError(404, "Recording not found");
  return session;
}

function assertRunCapacity(): void {
  if (activeRuns.size >= MAX_ACTIVE_RUNS) throw new HttpError(429, `All ${MAX_ACTIVE_RUNS} run slots are busy. Wait for a run to finish.`);
}

function testInUse(file: string): boolean {
  return [...activeRuns.values()].some(({ record }) => record.kind === "suite"
    ? record.testFiles?.includes(file) : record.file === file);
}

// ------------------------------------------------------------
// Test file helpers
// ------------------------------------------------------------

const FILE_RE = /^[A-Za-z0-9_.-]+\.json$/;

function safeFile(name: string): string {
  if (!FILE_RE.test(name) || name.includes("..")) {
    throw new HttpError(400, `Invalid file name: ${name}`);
  }
  return name;
}

function testPath(file: string): string {
  return path.join(JSON_DIR, safeFile(file));
}

function readTest(file: string): TestFile {
  const p = testPath(file);
  if (!fs.existsSync(p)) throw new HttpError(404, `Test not found: ${file}`);

  let parsed: { name?: unknown; description?: unknown; steps?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    throw new HttpError(422, `Invalid JSON in ${file}`);
  }
  if (!parsed || !Array.isArray(parsed.steps)) throw new HttpError(422, `No "steps" array in ${file}`);

  return {
    file,
    name: typeof parsed.name === "string" ? parsed.name : "",
    description: typeof parsed.description === "string" ? parsed.description : "",
    steps: parsed.steps as Record<string, unknown>[]
  };
}

function validateTestBody(body: unknown): Record<string, unknown> {
  return validateTest(body);
}

function writeTest(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(JSON_DIR, { recursive: true });
  writeJson(testPath(file), data);
}

// ------------------------------------------------------------
// Test attribution, folder, and sharing metadata
// ------------------------------------------------------------

function loadTestMeta(): Record<string, TestMeta> {
  const meta = readJson<Record<string, TestMeta>>(TEST_META_FILE, {});
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Invalid test metadata storage.");
  for (const item of Object.values(meta)) {
    if (!item || typeof item !== "object" || Array.isArray(item) || (item.visibility !== undefined && !["team", "restricted"].includes(item.visibility)) || (item.sharedWith !== undefined && (!Array.isArray(item.sharedWith) || item.sharedWith.some(grant => !grant || typeof grant.username !== "string" || !["view", "edit"].includes(grant.permission))))) throw new Error("Invalid test sharing metadata. Restore a valid backup.");
  }
  return meta;
}

function saveTestMeta(meta: Record<string, TestMeta>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJson(TEST_META_FILE, meta);
}

function getTestMeta(file: string): TestMeta {
  return loadTestMeta()[file] ?? {};
}

function touchTestMeta(file: string, username: string, created: boolean, extra: Partial<TestMeta> = {}): TestMeta {
  const all = loadTestMeta();
  const now = new Date().toISOString();
  const existing = all[file] ?? {};
  const next: TestMeta = created
    ? { createdBy: username, createdAt: now, updatedBy: username, updatedAt: now, ...extra }
    : { ...existing, updatedBy: username, updatedAt: now, ...extra };
  all[file] = next;
  saveTestMeta(all);
  return next;
}

// ---- Folders (virtual: files stay flat on disk, this is purely organizational) ----

const FOLDER_SEGMENT_RE = /^[A-Za-z0-9 _.-]+$/;

function loadFolders(): string[] {
  return readJson<string[]>(FOLDERS_FILE, []);
}

function saveFolders(list: string[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJson(FOLDERS_FILE, [...new Set(list)].sort());
}

function normalizeFolder(raw: string): string {
  const segments = raw.split("/").map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    if (!FOLDER_SEGMENT_RE.test(seg) || seg === "." || seg === "..") throw new HttpError(400, `Invalid folder name: "${seg}"`);
  }
  return segments.join("/");
}

function ancestorsOf(folder: string): string[] {
  const segments = folder.split("/");
  return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

function registerFolder(folder: string): void {
  if (!folder) return;
  const set = new Set(loadFolders());
  for (const a of ancestorsOf(folder)) set.add(a);
  saveFolders([...set]);
}

function allFolders(): string[] {
  const set = new Set(loadFolders());
  for (const meta of Object.values(loadTestMeta())) {
    if (meta.folder) for (const a of ancestorsOf(meta.folder)) set.add(a);
  }
  return [...set].sort();
}

// ------------------------------------------------------------
// Suite file helpers
// ------------------------------------------------------------

function suitePath(file: string): string {
  return path.join(SUITES_DIR, safeFile(file));
}

function readSuite(file: string): SuiteFile {
  const p = suitePath(file);
  if (!fs.existsSync(p)) throw new HttpError(404, `Suite not found: ${file}`);

  let parsed: { name?: unknown; description?: unknown; tests?: unknown; continueOnFailure?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    throw new HttpError(422, `Invalid JSON in ${file}`);
  }
  if (!parsed || !Array.isArray(parsed.tests)) throw new HttpError(422, `No "tests" array in ${file}`);
  if (parsed.tests.some(test => typeof test !== "string" || !FILE_RE.test(test) || test.includes(".."))) throw new HttpError(422, `Invalid test reference in ${file}`);

  return {
    file,
    name: typeof parsed.name === "string" ? parsed.name : "",
    description: typeof parsed.description === "string" ? parsed.description : "",
    continueOnFailure: Boolean(parsed.continueOnFailure),
    tests: (parsed.tests as unknown[]).filter((t): t is string => typeof t === "string")
  };
}

function writeSuite(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(SUITES_DIR, { recursive: true });
  writeJson(suitePath(file), data);
}

function validateSuiteBody(body: unknown, user: PublicUser): Record<string, unknown> {
  if (!body || typeof body !== "object") throw new HttpError(400, "Body must be an object");
  const b = body as { name?: unknown; description?: unknown; tests?: unknown; continueOnFailure?: unknown };
  if (!Array.isArray(b.tests)) throw new HttpError(400, "tests must be an array");

  if (b.tests.length > 200) throw new HttpError(400, "A suite can contain at most 200 tests.");
  if (b.continueOnFailure !== undefined && typeof b.continueOnFailure !== "boolean") throw new HttpError(400, "continueOnFailure must be a boolean.");
  const tests = b.tests.map(t => {
    if (typeof t !== "string") throw new HttpError(400, "Each suite entry must be a test filename.");
    const file = safeFile(t);
    if (!fs.existsSync(testPath(file)) || !canReadTest(file, user)) throw new HttpError(400, `Test unavailable: ${file}`);
    return file;
  });

  const out: Record<string, unknown> = {};
  if (typeof b.name === "string" && b.name.trim()) out.name = b.name.trim();
  if (typeof b.description === "string" && b.description.trim()) out.description = b.description.trim();
  out.continueOnFailure = Boolean(b.continueOnFailure);
  out.tests = tests;
  return out;
}

// ------------------------------------------------------------
// Run storage helpers
// ------------------------------------------------------------

function runPath(id: string): string {
  return path.join(RUNS_DIR, id, "run.json");
}

function saveRun(record: RunRecord): void {
  fs.mkdirSync(path.join(RUNS_DIR, record.id), { recursive: true });
  writeJson(runPath(record.id), record);
}

function loadRun(id: string): RunRecord | undefined {
  const live = activeRuns.get(id);
  if (live) return live.record;
  if (!/^[A-Za-z0-9_.-]+$/.test(id) || id.includes("..")) return undefined;
  const p = runPath(id);
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as RunRecord;
  } catch {
    return undefined;
  }
}

function listRuns(file?: string, kind?: RunKind): RunRecord[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const runs: RunRecord[] = [];
  for (const dir of fs.readdirSync(RUNS_DIR)) {
    const rec = loadRun(dir);
    if (!rec) continue;
    if (file && rec.file !== file) continue;
    if (kind && (rec.kind ?? "test") !== kind) continue;
    runs.push(rec);
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Run record without the (potentially large) log. */
function summary(rec: RunRecord): Omit<RunRecord, "log"> {
  const { log: _log, ...rest } = rec;
  return rest;
}

function isRunning(kind: RunKind, file: string): boolean {
  for (const run of activeRuns.values()) {
    if ((run.record.kind ?? "test") === kind && run.record.file === file) return true;
  }
  return false;
}

// ------------------------------------------------------------
// Streaming helpers
// ------------------------------------------------------------

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineSplitter(onLine: (line: string) => void) {
  let buffer = "";
  return {
    push(chunk: Buffer) {
      buffer += chunk.toString("utf-8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        onLine(buffer.slice(0, idx).replace(/\r$/, ""));
        buffer = buffer.slice(idx + 1);
      }
    },
    flush() {
      if (buffer.trim()) onLine(buffer);
      buffer = "";
    }
  };
}

function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(run: ActiveRun, event: string, data: unknown): void {
  for (const res of run.listeners) {
    try {
      const user = currentUser(res.req);
      if (!user || !canReadRun(run.record, user)) { run.listeners.delete(res); res.end(); continue; }
      sse(res, event, data);
    } catch { run.listeners.delete(res); res.end(); }
  }
}

// ------------------------------------------------------------
// Single-test run orchestration (spawns the Playwright CLI, as before)
// ------------------------------------------------------------

function startRun(file: string, startedBy: string): RunRecord {
  const test = { ...readTest(file), ...validateTest(readTest(file), true) };
  assertRunCapacity();
  if (isRunning("test", file)) throw new HttpError(409, `${file} is already running`);
  if (!fs.existsSync(PLAYWRIGHT_CLI)) {
    throw new HttpError(500, "Playwright is not installed. Run `npm ci` first.");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const id = `${stamp}_${file.replace(/\.json$/, "")}`;
  const dir = path.join(RUNS_DIR, id);

  const record: RunRecord = {
    id,
    file,
    name: test.name || file,
    kind: "test",
    status: "running",
    startedAt: new Date().toISOString(),
    startedBy,
    sourceAccess: { [file]: getTestMeta(file) },
    steps: test.steps.map((s, i) => ({
      index: i + 1,
      action: String(s.action ?? ""),
      status: "pending"
    })),
    log: []
  };
  saveRun(record);
  const inputDir = path.join(dir, "input");
  writeJson(path.join(inputDir, file), { name: test.name, description: test.description, steps: test.steps });

  // The spec names every test "Installation: <file>"; anchor the grep to that.
  const grep = `Installation: ${escapeRegex(file)}$`;

  const proc: ChildProcess = spawn(
    process.execPath,
    [PLAYWRIGHT_CLI, "test", "--grep", grep, "--reporter=list,html", "--workers=1", "--timeout", String(RUN_TIMEOUT_MS), "--output", path.join(dir, "artifacts")],
    {
      cwd: ROOT,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        RUN_DIR: dir,
        TEST_JSON_DIR: inputDir,
        PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(dir, "report"),
        FORCE_COLOR: "0",
        PLAYWRIGHT_HTML_OPEN: "never"
      }
    }
  );

  const active: ActiveRun = { record, listeners: new Set(), stop: () => {
    record.error ??= "Run stopped by user.";
    if (process.platform === "win32" && proc.pid) {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => proc.kill());
    } else if (proc.pid) {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    }
  } };
  activeRuns.set(id, active);

  const handleLine = (line: string): void => {
    record.log.push(line);
    if (record.log.length > 2000) record.log.shift();
    broadcast(active, "log", { line });

    const running = /^STEP (\d+)\/\d+$/.exec(line);
    if (running) {
      const step = record.steps[Number(running[1]) - 1];
      if (step && step.status === "pending") {
        step.status = "running";
        broadcast(active, "step", step);
      }
      return;
    }

    if (line.startsWith("@@STEP ")) {
      try {
        const ev = JSON.parse(line.slice(7)) as Partial<StepResult>;
        const step = record.steps[(ev.index ?? 0) - 1];
        if (!step) return;
        step.status = ev.status ?? step.status;
        step.durationMs = ev.durationMs;
        step.screenshot = ev.screenshot;
        step.error = ev.error;
        broadcast(active, "step", step);
      } catch {
        // malformed event line: ignore
      }
    }
  };

  const out = lineSplitter(handleLine);
  const err = lineSplitter(handleLine);
  proc.stdout?.on("data", chunk => out.push(chunk));
  proc.stderr?.on("data", chunk => err.push(chunk));
  proc.on("error", e => handleLine(`Failed to start Playwright: ${e.message}`));

  const deadline = setTimeout(() => { record.error = "Run exceeded the configured time limit."; active.stop(); }, RUN_TIMEOUT_MS + 30000);
  proc.on("close", code => {
    clearTimeout(deadline);
    out.flush();
    err.flush();

    record.exitCode = code;
    record.status = code === 0 && !record.error && record.steps.every(step => step.status === "passed") ? "passed" : "failed";
    record.finishedAt = new Date().toISOString();
    record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);

    for (const step of record.steps) {
      if (record.status === "passed") {
        if (step.status === "pending" || step.status === "running") step.status = "passed";
      } else if (step.status === "running") {
        step.status = "failed";
        step.error = step.error ?? "Test aborted before the step finished (timeout or crash). See console log.";
      } else if (step.status === "pending") {
        step.status = "skipped";
      }
    }

    saveRun(record);
    finalizeRun(record);
    broadcast(active, "done", summary(record));
    for (const res of active.listeners) res.end();
    activeRuns.delete(id);
  });

  return record;
}

/**
 * Everything that happens once a run stops: learn from it, mirror it into
 * the database, and tell the person who started it. Never throws - a run
 * that finished must not be lost to a reporting problem.
 */
function finalizeRun(record: RunRecord): void {
  try {
    const history = listRuns(record.file, record.kind ?? "test") as unknown as LearnRun[];
    record.insights = insightsForRun(record as unknown as LearnRun, history);
    saveRun(record);
  } catch (e) {
    console.error("Failed to derive run insights:", e);
  }

  void db.saveRun({
    id: record.id,
    file: record.file,
    name: record.name,
    kind: record.kind ?? "test",
    status: record.status,
    startedAt: record.startedAt,
    startedBy: record.startedBy,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    steps: record.steps.map(s => ({
      index: s.index,
      action: s.action,
      status: s.status,
      durationMs: s.durationMs,
      error: s.error,
      testFile: s.testFile
    }))
  });

  notifyRunFinished(record);
}

function notifyRunFinished(record: RunRecord): void {
  const failed = record.status === "failed";
  const failedStep = record.steps.find(s => s.status === "failed");
  const label = record.kind === "suite" ? "Suite" : "Test";
  const passedCount = record.steps.filter(s => s.status === "passed").length;
  const seconds = record.durationMs ? `${Math.round(record.durationMs / 1000)}s` : "";
  const link = record.kind === "suite" ? `suite:${record.file}` : record.file;

  const body = failed && failedStep
    ? `Step ${failedStep.index} (${failedStep.action}) failed after ${seconds}. ` +
      `${passedCount}/${record.steps.length} steps passed.` +
      (failedStep.error ? ` ${failedStep.error.split("\n")[0].slice(0, 120)}` : "")
    : `${passedCount}/${record.steps.length} steps passed in ${seconds}.`;

  const recipients = new Set<string>();
  if (record.startedBy) recipients.add(record.startedBy);

  // A failure also reaches the test owner, so a broken test is not missed
  // just because someone else happened to run it.
  if (failed && (record.kind ?? "test") === "test") {
    const owner = getTestMeta(record.file).createdBy;
    if (owner) recipients.add(owner);
  }

  for (const username of recipients) {
    notify(username, {
      type: "run",
      title: `${label} ${failed ? "failed" : "passed"}: ${record.name}`,
      body,
      link
    });
  }
}

// ------------------------------------------------------------
// Suite run orchestration (in-process: one browser session shared
// across every test in the suite, so login/session state carries over)
// ------------------------------------------------------------

function startSuiteRun(file: string, user: PublicUser): RunRecord {
  const suite = readSuite(file);
  assertRunCapacity();
  if (isRunning("suite", file)) throw new HttpError(409, `${file} is already running`);
  if (!suite.tests.length) throw new HttpError(400, "Add at least one test to the suite before running.");

  const resolved: { file: string; name: string; steps: TestStep[] }[] = [];
  for (const testFile of suite.tests) {
    let test: TestFile;
    try {
      test = readTest(testFile);
    } catch {
      throw new HttpError(400, `Suite references a test that no longer exists: ${testFile}`);
    }
    if (resolveAccess(getTestMeta(testFile), user) === null) {
      throw new HttpError(403, `You don't have access to "${testFile}", which this suite includes.`);
    }
    const validated = validateTest(test, true);
    resolved.push({ file: testFile, name: test.name || testFile, steps: validated.steps as unknown as TestStep[] });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  const id = `${stamp}_suite_${file.replace(/\.json$/, "")}`;
  const dir = path.join(RUNS_DIR, id);

  const steps: StepResult[] = [];
  let globalIndex = 0;
  for (const t of resolved) {
    t.steps.forEach((s, i) => {
      globalIndex++;
      steps.push({ index: globalIndex, action: s.action, status: "pending", testFile: t.file, testStepIndex: i + 1 });
    });
  }

  const record: RunRecord = {
    id,
    file,
    name: suite.name || file,
    kind: "suite",
    status: "running",
    startedAt: new Date().toISOString(),
    startedBy: user.username,
    testFiles: suite.tests,
    sourceAccess: Object.fromEntries(suite.tests.map(file => [file, getTestMeta(file)])),
    steps,
    log: []
  };
  saveRun(record);

  let aborted = false;
  for (const test of resolved) writeJson(path.join(dir, "input", test.file), { name: test.name, steps: test.steps });
  let closeBrowser: (() => Promise<void>) | null = null;

  const active: ActiveRun = {
    record,
    listeners: new Set(),
    stop: () => {
      record.error ??= "Run stopped by user.";
      aborted = true;
      closeBrowser?.().catch(() => {});
    }
  };
  activeRuns.set(id, active);

  const log = (line: string): void => {
    record.log.push(line);
    if (record.log.length > 2000) record.log.shift();
    broadcast(active, "log", { line });
  };

  const deadline = setTimeout(() => { record.error = "Suite exceeded the configured time limit."; active.stop(); }, RUN_TIMEOUT_MS);
  void runSuiteSteps();

  async function runSuiteSteps(): Promise<void> {
    log("");
    log("========================================");
    log(`SUITE FILE: ${file}`);
    log("========================================");

    let anyFailure = false;
    let haltSuite = false;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

    try {
      browser = await chromium.launch({ headless: true });
      closeBrowser = () => browser!.close();
      if (aborted) throw new Error(record.error || "Suite stopped.");
      const context = await browser.newContext({ ...devices["Desktop Chrome"] });
      context.setDefaultTimeout(30000);
      context.setDefaultNavigationTimeout(60000);
      const page = await context.newPage();
      const executor = new ActionExecutor(page, dir);

      let cursor = 0;
      for (const t of resolved) {
        log("");
        log("========================================");
        log(`TEST: ${t.file}`);
        log("========================================");
        log(`Test: ${t.name}`);
        log(`Steps: ${t.steps.length}`);

        let skipRestOfTest = false;

        for (let i = 0; i < t.steps.length; i++) {
          const step = record.steps[cursor];
          cursor++;

          if (aborted || haltSuite || skipRestOfTest) {
            step.status = "skipped";
            broadcast(active, "step", step);
            continue;
          }

          step.status = "running";
          broadcast(active, "step", step);
          log("");
          log(`STEP ${step.index}/${steps.length}`);
          log(`ACTION: ${t.steps[i].action}`);

          const startedAt = Date.now();
          try {
            await executor.execute(t.steps[i]);
            step.durationMs = Date.now() - startedAt;
            step.status = "passed";
            log(`✓ Step ${step.index} Passed`);
          } catch (e) {
            step.durationMs = Date.now() - startedAt;
            step.status = "failed";
            step.error = e instanceof Error ? e.message : String(e);
            anyFailure = true;
            skipRestOfTest = true;
            if (!suite.continueOnFailure) haltSuite = true;
            log(`✗ Step ${step.index} Failed`);
            log(step.error);
          }

          try {
            fs.mkdirSync(dir, { recursive: true });
            await executor.currentPage.screenshot({ path: path.join(dir, `step-${step.index}.png`), fullPage: false });
            step.screenshot = `step-${step.index}.png`;
          } catch {
            // a screenshot failure must never fail the run
          }

          broadcast(active, "step", step);
        }
      }
    } catch (e) {
      anyFailure = true;
      record.error ??= e instanceof Error ? e.message : String(e);
      log(`Suite aborted: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
      clearTimeout(deadline);
    }

    record.status = anyFailure || aborted ? "failed" : "passed";
    record.finishedAt = new Date().toISOString();
    record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
    for (const step of record.steps) {
      if (step.status === "pending" || step.status === "running") step.status = "skipped";
    }

    saveRun(record);
    finalizeRun(record);
    broadcast(active, "done", summary(record));
    for (const res of active.listeners) res.end();
    activeRuns.delete(id);
  }

  return record;
}

// ------------------------------------------------------------
// HTTP API
// ------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.use(securityHeaders);
app.use("/api", sameOrigin);
app.use(express.json({ limit: "5mb" }));
app.use(["/api/auth/setup", "/api/auth/login", "/api/auth/change-password"], authRateLimit());

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// ---- Auth (public where noted; all self-check `requireAuth`) ----

app.get("/api/auth/status", (req, res) => {
  res.json({ needsSetup: !hasAnyUser(), user: currentUser(req) });
});

app.post("/api/auth/setup", (req, res) => {
  if (hasAnyUser()) throw new HttpError(409, "Setup already completed. Log in instead.");
  const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
  const user = createUser(String(body.username ?? ""), String(body.password ?? ""), "site_admin");
  createSession(user.id, res);
  res.status(201).json({ user });
});

app.post("/api/auth/login", (req, res) => {
  const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
  const user = verifyLogin(String(body.username ?? ""), String(body.password ?? ""));
  if (!user) throw new HttpError(401, "Invalid username or password.");
  createSession(user.id, res);
  res.json({ user: toPublicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

app.post("/api/auth/change-password", (req, res) => {
  const user = requireAuth(req);
  const body = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
  const check = verifyLogin(user.username, String(body.currentPassword ?? ""));
  if (!check) throw new HttpError(401, "Current password is incorrect.");
  changePassword(user.id, String(body.newPassword ?? ""));
  createSession(user.id, res);
  res.json({ ok: true });
});

// ---- User management (admin only) ----

// Any signed-in user can list usernames (needed to pick who to share a test
// with); only admins can create or delete accounts (routes below).
app.get("/api/users", (req, res) => {
  requireAuth(req);
  res.json(listUsers());
});

app.post("/api/users", (req, res) => {
  const actor = requireFeature(req, "users.manage");
  const body = (req.body ?? {}) as { username?: unknown; password?: unknown; role?: unknown; features?: unknown };
  const role: Role = normalizeRole(body.role);
  // Only the site admin may mint other admins or site admins.
  if (role !== "member" && actor.role !== "site_admin") {
    throw new HttpError(403, "Only the site admin can create admin accounts.");
  }
  const features = Array.isArray(body.features) ? body.features.map(String) : undefined;
  if (features && actor.role !== "site_admin") {
    throw new HttpError(403, "Only the site admin can set feature access.");
  }
  const user = createUser(String(body.username ?? ""), String(body.password ?? ""), role, features);
  notify(user.username, {
    type: "system",
    title: "Welcome to Test Studio",
    body: `${actor.username} created your account.`
  });
  res.status(201).json(user);
});

// Site admin only: change a user's role and/or feature grants.
app.put("/api/users/:id", (req, res) => {
  const actor = requireSiteAdmin(req);
  const body = (req.body ?? {}) as { role?: unknown; features?: unknown };
  const changes: { role?: Role; features?: string[] | null } = {};
  if (body.role !== undefined) changes.role = normalizeRole(body.role);
  if (body.features === null) changes.features = null;
  else if (Array.isArray(body.features)) changes.features = body.features.map(String);

  const updated = updateUser(req.params.id, changes);
  if (updated.username !== actor.username) {
    notify(updated.username, {
      type: "system",
      title: "Your access changed",
      body: `${actor.username} updated your role or feature access.`
    });
  }
  res.json(updated);
});

app.delete("/api/users/:id", (req, res) => {
  const actor = requireFeature(req, "users.manage");
  if (req.params.id === actor.id) throw new HttpError(400, "You cannot delete your own account.");
  const target = listUsers().find(u => u.id === req.params.id);
  if (target && target.role !== "member" && actor.role !== "site_admin") {
    throw new HttpError(403, "Only the site admin can remove admin accounts.");
  }
  deleteUser(req.params.id);
  res.status(204).end();
});

// The feature catalog, so the site admin UI can render grant checkboxes.
app.get("/api/features", (req, res) => {
  requireAuth(req);
  res.json(FEATURES);
});

// ---- Action catalog ----

app.get("/api/actions", (req, res) => {
  requireAuth(req);
  res.json({ actions: ACTION_CATALOG, fields: FIELD_META });
});

// ---- Folders ----

app.get("/api/folders", (req, res) => {
  requireAuth(req);
  res.json(allFolders());
});

app.post("/api/folders", (req, res) => {
  requireFeature(req, "folders.manage");
  const body = (req.body ?? {}) as { path?: unknown };
  const folder = normalizeFolder(String(body.path ?? ""));
  if (!folder) throw new HttpError(400, "Folder name is required.");
  registerFolder(folder);
  res.status(201).json({ folder });
});

app.delete("/api/folders", (req, res) => {
  requireFeature(req, "folders.manage");
  const folder = normalizeFolder(String(req.query.path ?? ""));
  if (!folder) throw new HttpError(400, "Folder path is required.");

  const meta = loadTestMeta();
  const hasTests = Object.values(meta).some(m => m.folder === folder || m.folder?.startsWith(`${folder}/`));
  if (hasTests) throw new HttpError(409, "Move or delete the tests in this folder first.");

  const stored = loadFolders();
  const hasSubfolders = stored.some(f => f !== folder && f.startsWith(`${folder}/`));
  if (hasSubfolders) throw new HttpError(409, "Delete the subfolders first.");

  saveFolders(stored.filter(f => f !== folder));
  res.status(204).end();
});

// ---- Tests ----

app.get("/api/tests", (req, res) => {
  const user = requireAuth(req);
  fs.mkdirSync(JSON_DIR, { recursive: true });
  const files = fs
    .readdirSync(JSON_DIR)
    .filter(f => f.toLowerCase().endsWith(".json"))
    .sort();
  const runs = listRuns(undefined, "test");

  res.json(
    files
      .map(file => {
        let name = "";
        let stepCount = 0;
        let error: string | undefined;
        try {
          const t = readTest(file);
          name = t.name;
          stepCount = t.steps.length;
        } catch (e) {
          error = (e as Error).message;
        }
        const meta = getTestMeta(file);
        const access = resolveAccess(meta, user);
        const last = runs.find(r => r.file === file && canReadRun(r, user));
        return {
          file,
          name,
          stepCount,
          error,
          running: isRunning("test", file),
          meta,
          access,
          lastRun: last
            ? { id: last.id, status: last.status, startedAt: last.startedAt, durationMs: last.durationMs, startedBy: last.startedBy }
            : null
        };
      })
      .filter(t => t.access !== null)
  );
});

app.get("/api/tests/:file", (req, res) => {
  const user = requireAuth(req);
  const file = safeFile(req.params.file);
  const meta = getTestMeta(file);
  const access = resolveAccess(meta, user);
  if (access === null) throw new HttpError(404, `Test not found: ${file}`);
  res.json({ ...readTest(file), meta, access });
});

app.post("/api/tests", (req, res) => {
  const user = requireFeature(req, "tests.create");
  const body = (req.body ?? {}) as { file?: unknown; name?: unknown; steps?: unknown; folder?: unknown };
  const raw = String(body.file ?? "").trim();
  const file = safeFile(raw.toLowerCase().endsWith(".json") ? raw : `${raw}.json`);
  if (fs.existsSync(testPath(file))) throw new HttpError(409, `${file} already exists`);

  const data = validateTestBody({
    name: body.name ?? file.replace(/\.json$/, ""),
    steps: Array.isArray(body.steps) && body.steps.length
      ? body.steps
      : []
  });
  const folder = typeof body.folder === "string" && body.folder.trim() ? normalizeFolder(body.folder) : undefined;
  writeTest(file, data);
  if (folder) registerFolder(folder);
  const meta = touchTestMeta(file, user.username, true, folder ? { folder } : {});

  res.status(201).json({ ...readTest(file), meta, access: "edit" as Access });
});

app.put("/api/tests/:file", (req, res) => {
  const user = requireFeature(req, "tests.edit");
  const file = safeFile(req.params.file);
  if (!fs.existsSync(testPath(file))) throw new HttpError(404, `Test not found: ${file}`);
  const meta = getTestMeta(file);
  if (resolveAccess(meta, user) !== "edit") throw new HttpError(403, "You only have view access to this test.");
  if (testInUse(file)) throw new HttpError(409, `${file} is in an active run; wait for it to finish before saving`);
  writeTest(file, validateTestBody(req.body));
  const nextMeta = touchTestMeta(file, user.username, false);
  res.json({ ...readTest(file), meta: nextMeta, access: "edit" as Access });
});

app.put("/api/tests/:file/folder", (req, res) => {
  const user = requireFeature(req, "folders.manage");
  const file = safeFile(req.params.file);
  if (!fs.existsSync(testPath(file))) throw new HttpError(404, `Test not found: ${file}`);
  const meta = getTestMeta(file);
  if (resolveAccess(meta, user) !== "edit") throw new HttpError(403, "You only have view access to this test.");

  const body = (req.body ?? {}) as { folder?: unknown };
  const folder = typeof body.folder === "string" && body.folder.trim() ? normalizeFolder(body.folder) : "";
  if (folder) registerFolder(folder);
  const nextMeta = touchTestMeta(file, user.username, false, { folder: folder || undefined });
  res.json({ meta: nextMeta });
});

app.put("/api/tests/:file/sharing", (req, res) => {
  const user = requireAuth(req);
  const file = safeFile(req.params.file);
  if (!fs.existsSync(testPath(file))) throw new HttpError(404, `Test not found: ${file}`);
  const meta = getTestMeta(file);
  if (resolveAccess(meta, user) === null) throw new HttpError(404, `Test not found: ${file}`);
  requireShareAccess(meta, user);

  const body = (req.body ?? {}) as { visibility?: unknown; sharedWith?: unknown };
  const visibility: TestMeta["visibility"] = body.visibility === "restricted" ? "restricted" : "team";

  const known = new Set(listUsers().map(u => u.username));
  const sharedWith: SharedGrant[] = [];
  if (Array.isArray(body.sharedWith)) {
    for (const raw of body.sharedWith) {
      const g = raw as { username?: unknown; permission?: unknown };
      const username = String(g.username ?? "").trim();
      const permission = g.permission === "edit" ? "edit" : "view";
      if (username && known.has(username) && username !== meta.createdBy) {
        sharedWith.push({ username, permission });
      }
    }
  }

  const previous = new Set((meta.sharedWith ?? []).map(g => g.username));
  const nextMeta = touchTestMeta(file, user.username, false, { visibility, sharedWith });
  for (const grant of sharedWith) {
    if (previous.has(grant.username)) continue;
    notify(grant.username, {
      type: "share",
      title: `${user.username} shared a test with you`,
      body: `${file} — you can ${grant.permission === "edit" ? "edit" : "view and run"} it.`,
      link: file
    });
  }
  res.json({ meta: nextMeta });
});

app.delete("/api/tests/:file", (req, res) => {
  const user = requireFeature(req, "tests.delete");
  const file = safeFile(req.params.file);
  if (!fs.existsSync(testPath(file))) throw new HttpError(404, `Test not found: ${file}`);
  requireDeleteAccess(getTestMeta(file), user);
  if (testInUse(file)) throw new HttpError(409, `${file} is in an active run`);
  const references = fs.existsSync(SUITES_DIR) ? fs.readdirSync(SUITES_DIR).filter(f => FILE_RE.test(f) && readSuite(f).tests.includes(file)) : [];
  if (references.length) throw new HttpError(409, "Remove this test from its suites before deleting it.");
  for (const record of listRuns()) {
    if (record.file !== file && !record.steps.some(step => step.testFile === file)) continue;
    record.sourceAccess = { ...record.sourceAccess, [file]: getTestMeta(file) };
    saveRun(record);
  }
  fs.unlinkSync(testPath(file));
  // Retain sharing metadata so deleting a test cannot expose its historical runs.
  res.status(204).end();
});

app.post("/api/tests/:file/run", (req, res) => {
  const user = requireFeature(req, "tests.run");
  const file = safeFile(req.params.file);
  if (resolveAccess(getTestMeta(file), user) === null) throw new HttpError(404, `Test not found: ${file}`);
  res.status(202).json(summary(startRun(file, user.username)));
});

// ---- Suites ----

app.get("/api/suites", (req, res) => {
  const user = requireAuth(req);
  fs.mkdirSync(SUITES_DIR, { recursive: true });
  const files = fs
    .readdirSync(SUITES_DIR)
    .filter(f => f.toLowerCase().endsWith(".json"))
    .sort();
  const runs = listRuns(undefined, "suite");

  res.json(
    files.filter(file => canReadSuite(file, user)).map(file => {
      let name = "";
      let testCount = 0;
      let error: string | undefined;
      try {
        const s = readSuite(file);
        name = s.name;
        testCount = s.tests.length;
      } catch (e) {
        error = (e as Error).message;
      }
      const last = runs.find(r => r.file === file && canReadRun(r, user));
      return {
        file,
        name,
        testCount,
        error,
        running: isRunning("suite", file),
        lastRun: last
          ? { id: last.id, status: last.status, startedAt: last.startedAt, durationMs: last.durationMs, startedBy: last.startedBy }
          : null
      };
    })
  );
});

app.get("/api/suites/:file", (req, res) => {
  const user = requireAuth(req);
  if (!canReadSuite(req.params.file, user)) throw new HttpError(404, "Suite not found");
  res.json(readSuite(req.params.file));
});

app.post("/api/suites", (req, res) => {
  const user = requireFeature(req, "suites.manage");
  const body = (req.body ?? {}) as { file?: unknown; name?: unknown; tests?: unknown };
  const raw = String(body.file ?? "").trim();
  const file = safeFile(raw.toLowerCase().endsWith(".json") ? raw : `${raw}.json`);
  if (fs.existsSync(suitePath(file))) throw new HttpError(409, `${file} already exists`);

  const data = validateSuiteBody({
    name: body.name ?? file.replace(/\.json$/, ""),
    tests: Array.isArray(body.tests) ? body.tests : [],
    continueOnFailure: false
  }, user);
  writeSuite(file, data);
  res.status(201).json(readSuite(file));
});

app.put("/api/suites/:file", (req, res) => {
  const user = requireFeature(req, "suites.manage");
  const file = safeFile(req.params.file);
  if (!canReadSuite(file, user)) throw new HttpError(404, "Suite not found");
  if (!fs.existsSync(suitePath(file))) throw new HttpError(404, `Suite not found: ${file}`);
  if (isRunning("suite", file)) throw new HttpError(409, `${file} is running; wait for it to finish before saving`);
  writeSuite(file, validateSuiteBody(req.body, user));
  res.json(readSuite(file));
});

app.delete("/api/suites/:file", (req, res) => {
  const user = requireFeature(req, "suites.manage");
  const file = safeFile(req.params.file);
  if (!canReadSuite(file, user)) throw new HttpError(404, "Suite not found");
  if (!fs.existsSync(suitePath(file))) throw new HttpError(404, `Suite not found: ${file}`);
  if (isRunning("suite", file)) throw new HttpError(409, `${file} is running`);
  fs.unlinkSync(suitePath(file));
  res.status(204).end();
});

app.post("/api/suites/:file/run", (req, res) => {
  const user = requireFeature(req, "suites.run");
  res.status(202).json(summary(startSuiteRun(req.params.file, user)));
});

// ---- Runs ----

app.get("/api/runs", (req, res) => {
  const user = requireAuth(req);
  const file = typeof req.query.test === "string" ? req.query.test : undefined;
  const kind = req.query.kind === "suite" ? "suite" : req.query.kind === "test" ? "test" : undefined;
  res.json(listRuns(file, kind).filter(rec => canReadRun(rec, user)).map(summary));
});

app.get("/api/runs/:id", (req, res) => {
  const rec = requireRun(req);
  res.json(rec);
});

app.post("/api/runs/:id/stop", (req, res) => {
  const rec = requireRun(req);
  const user = requireFeature(req, rec.kind === "suite" ? "suites.run" : "tests.run");
  if (rec.startedBy !== user.username && !isAdminish(user)) throw new HttpError(403, "Only the run owner or an admin can stop this run.");
  const active = activeRuns.get(req.params.id);
  if (!active) throw new HttpError(404, "Run is not active");
  active.stop();
  res.status(202).json({ stopping: true });
});

app.get("/api/runs/:id/events", (req, res) => {
  const rec = requireRun(req);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  sse(res, "snapshot", rec);

  const active = activeRuns.get(req.params.id);
  if (!active) {
    sse(res, "done", summary(rec));
    res.end();
    return;
  }

  active.listeners.add(res);
  const ping = setInterval(() => {
    const user = currentUser(req);
    if (!user || !canReadRun(rec, user)) { active.listeners.delete(res); res.end(); return; }
    res.write(": ping\n\n");
  }, 15000);
  req.on("close", () => {
    clearInterval(ping);
    active.listeners.delete(res);
  });
});

// ---- Reports ----

app.get("/api/reports/summary", (req, res) => {
  const user = requireFeature(req, "reports.view");
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  res.json(buildReport(
    listRuns().filter(rec => canReadRun(rec, user)) as unknown as RunLike[],
    days,
    new Map(
      Object.entries(loadTestMeta()).filter(([file]) => canReadTest(file, user)).map(([file, meta]) => [file, meta.folder ?? ""])
    ),
    fs.existsSync(JSON_DIR)
      ? fs.readdirSync(JSON_DIR).filter(f => f.toLowerCase().endsWith(".json") && canReadTest(f, user))
      : []
  ));
});

// ---- Notifications ----

app.get("/api/notifications", (req, res) => {
  const user = requireAuth(req);
  res.json({ items: listFor(user.username), unread: unreadCount(user.username) });
});

app.post("/api/notifications/read", (req, res) => {
  const user = requireAuth(req);
  const body = (req.body ?? {}) as { ids?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : undefined;
  markRead(user.username, ids);
  res.json({ unread: unreadCount(user.username) });
});

// ---- Import / export ----

// Accepts a Test Studio export or a Reflect export and writes it as a new test.
app.post("/api/tests/import", (req, res) => {
  const user = requireFeature(req, "tests.create");
  const body = (req.body ?? {}) as { file?: unknown; folder?: unknown; content?: unknown };

  let result: ReturnType<typeof importTest>;
  try { result = importTest(body.content); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Invalid import."); }
  if (!result.steps.length) {
    throw new HttpError(422, "That file produced no runnable steps.");
  }

  const suggested = String(body.file ?? "").trim() || `${result.name || "imported-test"}.json`;
  const cleaned = suggested
    .replace(/\.json$/i, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "imported-test";

  // Never overwrite: find the next free name.
  let file = safeFile(`${cleaned}.json`);
  let n = 2;
  while (fs.existsSync(testPath(file))) {
    file = safeFile(`${cleaned}-${n}.json`);
    n++;
  }

  const data = validateTestBody({
    name: result.name || cleaned,
    description: result.description,
    steps: result.steps
  });
  const folder = typeof body.folder === "string" && body.folder.trim() ? normalizeFolder(body.folder) : undefined;
  writeTest(file, data);
  if (folder) registerFolder(folder);
  const meta = touchTestMeta(file, user.username, true, folder ? { folder } : {});

  res.status(201).json({
    file,
    format: result.format,
    imported: result.steps.length,
    skipped: result.skipped,
    test: { ...readTest(file), meta, access: "edit" as Access }
  });
});

// ---- Recorder ----

app.post("/api/record/start", async (req, res) => {
  const user = requireFeature(req, "tests.create");
  const body = (req.body ?? {}) as { url?: unknown };
  const url = String(body.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new HttpError(400, "Enter a URL starting with http:// or https://");
  }
  try {
    const session = await recorder.start(url, user.username);
    res.status(201).json(session);
  } catch (e) {
    throw new HttpError(500, `Could not open a browser: ${e instanceof Error ? e.message : String(e)}`);
  }
});

app.get("/api/record/:id", (req, res) => {
  const session = requireRecording(req);
  res.json(session);
});

app.post("/api/record/:id/stop", async (req, res) => {
  requireRecording(req);
  const session = await recorder.stop(req.params.id);
  if (!session) throw new HttpError(404, "Recording not found");
  res.json(session);
});

// Live stream of steps as they are recorded.
app.get("/api/record/:id/events", (req, res) => {
  const session = requireRecording(req);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  sse(res, "snapshot", session);

  if (session.status !== "recording") {
    sse(res, "ended", session);
    res.end();
    return;
  }

  const unsubscribe = recorder.subscribe(
    req.params.id,
    step => sse(res, "step", step),
    () => {
      sse(res, "ended", recorder.get(req.params.id) ?? session);
      res.end();
    }
  );
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
});

// Append what was recorded to a test (or replace its steps).
app.post("/api/record/:id/apply", (req, res) => {
  const user = requireFeature(req, "tests.edit");
  const session = requireRecording(req);

  const body = (req.body ?? {}) as { file?: unknown; mode?: unknown; steps?: unknown };
  const file = safeFile(String(body.file ?? ""));
  if (testInUse(file)) throw new HttpError(409, "Wait for the active run to finish before applying recorded steps.");
  if (!fs.existsSync(testPath(file))) throw new HttpError(404, `Test not found: ${file}`);
  const meta = getTestMeta(file);
  if (resolveAccess(meta, user) !== "edit") throw new HttpError(403, "You only have view access to this test.");

  // The UI may send an edited subset; fall back to everything recorded.
  const chosen = Array.isArray(body.steps) && body.steps.length
    ? (body.steps as recorder.RecordedStep[])
    : session.steps;
  const recorded = recorder.toTestSteps(chosen);
  if (!recorded.length) throw new HttpError(400, "Nothing was recorded yet.");

  const existing = readTest(file);
  const steps = body.mode === "replace" ? recorded : [...existing.steps, ...recorded];

  writeTest(file, validateTestBody({ name: existing.name, description: existing.description, steps }));
  const nextMeta = touchTestMeta(file, user.username, false);
  res.json({ added: recorded.length, test: { ...readTest(file), meta: nextMeta, access: "edit" as Access } });
});

// ---- Per-run report, learning, and database status ----

app.get("/api/runs/:id/report", (req, res) => {
  const rec = requireRun(req);
  const user = requireAuth(req);

  const history = listRuns(rec.file, rec.kind ?? "test").filter(run => canReadRun(run, user)) as unknown as LearnRun[];
  res.json({
    report: buildRunReport(rec as unknown as LearnRun),
    insights: rec.insights ?? insightsForRun(rec as unknown as LearnRun, history),
    knowledge: buildKnowledge(rec.file, history)
  });
});

app.get("/api/knowledge/:file", (req, res) => {
  const user = requireAuth(req);
  const file = safeFile(req.params.file);
  const kind = req.query.kind === "suite" ? "suite" : "test";
  if (!(kind === "suite" ? canReadSuite(file, user) : canReadTest(file, user))) throw new HttpError(404, "Subject not found");
  const history = listRuns(file, kind).filter(rec => canReadRun(rec, user)) as unknown as LearnRun[];
  res.json(buildKnowledge(file, history));
});

app.get("/api/db/status", async (req, res) => {
  requireSiteAdmin(req);
  res.json({ ...db.status(), counts: await db.counts() });
});

app.post("/api/db/reconnect", async (req, res) => {
  requireSiteAdmin(req);
  await db.reconnect();
  res.json({ ...db.status(), counts: await db.counts() });
});

// Backfill the database from the run files already on disk.
app.post("/api/db/import", async (req, res) => {
  requireSiteAdmin(req);
  if (!db.isReady()) throw new HttpError(503, "Database is not connected.");
  const runs = listRuns().filter(r => r.status !== "running");
  const imported = await db.importRuns(runs.map(r => ({
    id: r.id, file: r.file, name: r.name, kind: r.kind ?? "test", status: r.status,
    startedAt: r.startedAt, startedBy: r.startedBy, finishedAt: r.finishedAt, durationMs: r.durationMs,
    steps: r.steps.map(s => ({
      index: s.index, action: s.action, status: s.status,
      durationMs: s.durationMs, error: s.error, testFile: s.testFile
    }))
  })));
  res.json({ imported, counts: await db.counts() });
});

// Whole-run AI summary (the per-step analyzer is below).
app.post("/api/runs/:id/summarize", async (req, res) => {
  requireFeature(req, "ai.analyze");
  const rec = requireRun(req);
  if (rec.status === "running") throw new HttpError(400, "Wait for the run to finish.");
  if (!aiConfigured()) {
    throw new HttpError(501, "AI is not configured. Set ANTHROPIC_API_KEY on the server and restart.");
  }

  const history = listRuns(rec.file, rec.kind ?? "test") as unknown as LearnRun[];
  const report = buildRunReport(rec as unknown as LearnRun);
  const knowledge = buildKnowledge(rec.file, history);

  const result = await analyzeRun({
    name: rec.name,
    kind: rec.kind ?? "test",
    status: rec.status,
    durationMs: rec.durationMs,
    counts: report.counts,
    failures: report.failures,
    slowestSteps: report.slowestSteps,
    insights: (rec.insights ?? []).map(i => ({ title: i.title, detail: i.detail })),
    knowledge: {
      finishedRuns: knowledge.finishedRuns,
      passRate: knowledge.passRate,
      flakinessScore: knowledge.flakinessScore,
      medianDurationMs: knowledge.medianDurationMs
    }
  });
  res.json(result);
});

// ---- AI failure analysis ----

app.get("/api/ai/status", (req, res) => {
  requireAuth(req);
  res.json({ configured: aiConfigured() });
});

app.post("/api/runs/:id/steps/:index/analyze", async (req, res) => {
  requireFeature(req, "ai.analyze");
  const rec = requireRun(req);

  const index = Number(req.params.index);
  const step = Number.isInteger(index) ? rec.steps[index - 1] : undefined;
  if (!step) throw new HttpError(404, "Step not found");
  if (step.status !== "failed") throw new HttpError(400, "Only failed steps can be analyzed.");

  if (step.analysis && req.query.force !== "1") {
    res.json(step.analysis);
    return;
  }
  if (!aiConfigured()) {
    throw new HttpError(501, "AI analysis is not configured. Set ANTHROPIC_API_KEY on the server and restart.");
  }

  let stepDef: Record<string, unknown> = { action: step.action };
  try {
    const sourceFile = step.testFile ?? rec.file;
    const localIndex = step.testStepIndex ?? index;
    const test = readJson<TestFile>(path.join(RUNS_DIR, rec.id, "input", safeFile(sourceFile)), { file: sourceFile, name: "", description: "", steps: [] });
    if (test.steps[localIndex - 1]) stepDef = test.steps[localIndex - 1];
  } catch {
    // Test file may have changed or been deleted since the run; fall back to the bare action.
  }

  const screenshotPath = step.screenshot ? path.join(RUNS_DIR, rec.id, step.screenshot) : undefined;

  const result = await analyzeFailure({
    action: step.action,
    step: stepDef,
    error: step.error ?? "",
    screenshotPath
  });

  step.analysis = result;
  saveRun(rec);
  res.json(result);
});

// Static: run screenshots, the Playwright HTML report, ad-hoc screenshots (protected),
// and the UI shell itself (public, so the login page can load).
app.use("/runs/:id", (req, res, next) => {
  const record = requireRun(req);
  // Input snapshots, logs and arbitrary host files are never static assets.
  if (!/^\/step-\d+\.png$/.test(req.path) && !/^\/report(?:\/|$)/.test(req.path)) throw new HttpError(404, "Artifact not found");
  express.static(path.join(RUNS_DIR, record.id), { fallthrough: false })(req, res, next);
});
app.use("/report", (req, _res, next) => { requireAdmin(req); requireFeature(req, "reports.view"); next(); }, express.static(path.join(WORKSPACE, "playwright-report")));
app.use("/screenshots", (req, _res, next) => { requireAdmin(req); next(); }, express.static(path.join(WORKSPACE, "screenshots")));
// no-store: this is a dev tool whose UI changes often; stale cached HTML/JS
// produces confusing "the fix didn't apply" states.
app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: res => res.setHeader("Cache-Control", "no-store")
}));

app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));

app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) { next(err); return; }
  const candidate = (err as { status?: number })?.status;
  const status = err instanceof HttpError || err instanceof ValidationError ? err.status : candidate && candidate >= 400 && candidate < 500 ? candidate : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? "An internal error occurred. Check the server log." : message });
});

const releaseWorkspace = acquireWorkspaceLock(DATA_DIR);
process.once("exit", releaseWorkspace);

// Only the process holding the workspace lock may recover interrupted runs.
for (const record of listRuns()) {
  if (record.status !== "running") continue;
  record.status = "failed";
  record.error = "The server restarted before this run completed.";
  record.finishedAt = new Date().toISOString();
  record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
  for (const step of record.steps) if (step.status === "pending" || step.status === "running") step.status = "skipped";
  saveRun(record);
}

const server = app.listen(PORT, HOST, () => {
  const address = server.address();
  console.log(`MMQA Studio running at http://${HOST}:${typeof address === "object" && address ? address.port : PORT}`);
  // Optional: the app runs fine on file storage if this never connects.
  void db.init();
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const active of activeRuns.values()) active.stop();
  void recorder.stopAll();
  server.close();
  const shutdown = setInterval(() => {
    if (!activeRuns.size) process.exit(0);
  }, 100);
  shutdown.unref();
  setTimeout(() => process.exit(0), 10000).unref();
});
