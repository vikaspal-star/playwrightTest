import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Missing storage is normal on first boot; corrupt storage must never reset access controls. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Cannot read storage file ${path.basename(file)}. Restore a valid backup before continuing.`);
  }
}

/** Replace in the same directory so readers see either the old or the complete new file. */
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** File storage has one writer process; refuse a second server in the same workspace. */
export function acquireWorkspaceLock(directory: string): () => void {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "server.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return () => {
        try { if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file); } catch { /* already released */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid workspace lock. Check for an existing server before removing server.lock.");
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (alive) throw new Error("Another MMQA server is already using this workspace.");
      fs.unlinkSync(file);
    }
  }
  throw new Error("Could not lock the MMQA workspace.");
}
