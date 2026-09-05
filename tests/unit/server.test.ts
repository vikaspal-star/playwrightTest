import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { once } from "node:events";

function launch(workspace: string): { process: ChildProcess; ready: Promise<string> } {
  const child = spawn(process.execPath, ["--import", "tsx", "ui/server.ts"], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, STUDIO_WORKSPACE: workspace, PORT: "0", HOST: "127.0.0.1", DB_DISABLED: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const ready = new Promise<string>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Server startup timed out")); }, 10000);
    child.stdout!.on("data", chunk => {
      output += chunk;
      const match = /MMQA Studio running at (http:\/\/[^\s]+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.stderr!.on("data", chunk => { output += chunk; });
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("exit", () => { clearTimeout(timeout); reject(new Error(output)); });
  });
  return { process: child, ready };
}

test("server recovers orphaned runs, refuses a second writer, and fails closed on corrupt accounts", { timeout: 20000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mmqa-recovery-"));
  const runDir = path.join(workspace, "runs", "interrupted-run");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ id: "interrupted-run", file: "smoke.json", name: "Smoke", startedAt: new Date().toISOString(), status: "running", log: [], steps: [{ index: 1, action: "wait", status: "running" }] }));
  const server = launch(workspace);
  try {
    const url = await server.ready;
    const recovered = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.steps[0].status, "skipped");
    assert.match(recovered.error, /restarted/);
    const duplicate = launch(workspace);
    await assert.rejects(duplicate.ready, /already using this workspace/);
    fs.writeFileSync(path.join(workspace, "ui", "data", "users.json"), "{corrupt");
    const status = await fetch(`${url}/api/auth/status`);
    assert.equal(status.status, 500);
    const setup = await fetch(`${url}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "replacement", password: "safe-test-password" }) });
    assert.equal(setup.status, 500);
    assert.equal(fs.readFileSync(path.join(workspace, "ui", "data", "users.json"), "utf8"), "{corrupt");
  } finally {
    if (server.process.exitCode === null) {
      const exited = once(server.process, "exit");
      server.process.kill();
      await exited;
    }
    assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(workspace).startsWith("mmqa-recovery-"));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
