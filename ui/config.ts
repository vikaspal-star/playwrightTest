import path from "node:path";

export const ROOT = path.resolve(__dirname, "..");
// A separate workspace is useful for disposable verification and independent installations.
export const WORKSPACE = path.resolve(process.env.STUDIO_WORKSPACE || ROOT);
export const JSON_DIR = path.join(WORKSPACE, "json");
export const SUITES_DIR = path.join(WORKSPACE, "suites");
export const RUNS_DIR = path.join(WORKSPACE, "runs");
export const DATA_DIR = path.join(WORKSPACE, "ui", "data");
export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = Number(process.env.PORT || 4173);
export const MAX_ACTIVE_RUNS = positiveInteger(process.env.MAX_ACTIVE_RUNS, 2);
export const RUN_TIMEOUT_MS = positiveInteger(process.env.RUN_TIMEOUT_MS, 120000);

function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
