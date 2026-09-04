// ============================================================
// DATABASE (optional)
// ------------------------------------------------------------
// Postgres-backed storage for run history and the learning signals
// built from it. Start it with `docker compose up -d`.
//
// This module is deliberately OPTIONAL. Test Studio keeps every run
// as JSON under ./runs, so when the database is unreachable the app
// carries on and the learning layer reads the files instead. Nothing
// here ever throws into a request path: connection problems are
// logged once and downgraded to "disabled".
// ============================================================

import { Pool } from "pg";

const DEFAULT_URL = "postgres://teststudio:teststudio@localhost:5433/teststudio";
const URL = process.env.DATABASE_URL ?? DEFAULT_URL;
// Opt out entirely with DB_DISABLED=1 (useful in CI).
const DISABLED = process.env.DB_DISABLED === "1";

export type DbState = "connecting" | "ready" | "unavailable" | "disabled";

let pool: Pool | null = null;
let state: DbState = DISABLED ? "disabled" : "connecting";
let lastError: string | undefined;

export interface RunRow {
  id: string;
  file: string;
  name: string;
  kind: string;
  status: string;
  startedAt: string;
  startedBy?: string;
  finishedAt?: string;
  durationMs?: number;
  steps: {
    index: number;
    action: string;
    status: string;
    durationMs?: number;
    error?: string;
    testFile?: string;
    selector?: string;
  }[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  file         TEXT NOT NULL,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'test',
  status       TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  started_by   TEXT,
  finished_at  TIMESTAMPTZ,
  duration_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS run_steps (
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index   INTEGER NOT NULL,
  action       TEXT NOT NULL,
  status       TEXT NOT NULL,
  duration_ms  INTEGER,
  error        TEXT,
  test_file    TEXT,
  selector     TEXT,
  PRIMARY KEY (run_id, step_index)
);

CREATE INDEX IF NOT EXISTS runs_file_started_idx ON runs (file, started_at DESC);
CREATE INDEX IF NOT EXISTS run_steps_status_idx  ON run_steps (status);
`;

export function status(): { state: DbState; url: string; error?: string } {
  // Hide the password when reporting the URL to the UI.
  const safeUrl = URL.replace(/\/\/([^:]+):[^@]*@/, "//$1:***@");
  return { state, url: safeUrl, error: lastError };
}

export function isReady(): boolean {
  return state === "ready";
}

/** Connect and create the schema. Safe to call at boot; never throws. */
export async function init(): Promise<void> {
  if (DISABLED) return;
  try {
    pool = new Pool({ connectionString: URL, max: 4, connectionTimeoutMillis: 4000 });
    // A pool emits errors for idle clients too; swallow them rather than crashing the server.
    pool.on("error", err => {
      lastError = err.message;
      state = "unavailable";
    });
    await pool.query(SCHEMA);
    state = "ready";
    lastError = undefined;
    console.log(`Database ready (${status().url})`);
  } catch (e) {
    state = "unavailable";
    lastError = e instanceof Error ? e.message : String(e);
    console.log(`Database unavailable, using file storage instead (${lastError})`);
    if (pool) {
      await pool.end().catch(() => {});
      pool = null;
    }
  }
}

/** Retry a connection that failed earlier, e.g. after `docker compose up -d`. */
export async function reconnect(): Promise<void> {
  if (DISABLED) return;
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
  state = "connecting";
  await init();
}

/** Mirror a finished run into the database. Failures are logged, never thrown. */
export async function saveRun(run: RunRow): Promise<void> {
  if (!isReady() || !pool) return;
  const client = await pool.connect().catch(() => null);
  if (!client) return;
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO runs (id, file, name, kind, status, started_at, started_by, finished_at, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         finished_at = EXCLUDED.finished_at,
         duration_ms = EXCLUDED.duration_ms`,
      [
        run.id, run.file, run.name, run.kind, run.status,
        run.startedAt, run.startedBy ?? null,
        run.finishedAt ?? null, run.durationMs ?? null
      ]
    );
    await client.query("DELETE FROM run_steps WHERE run_id = $1", [run.id]);
    for (const s of run.steps) {
      await client.query(
        `INSERT INTO run_steps (run_id, step_index, action, status, duration_ms, error, test_file, selector)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          run.id, s.index, s.action, s.status,
          s.durationMs ?? null, s.error ?? null, s.testFile ?? null, s.selector ?? null
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    lastError = e instanceof Error ? e.message : String(e);
    console.error("Failed to store run in the database:", lastError);
  } finally {
    client.release();
  }
}

/** How many runs the database is holding, for the UI's status line. */
export async function counts(): Promise<{ runs: number; steps: number } | null> {
  if (!isReady() || !pool) return null;
  try {
    const runs = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM runs");
    const steps = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM run_steps");
    return { runs: Number(runs.rows[0].count), steps: Number(steps.rows[0].count) };
  } catch {
    return null;
  }
}

/** Backfill the database from run records already on disk. */
export async function importRuns(runs: RunRow[]): Promise<number> {
  if (!isReady()) return 0;
  let n = 0;
  for (const run of runs) {
    await saveRun(run);
    n++;
  }
  return n;
}
