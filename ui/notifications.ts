// ============================================================
// NOTIFICATIONS
// ------------------------------------------------------------
// Per-user in-app notifications, stored in ./ui/data/notifications.json.
// Written when a run finishes and when a test is shared with someone;
// read by the bell in the sidebar.
// ============================================================

import crypto from "crypto";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "notifications.json");
const MAX_STORED = 500;

export type NotificationType = "run" | "share" | "system";

export interface Notification {
  id: string;
  username: string;
  type: NotificationType;
  title: string;
  body: string;
  /** UI hash to open when clicked, e.g. "main.json" or "suite:smoke.json". */
  link?: string;
  createdAt: string;
  readAt?: string;
}

function load(): Notification[] {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8")) as Notification[];
  } catch {
    return [];
  }
}

function save(items: Notification[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(items.slice(0, MAX_STORED), null, 2));
}

export function notify(
  username: string,
  entry: { type: NotificationType; title: string; body: string; link?: string }
): void {
  if (!username) return;
  const items = load();
  items.unshift({
    id: crypto.randomBytes(8).toString("hex"),
    username,
    createdAt: new Date().toISOString(),
    ...entry
  });
  save(items);
}

export function listFor(username: string, limit = 50): Notification[] {
  return load().filter(n => n.username === username).slice(0, limit);
}

export function unreadCount(username: string): number {
  return load().filter(n => n.username === username && !n.readAt).length;
}

export function markRead(username: string, ids?: string[]): void {
  const items = load();
  const now = new Date().toISOString();
  for (const n of items) {
    if (n.username !== username || n.readAt) continue;
    if (!ids || ids.includes(n.id)) n.readAt = now;
  }
  save(items);
}
