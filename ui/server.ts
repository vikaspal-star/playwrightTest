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
import crypto from "node:crypto";
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
  listDepartments,
  renameDepartment,
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
import * as screencast from "./agent/screencast";
import { AnalysisResult, analyzeFailure, analyzeRun, analyzeAdaptation, isConfigured as aiConfigured } from "./anthropic";
import * as aiUsage from "./aiUsage";
import { agentTestingRouter } from "./agentTestingRoutes";
import { listRequirements, saveRequirements, newRequirement, requirementInput } from "./requirements";
import { RunDiagnostics, captureOptions, CaptureOptions, Diagnostics } from "../src/runDiagnostics";
import { ROOT, WORKSPACE, JSON_DIR, SUITES_DIR, RUNS_DIR, DATA_DIR, HOST, PORT, MAX_ACTIVE_RUNS, RUN_TIMEOUT_MS } from "./config";
import { readJson, writeJson, acquireWorkspaceLock } from "./storage";
import { validateTest, ValidationError, validateDesign, TestDesign } from "../src/validation";
import * as documents from "./documents";
import { documentRequirementsAI } from "./anthropic";
import { securityHeaders, sameOrigin, authRateLimit } from "./security";
import { addProject, addEnvironment, destination, environmentUrl, projectName, reconcileProjects, saveProjects, adaptationPlan, revision } from "./projects";
import { startLiveScreen } from "../src/liveScreen";

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
  capture?: CaptureOptions;
  projectContext?: { file: string; project: string; environment: string }[];
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
  design?: TestDesign;
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
  projectId?: string;
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

  let parsed: { name?: unknown; description?: unknown; steps?: unknown; design?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    throw new HttpError(422, `Invalid JSON in ${file}`);
  }
  if (!parsed || !Array.isArray(parsed.steps)) throw new HttpError(422, `No "steps" array in ${file}`);

  return {
    file,
    ...(parsed.design !== undefined ? { design: validateDesign(parsed.design) } : {}),
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

/**
 * Test metadata is deliberately retained after a delete so historical runs keep
 * their sharing rules. That retained entry must not go on claiming a place in
 * the folder tree, so anything derived from "where tests live" looks only at
 * metadata whose test still exists.
 */
function liveTestMeta(): TestMeta[] {
  if (!fs.existsSync(JSON_DIR)) return [];
  const onDisk = new Set(fs.readdirSync(JSON_DIR).filter(f => f.toLowerCase().endsWith(".json")));
  return Object.entries(loadTestMeta())
    .filter(([file]) => onDisk.has(file))
    .map(([, meta]) => meta);
}

function allFolders(): string[] {
  const set = new Set(loadFolders());
  for (const meta of liveTestMeta()) {
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

  let parsed: { name?: unknown; description?: unknown; tests?: unknown; continueOnFailure?: unknown; projectId?: unknown };
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
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : undefined,
    tests: (parsed.tests as unknown[]).filter((t): t is string => typeof t === "string")
  };
}

function writeSuite(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(SUITES_DIR, { recursive: true });
  writeJson(suitePath(file), data);
}

function validateSuiteBody(body: unknown, user: PublicUser): Record<string, unknown> {
  if (!body || typeof body !== "object") throw new HttpError(400, "Body must be an object");
  const b = body as { name?: unknown; description?: unknown; tests?: unknown; continueOnFailure?: unknown; projectId?: unknown };
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
  if (b.projectId !== undefined && b.projectId !== "") {
    if (typeof b.projectId !== "string" || !projectStore().projects.some(p => p.id === b.projectId)) throw new HttpError(400, "Choose an existing project for this suite.");
    out.projectId = b.projectId;
  }
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

function runProjectContext(files: string[]) {
  const store = projectStore();
  return files.map(file => { const assignment = store.assignments[file]; const project = store.projects.find(p => p.id === assignment?.projectId); return { file, project: project?.name || "Unassigned", environment: project?.environments.find(e => e.id === assignment?.environmentId)?.name || "Unassigned" }; });
}

function startRun(file: string, startedBy: string, capture: CaptureOptions): RunRecord {
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
    capture, projectContext: runProjectContext([file]),
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
        RUN_CAPTURE: JSON.stringify(capture),
        TEST_JSON_DIR: inputDir,
        PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(dir, "report"),
        FORCE_COLOR: "0",
        PLAYWRIGHT_HTML_OPEN: "never"
      }
    }
  );

  const active: ActiveRun = { record, listeners: new Set(), stop: () => {
    record.error ??= "Run stopped by user.";
    // Let the Playwright worker close its browser even where Windows blocks taskkill.
    fs.writeFileSync(path.join(dir, ".cancel"), "stop", { mode: 0o600 });
    setTimeout(() => {
    if (proc.exitCode !== null) return;
    if (process.platform === "win32" && proc.pid) {
      const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => proc.kill());
      killer.on("exit", code => { if (code !== 0) proc.kill(); });
    } else if (proc.pid) {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    }
    }, 5000).unref();
  } };
  activeRuns.set(id, active);

  const handleLine = (line: string): void => {
    if (line.startsWith("@@FRAME ")) {
      try { broadcast(active, "frame", JSON.parse(line.slice(8))); } catch { /* incomplete frame */ }
      return;
    }
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

function startSuiteRun(file: string, user: PublicUser, capture: CaptureOptions): RunRecord {
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
    capture, projectContext: runProjectContext(suite.tests),
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
    let context: import("playwright").BrowserContext | undefined;
    let diagnostics: RunDiagnostics | undefined;

    try {
      browser = await chromium.launch({ headless: true });
      closeBrowser = () => browser!.close();
      if (aborted) throw new Error(record.error || "Suite stopped.");
      context = await browser.newContext({ ...devices["Desktop Chrome"], ...(capture.video ? { recordVideo: { dir: path.join(dir, "media"), size: { width: 1280, height: 720 } } } : {}) });
      diagnostics = new RunDiagnostics(context, dir, capture);
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
          diagnostics.beginStep(step.index);
          broadcast(active, "step", step);
          log("");
          log(`STEP ${step.index}/${steps.length}`);
          log(`ACTION: ${t.steps[i].action}`);

          const startedAt = Date.now();
          const stopScreen = startLiveScreen(() => executor.currentPage, frame => broadcast(active, "frame", { ...frame, index: step.index }));
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
          } finally { await stopScreen(); await diagnostics.afterStep(executor.currentPage); }

          try {
            fs.mkdirSync(dir, { recursive: true });
            await executor.currentPage.screenshot({ path: path.join(dir, `step-${step.index}.png`), fullPage: false });
            step.screenshot = `step-${step.index}.png`;
          } catch {
            // a screenshot failure must never fail the run
          }

          broadcast(active, "step", step);
        }
        if (!aborted && record.steps.some(step => step.testFile === t.file && ["passed", "failed"].includes(step.status))) await diagnostics.audit(executor.currentPage, t.file);
      }
    } catch (e) {
      anyFailure = true;
      record.error ??= e instanceof Error ? e.message : String(e);
      log(`Suite aborted: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      diagnostics?.finish();
      if (context) await context.close().catch(() => {});
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
app.use("/api/agent-tests", agentTestingRouter(requireFeature));
app.use(["/api/auth/setup", "/api/auth/login", "/api/auth/change-password"], authRateLimit());

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// ---- Auth (public where noted; all self-check `requireAuth`) ----

app.get("/api/auth/status", (req, res) => {
  res.json({ needsSetup: !hasAnyUser(), user: currentUser(req) });
});

app.post("/api/auth/setup", (req, res) => {
  if (hasAnyUser()) throw new HttpError(409, "Setup already completed. Log in instead.");
  const body = (req.body ?? {}) as { username?: unknown; password?: unknown; department?: unknown };
  const user = createUser(
    String(body.username ?? ""),
    String(body.password ?? ""),
    "site_admin",
    undefined,
    typeof body.department === "string" ? body.department : undefined
  );
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
  const body = (req.body ?? {}) as { username?: unknown; password?: unknown; role?: unknown; features?: unknown; department?: unknown };
  const role: Role = normalizeRole(body.role);
  // Only the site admin may mint other admins or site admins.
  if (role !== "member" && actor.role !== "site_admin") {
    throw new HttpError(403, "Only the site admin can create admin accounts.");
  }
  const features = Array.isArray(body.features) ? body.features.map(String) : undefined;
  if (features && actor.role !== "site_admin") {
    throw new HttpError(403, "Only the site admin can set feature access.");
  }
  const user = createUser(
    String(body.username ?? ""),
    String(body.password ?? ""),
    role,
    features,
    typeof body.department === "string" ? body.department : undefined
  );
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
  const body = (req.body ?? {}) as { role?: unknown; features?: unknown; department?: unknown };
  const changes: { role?: Role; features?: string[] | null; department?: string | null } = {};
  // An empty string clears the department; omitting the field leaves it alone.
  if (body.department === null || body.department === "") changes.department = null;
  else if (typeof body.department === "string") changes.department = body.department;
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

// Departments already in use, so the UI can offer them instead of inviting a
// new spelling of an existing team.
app.get("/api/departments", (req, res) => {
  requireAuth(req);
  res.json(listDepartments());
});

// Rename a department everywhere it is used, or clear it by sending an empty
// name. Site admin only: it edits other people's accounts.
app.put("/api/departments", (req, res) => {
  requireSiteAdmin(req);
  const body = (req.body ?? {}) as { from?: unknown; to?: unknown };
  const to = typeof body.to === "string" && body.to.trim() ? String(body.to) : null;
  const moved = renameDepartment(String(body.from ?? ""), to);
  res.json({ moved, departments: listDepartments() });
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

// ---- Projects and environments ----
function projectStore() {
  const tests = fs.existsSync(JSON_DIR) ? fs.readdirSync(JSON_DIR).filter(file => FILE_RE.test(file)).map(file => {
    let steps: Record<string, unknown>[] = [];
    try { steps = readTest(file).steps; } catch { /* Preserve invalid legacy tests for editing. */ }
    return { file, folder: getTestMeta(file).folder, steps };
  }) : [];
  return reconcileProjects(tests, allFolders());
}

app.get("/api/projects", (req, res) => {
  const user = requireAuth(req);
  const store = projectStore();
  res.json({ ...store, assignments: Object.fromEntries(Object.entries(store.assignments).filter(([file]) => fs.existsSync(testPath(file)) && resolveAccess(getTestMeta(file), user) !== null)) });
});

// Requirements are shared project records. Test links always respect test access.
app.get("/api/projects/:id/requirements", (req, res) => {
  const user = requireAuth(req);
  const store = projectStore();
  if (!store.projects.some(p => p.id === req.params.id)) throw new HttpError(404, "Project not found.");
  const records = listRequirements().filter(r => r.projectId === req.params.id).map(r => ({ ...r, tests: r.tests.filter(file => canReadTest(file, user) && store.assignments[file]?.projectId === r.projectId) }));
  res.json(records);
});
app.post("/api/projects/:id/requirements", (req, res) => {
  const user = requireFeature(req, "folders.manage");
  const store = projectStore();
  if (!store.projects.some(p => p.id === req.params.id)) throw new HttpError(404, "Project not found.");
  const row = newRequirement(String(req.params.id), req.body, user.username);
  if (row.tests.some(file => !canReadTest(file, user) || store.assignments[file]?.projectId !== row.projectId)) throw new HttpError(400, "Link only available tests in this project.");
  const records = listRequirements();
  if (records.filter(r => r.projectId === row.projectId).length >= 1000) throw new HttpError(409, "This project has reached its 1,000 requirement limit.");
  records.push(row); saveRequirements(records); res.status(201).json(row);
});
app.put("/api/projects/:id/requirements/:requirementId", (req, res) => {
  const user = requireFeature(req, "folders.manage");
  const store = projectStore(), records = listRequirements();
  if (!store.projects.some(p => p.id === req.params.id)) throw new HttpError(404, "Project not found.");
  const row = records.find(r => r.projectId === req.params.id && r.id === req.params.requirementId);
  if (!row) throw new HttpError(404, "Requirement not found.");
  if (req.body?.revision !== row.revision) throw new HttpError(409, "This requirement changed. Reopen it before saving.");
  const input = requirementInput(req.body);
  if (input.tests.some(file => !canReadTest(file, user) || store.assignments[file]?.projectId !== row.projectId)) throw new HttpError(400, "Link only available tests in this project.");
  // Preserve links hidden from this editor; editing visible links must not revoke others.
  const hidden = row.tests.filter(file => !canReadTest(file, user) && store.assignments[file]?.projectId === row.projectId);
  const next = { ...newRequirement(row.projectId, input, user.username), id: row.id, source: row.source, design: row.design, tests: [...new Set([...hidden, ...input.tests])] };
  saveRequirements(records.map(r => r.id === row.id ? next : r));
  res.json({ ...next, tests: input.tests });
});
app.delete("/api/projects/:id/requirements/:requirementId", (req, res) => {
  requireFeature(req, "folders.manage");
  const records = listRequirements();
  const row = records.find(r => r.projectId === req.params.id && r.id === req.params.requirementId);
  if (!row) throw new HttpError(404, "Requirement not found.");
  if (req.body?.revision !== row.revision) throw new HttpError(409, "This requirement changed. Reopen it before deleting.");
  saveRequirements(records.filter(r => r.id !== row.id)); res.status(204).end();
});
function documentProject(req: Request, write = false) {
  const user = write ? requireFeature(req, "folders.manage") : requireAuth(req);
  const project = projectStore().projects.find(p => p.id === req.params.id);
  if (!project) throw new HttpError(404, "Project not found.");
  return { user, project };
}
function documentView(document: documents.ProjectDocument, full = false) {
  const imported = listRequirements().filter(row => row.projectId === document.projectId && row.source?.documentId === document.id);
  const { text, candidates, ...summary } = document;
  return { ...summary, characters: text.length, candidateCount: candidates.length, importedCandidateIds: imported.map(row => row.source!.candidateId), importedCount: imported.length, aiAvailable: aiConfigured(), ...(full ? { text, candidates } : {}) };
}
app.get("/api/projects/:id/documents", (req, res) => {
  const { project } = documentProject(req);
  res.json(documents.listDocuments(project.id).map(document => documentView(document)));
});
app.post("/api/projects/:id/documents", async (req, res) => {
  const { project } = documentProject(req, true);
  const parsed = await documents.parseUpload(req.body?.name, req.body?.content);
  const { user } = documentProject(req, true);
  const all = documents.listDocuments(project.id);
  const existing = all.find(document => document.hash === parsed.hash);
  if (existing) { res.json(documentView(existing, true)); return; }
  if (all.length >= 100) throw new HttpError(409, "This project has 100 documents. Remove an old source before uploading another.");
  const document: documents.ProjectDocument = { ...parsed, id: crypto.randomUUID(), projectId: project.id, revision: crypto.randomUUID(), uploadedBy: user.username, uploadedAt: new Date().toISOString(), method: "sections", candidates: documents.sectionCandidates(parsed.text) };
  documents.saveDocument(document); res.status(201).json(documentView(document, true));
});
app.get("/api/projects/:id/documents/:documentId", (req, res) => {
  const { project } = documentProject(req);
  res.json(documentView(documents.getDocument(project.id, String(req.params.documentId)), true));
});
app.delete("/api/projects/:id/documents/:documentId", (req, res) => {
  const { project } = documentProject(req, true), document = documents.getDocument(project.id, String(req.params.documentId));
  if (req.body?.revision !== document.revision) throw new HttpError(409, "Reopen the document before removing it.");
  documents.deleteDocument(project.id, document.id); res.status(204).end();
});
app.post("/api/projects/:id/documents/:documentId/generate", async (req, res) => {
  const { project, user } = documentProject(req, true); requireFeature(req, "ai.analyze");
  const document = documents.getDocument(project.id, String(req.params.documentId));
  if (document.revision !== req.body?.revision) throw new HttpError(409, "Reopen the document before generating a draft.");
  if (!aiConfigured()) throw new HttpError(503, "Configure the AI provider to use AI extraction. Reviewing document sections works without AI.");
  if (document.text.length > 24000) throw new HttpError(400, "AI extraction supports up to 24,000 characters. Split this document or review its sections without AI.");
  if (documentView(document).importedCount) throw new HttpError(409, "Requirements have already been saved from this document. Edit those requirements directly.");
  const raw = await documentRequirementsAI(document.text, user.username, document.id);
  documentProject(req, true); requireFeature(req, "ai.analyze");
  const current = documents.getDocument(project.id, document.id);
  if (current.revision !== document.revision || documentView(current).importedCount) throw new HttpError(409, "The document changed during AI extraction. Reopen it.");
  const next = { ...document, candidates: documents.validateCandidates(raw, document, true), method: "ai" as const, revision: crypto.randomUUID() };
  documents.saveDocument(next); res.json(documentView(next, true));
});
app.post("/api/projects/:id/documents/:documentId/import", (req, res) => {
  const { project, user } = documentProject(req, true), document = documents.getDocument(project.id, String(req.params.documentId));
  if (req.body?.revision !== document.revision) throw new HttpError(409, "The document draft changed. Reopen it before saving requirements.");
  const selected = documents.validateCandidates(req.body?.candidates, document);
  const records = listRequirements();
  const existing = records.filter(row => row.projectId === project.id && row.source?.documentId === document.id);
  const fresh = selected.filter(candidate => !existing.some(row => row.source!.candidateId === candidate.id));
  if (records.filter(row => row.projectId === project.id).length + fresh.length > 1000) throw new HttpError(409, "This project would exceed 1,000 requirements.");
  const created = fresh.map(candidate => ({ ...newRequirement(project.id, { title: candidate.title, description: candidate.description, status: "draft", tests: [] }, user.username), source: { documentId: document.id, candidateId: candidate.id, name: document.name, quote: candidate.quote }, design: candidate.design }));
  saveRequirements([...records, ...created]);
  res.status(created.length ? 201 : 200).json({ created: created.length, requirementIds: [...existing.filter(row => selected.some(c => c.id === row.source!.candidateId)), ...created].map(row => row.id) });
});
app.post("/api/projects/:id/requirements/:requirementId/test-draft", (req, res) => {
  const { project, user } = documentProject(req, true); requireFeature(req, "tests.create");
  const records = listRequirements(), row = records.find(r => r.projectId === project.id && r.id === req.params.requirementId);
  if (!row) throw new HttpError(404, "Requirement not found.");
  const file = safeFile(`requirement-${row.id}.json`);
  if (fs.existsSync(testPath(file))) {
    const test = readTest(file);
    if (test.design?.requirementId !== row.id || !canReadTest(file, user) || projectStore().assignments[file]?.projectId !== project.id) throw new HttpError(409, "The generated test already exists in another location or has restricted access.");
    if (!row.tests.includes(file)) { if (row.tests.length >= 200) throw new HttpError(409, "Requirement test-link limit reached."); row.tests.push(file); row.revision = crypto.randomUUID(); saveRequirements(records); }
    res.json({ file }); return;
  }
  if (req.body?.revision !== row.revision) throw new HttpError(409, "The requirement changed. Reopen it before creating a test draft.");
  if (row.tests.length >= 200) throw new HttpError(409, "Requirement test-link limit reached.");
  const store = projectStore();
  let target;
  try { target = destination(store, project.id, req.body?.environmentId); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  const design = { ...validateDesign(req.body?.design || row.design || documents.draftDesign(row.title, row.description)), requirementId: row.id };
  const data = validateTestBody({ name: row.title, description: row.description, design, steps: [] });
  const oldStore = structuredClone(store), oldRecords = structuredClone(records), oldMeta = loadTestMeta(), nextMeta = structuredClone(oldMeta), now = new Date().toISOString();
  store.assignments[file] = { projectId: project.id, environmentId: target.environment.id };
  nextMeta[file] = { createdBy: user.username, createdAt: now, updatedBy: user.username, updatedAt: now };
  row.tests.push(file); row.revision = crypto.randomUUID(); row.updatedAt = now; row.updatedBy = user.username;
  try { writeTest(file, data); saveTestMeta(nextMeta); saveProjects(store); saveRequirements(records); }
  catch (error) { if (fs.existsSync(testPath(file))) fs.unlinkSync(testPath(file)); saveTestMeta(oldMeta); saveProjects(oldStore); saveRequirements(oldRecords); throw error; }
  res.status(201).json({ file });
});

app.post("/api/projects", (req, res) => {
  requireFeature(req, "folders.manage");
  const store = projectStore();
  try {
    const project = addProject(store, req.body?.name);
    if (req.body?.environment) addEnvironment(project, req.body.environment);
    saveProjects(store);
    res.status(201).json(project);
  } catch (error) { throw new HttpError(400, (error as Error).message); }
});
app.post("/api/projects/:id/environments", (req, res) => {
  requireFeature(req, "folders.manage");
  const store = projectStore();
  const project = store.projects.find(p => p.id === req.params.id);
  if (!project) throw new HttpError(404, "Project not found.");
  try { const environment = addEnvironment(project, req.body || {}); saveProjects(store); res.status(201).json(environment); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
});
app.put("/api/projects/:id/environments/:environmentId", (req, res) => {
  requireFeature(req, "folders.manage");
  const store = projectStore();
  try {
    const { project, environment } = destination(store, req.params.id, req.params.environmentId);
    const name = projectName(req.body?.name);
    if (project.environments.some(e => e.id !== environment.id && e.name.toLowerCase() === name.toLowerCase())) throw new Error("This environment name already exists.");
    if (!["sandbox", "production"].includes(req.body?.type)) throw new Error("Choose Sandbox or Production.");
    Object.assign(environment, { name, type: req.body.type, url: environmentUrl(req.body.url) });
    saveProjects(store);
    res.json(environment);
  } catch (error) { throw new HttpError(400, (error as Error).message); }
});

function moveContext(req: Request) {
  const user = requireFeature(req, "folders.manage");
  requireFeature(req, "tests.edit");
  const file = safeFile(String(req.params.file));
  if (!fs.existsSync(testPath(file)) || resolveAccess(getTestMeta(file), user) === null) throw new HttpError(404, "Test not found.");
  if (resolveAccess(getTestMeta(file), user) !== "edit") throw new HttpError(403, "You only have view access to this test.");
  if (testInUse(file)) throw new HttpError(409, "Wait for the active run to finish before moving this test.");
  const store = projectStore();
  let target;
  try { target = destination(store, req.body?.projectId, req.body?.environmentId); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  const assignment = store.assignments[file];
  const source = store.projects.find(p => p.id === assignment?.projectId)?.environments.find(e => e.id === assignment?.environmentId);
  const test = readTest(file);
  const plan = adaptationPlan(test.steps, source?.url || "", target.environment);
  const token = revision({ test, meta: getTestMeta(file), assignment, source, target });
  return { user, file, store, test, target, plan, token };
}
app.post("/api/tests/:file/move-preview", (req, res) => {
  const { target, plan, token } = moveContext(req);
  res.json({ project: target.project.name, environment: target.environment, changes: plan.changes, review: plan.review, revision: token, aiAvailable: aiConfigured() });
});
app.post("/api/tests/:file/move-analysis", async (req, res) => {
  requireFeature(req, "ai.analyze");
  const context = moveContext(req);
  if (context.token !== req.body?.revision) throw new HttpError(409, "Refresh the move preview before requesting AI analysis.");
  if (!aiConfigured()) throw new HttpError(503, "Configure the AI provider on the server to request an AI review. URL adaptation remains available.");
  const assignment = context.store.assignments[context.file];
  const sourceType = context.store.projects.find(p => p.id === assignment?.projectId)?.environments.find(e => e.id === assignment?.environmentId)?.type || "unknown";
  let advice: string;
  try {
    advice = await analyzeAdaptation({ sourceType, targetType: context.target.environment.type, actions: context.test.steps.map(step => String(step.action)).filter(action => ACTION_CATALOG.some(spec => spec.action === action)), urlChanges: context.plan.changes.length, selectors: context.test.steps.filter(step => step.selector).length, inputSteps: context.test.steps.filter(step => step.value !== undefined).length });
  } catch (error) { throw new HttpError(502, (error as Error).message); }
  if (moveContext(req).token !== context.token) throw new HttpError(409, "The test or environment changed during analysis. Refresh the preview.");
  res.json({ advice, revision: context.token });
});
app.post("/api/tests/:file/move", (req, res) => {
  const { user, file, store, test, target, plan, token } = moveContext(req);
  if (req.body?.revision !== token) throw new HttpError(409, "The test or environment changed. Refresh the preview before moving.");
  const oldAssignment = store.assignments[file];
  const updated = req.body?.adaptUrls === true ? validateTestBody({ ...test, steps: plan.nextSteps }) : test;
  // A recovery copy is retained before modifying either the test or its assignment.
  const backup = path.join(DATA_DIR, "project-moves", `${Date.now()}-${token.slice(0, 12)}.json`);
  writeJson(backup, { file, test, assignment: oldAssignment, target: { projectId: target.project.id, environmentId: target.environment.id }, by: user.username });
  writeTest(file, { ...updated });
  try {
    store.assignments[file] = { projectId: target.project.id, environmentId: target.environment.id };
    saveProjects(store);
  } catch (error) { writeTest(file, { ...test }); throw error; }
  const meta = touchTestMeta(file, user.username, false);
  res.json({ ...readTest(file), meta, access: "edit", changes: req.body?.adaptUrls === true ? plan.changes.length : 0 });
});

// Legacy folder APIs remain compatible with existing integrations and imports.

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

  // Only tests that still exist can hold a folder open; retained metadata from
  // deleted tests would otherwise make the folder impossible to remove.
  const hasTests = liveTestMeta().some(m => m.folder === folder || m.folder?.startsWith(`${folder}/`));
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
  const body = (req.body ?? {}) as { file?: unknown; name?: unknown; steps?: unknown; folder?: unknown; projectId?: unknown; environmentId?: unknown };
  const raw = String(body.file ?? "").trim();
  const stem = String(body.name || "New test").replace(/\.json$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90).toLowerCase() || "new-test";
  let file = raw ? safeFile(raw.toLowerCase().endsWith(".json") ? raw : `${raw}.json`) : `${stem}.json`;
  let suffix = 2;
  while (!raw && fs.existsSync(testPath(file))) file = `${stem}-${suffix++}.json`;
  if (fs.existsSync(testPath(file))) throw new HttpError(409, `${file} already exists`);

  const store = projectStore();
  let target;
  if (body.projectId || body.environmentId) {
    try { target = destination(store, body.projectId, body.environmentId); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
  }

  const data = validateTestBody({
    name: body.name ?? file.replace(/\.json$/, ""),
    steps: Array.isArray(body.steps) && body.steps.length
      ? body.steps
      : target?.environment.url ? [{ action: "navigate", url: target.environment.url }] : []
  });
  const folder = typeof body.folder === "string" && body.folder.trim() ? normalizeFolder(body.folder) : undefined;
  writeTest(file, data);
  if (folder) registerFolder(folder);
  const meta = touchTestMeta(file, user.username, true, folder ? { folder } : {});
  delete store.assignments[file];
  if (target) store.assignments[file] = { projectId: target.project.id, environmentId: target.environment.id };
  saveProjects(store);

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
  const requirements = listRequirements();
  if (requirements.some(r => r.tests.includes(file))) saveRequirements(requirements.map(r => r.tests.includes(file) ? { ...newRequirement(r.projectId, { ...r, tests: r.tests.filter(test => test !== file) }, user.username), id: r.id, source: r.source, design: r.design } : r));
  // Retain sharing metadata so deleting a test cannot expose its historical runs.
  res.status(204).end();
});

app.post("/api/tests/:file/run", (req, res) => {
  const user = requireFeature(req, "tests.run");
  const file = safeFile(req.params.file);
  if (resolveAccess(getTestMeta(file), user) === null) throw new HttpError(404, `Test not found: ${file}`);
  res.status(202).json(summary(startRun(file, user.username, captureOptions(req.body?.capture))));
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
  const store = projectStore();

  res.json(
    files.filter(file => canReadSuite(file, user)).map(file => {
      let name = "";
      let testCount = 0;
      let projectIds: string[] = [];
      let error: string | undefined;
      try {
        const s = readSuite(file);
        name = s.name;
        testCount = s.tests.length;
        projectIds = [...new Set([s.projectId, ...s.tests.map(test => store.assignments[test]?.projectId)].filter((id): id is string => Boolean(id)))];
      } catch (e) {
        error = (e as Error).message;
      }
      const last = runs.find(r => r.file === file && canReadRun(r, user));
      return {
        file,
        name,
        testCount,
        projectIds,
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
  const body = (req.body ?? {}) as { file?: unknown; name?: unknown; tests?: unknown; projectId?: unknown };
  const raw = String(body.file ?? "").trim();
  const file = safeFile(raw.toLowerCase().endsWith(".json") ? raw : `${raw}.json`);
  if (fs.existsSync(suitePath(file))) throw new HttpError(409, `${file} already exists`);

  const data = validateSuiteBody({
    name: body.name ?? file.replace(/\.json$/, ""),
    tests: Array.isArray(body.tests) ? body.tests : [],
    projectId: body.projectId,
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
  res.status(202).json(summary(startSuiteRun(req.params.file, user, captureOptions(req.body?.capture))));
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

app.get("/api/runs/:id/evidence", (req, res) => {
  const run = requireRun(req);
  const dir = path.join(RUNS_DIR, run.id);
  const diagnosticPath = path.join(dir, "diagnostics.json");
  const diagnostics = fs.existsSync(diagnosticPath) ? readJson<Diagnostics | null>(diagnosticPath, null) : null;
  const media = path.join(dir, "media");
  const videos = run.status !== "running" && fs.existsSync(media) ? fs.readdirSync(media).filter(file => /^(?:page@)?[a-f0-9-]+\.webm$/.test(file) && diagnostics?.videos?.includes(`media/${file}`)).slice(0, 20).map(file => `media/${file}`) : [];
  // Do not export sharing grants or input snapshots (which can contain passwords).
  const { sourceAccess: _access, ...publicRun } = run;
  const evidence = { run: publicRun, diagnostics, videos };
  if (req.query.download === "1") res.attachment(`mmqa-${run.id}.json`);
  res.json(evidence);
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
  const projects = projectStore();
  res.json(buildReport(
    listRuns().filter(rec => canReadRun(rec, user)) as unknown as RunLike[],
    days,
    new Map(
      Object.entries(projects.assignments).filter(([file]) => canReadTest(file, user)).map(([file, assignment]) => [file, projects.projects.find(project => project.id === assignment.projectId)?.name || ""])
    ),
    new Map(listUsers().flatMap(u => (u.department ? [[u.username, u.department] as [string, string]] : []))),
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
  const body = (req.body ?? {}) as { file?: unknown; folder?: unknown; content?: unknown; projectId?: unknown; environmentId?: unknown };
  const store = projectStore();
  let target;
  if (body.projectId || body.environmentId) {
    try { target = destination(store, body.projectId, body.environmentId); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
  }

  let result: ReturnType<typeof importTest>;
  try { result = importTest(body.content); } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Invalid import."); }
  if (!result.steps.length && !result.design) {
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
    design: result.design,
    steps: result.steps
  });
  const folder = typeof body.folder === "string" && body.folder.trim() ? normalizeFolder(body.folder) : undefined;
  writeTest(file, data);
  if (folder) registerFolder(folder);
  const meta = touchTestMeta(file, user.username, true, folder ? { folder } : {});
  delete store.assignments[file];
  if (target) store.assignments[file] = { projectId: target.project.id, environmentId: target.environment.id };
  saveProjects(store);
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
  const body = (req.body ?? {}) as { url?: unknown; embedded?: unknown };
  const url = String(body.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new HttpError(400, "Enter a URL starting with http:// or https://");
  }
  try {
    const session = await recorder.start(url, user.username, { embedded: body.embedded !== false });
    res.status(201).json(session);
  } catch (e) {
    throw new HttpError(500, `Could not open a browser: ${e instanceof Error ? e.message : String(e)}`);
  }
});

app.get("/api/record/:id", (req, res) => {
  const session = requireRecording(req);
  res.json(session);
});

app.get("/api/record/:id/screen", async (req, res) => {
  const session = requireRecording(req);
  if (session.startedBy !== requireAuth(req).username) throw new HttpError(404, "Recording not found.");
  res.setHeader("Cache-Control", "no-store");
  if (session.status !== "recording") throw new HttpError(409, "The recording has stopped.");
  try { res.json(await recorder.screen(session.id)); }
  catch { throw new HttpError(409, "Screen is changing. Try again in a moment."); }
});
async function recordingInput(req: Request, res: Response, normalized = false) {
  const session = requireRecording(req);
  requireFeature(req, "tests.create");
  if (session.startedBy !== requireAuth(req).username) throw new HttpError(404, "Recording not found.");
  const raw = req.body || {};
  const body = normalized ? { ...raw, type: ({ scroll: "wheel", type: "text" } as Record<string, string>)[raw.kind] || raw.kind, normalized: true } : { ...raw, normalized: false };
  const numberIn = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  const coordinates = numberIn(body.x, 0, normalized ? 1 : 1279) && numberIn(body.y, 0, normalized ? 1 : 799);
  const valid = body.type === "click" ? coordinates && (body.button === undefined || ["left", "right"].includes(body.button)) && (body.clickCount === undefined || [1, 2].includes(body.clickCount))
    : body.type === "move" ? coordinates
    : body.type === "wheel" ? numberIn(body.deltaY, -2000, 2000) && ((body.x === undefined && body.y === undefined) || coordinates)
    : body.type === "key" ? typeof body.key === "string" && /^(?:(?:Control|Meta|Shift|Alt)\+)*(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/.test(body.key)
    : body.type === "text" ? typeof body.text === "string" && body.text.length <= 4000
    : body.type === "navigate" ? typeof body.url === "string" && body.url.length <= 2048 && /^https?:\/\//i.test(body.url)
    : body.type === "blur" || body.type === "screenshot";
  if (!valid) throw new HttpError(400, "Invalid browser input.");
  try { await recorder.input(session.id, body); res.status(204).end(); }
  catch { throw new HttpError(409, "The browser could not complete this interaction. Check the screen and try again."); }
}
app.post("/api/record/:id/input", (req, res) => recordingInput(req, res));
app.post("/api/screen/:id/interact", (req, res) => recordingInput(req, res, true));

// Preserve the screen API while restricting frames to the recording owner.
app.get("/api/screen/:id/events", (req, res) => {
  const session = requireRecording(req);
  if (session.startedBy !== requireAuth(req).username) throw new HttpError(404, "Recording not found.");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  res.write(": connected\n\n");
  const clearFrames = streamScreenFrames(session.id, res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { clearFrames(); clearInterval(ping); });
});

function streamScreenFrames(id: string, res: Response) {
  let sentAt = 0;
  const timer = setInterval(() => {
    if (recorder.get(id)?.status !== "recording") { clearInterval(timer); return; }
    const frame = screencast.latest(id);
    if (frame && frame.at !== sentAt && !res.writableNeedDrain && !res.destroyed) {
      sentAt = frame.at;
      sse(res, "frame", { ...frame, image: frame.data, url: recorder.currentUrl(id) });
    }
  }, 120);
  return () => clearInterval(timer);
}

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
  const clearFrames = streamScreenFrames(session.id, res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
    clearFrames();
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
    username: requireAuth(req).username,
    subject: rec.id,
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

// What the AI features have cost. Token counts come from the provider's own
// usage block rather than an estimate, priced with the configured rates.
app.get("/api/ai/usage", (req, res) => {
  const user = requireAuth(req);
  const username = user.role === "site_admin" ? undefined : user.username;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  res.json({ summary: aiUsage.summary(days, username), recent: aiUsage.recent(25, username).map(({ subject: _subject, error: _error, ...row }) => row), scope: username === undefined ? "workspace" : "personal", configured: aiConfigured(), retainedRecordLimit: 2000 });
});

app.get("/api/overview/counts", (req, res) => {
  requireAuth(req);
  res.json({ projects: projectStore().projects.length, users: listUsers().length });
});

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
    username: requireAuth(req).username,
    subject: `${rec.id}#${index}`,
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
  if (!/^\/step-\d+\.png$/.test(req.path) && !/^\/media\/(?:page(?:@|%40))?[a-f0-9-]+\.webm$/.test(req.path) && !/^\/report(?:\/|$)/.test(req.path)) throw new HttpError(404, "Artifact not found");
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
  console.log(`Maya Studio running at http://${HOST}:${typeof address === "object" && address ? address.port : PORT}`);
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
