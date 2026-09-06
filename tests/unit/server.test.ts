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

test("usernames cannot be created that render identically to an existing member", { timeout: 20000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mmqa-username-"));
  const server = launch(workspace);
  try {
    const url = await server.ready;
    const json = (path: string, body: unknown, cookie?: string) => fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body)
    });

    const setup = await json("/api/auth/setup", { username: "owner", password: "safe-test-password" });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];

    assert.equal((await json("/api/users", { username: "john smith", password: "safe-test-password" }, cookie)).status, 201);

    // HTML collapses runs of whitespace, so a double-spaced name would be
    // indistinguishable from the account above in the member list, the sharing
    // picker and the per-user report. It must be treated as the same name.
    const collision = await json("/api/users", { username: "john  smith", password: "safe-test-password" }, cookie);
    assert.equal(collision.status, 400);
    assert.match((await collision.json()).error, /already exists/);

    for (const username of ["a/b", "-lead", "bad@name"]) {
      const rejected = await json("/api/users", { username, password: "safe-test-password" }, cookie);
      assert.equal(rejected.status, 400, `${username} should be rejected`);
      assert.match((await rejected.json()).error, /letters, numbers/);
    }

    // Signing in still tolerates whitespace and case the user did not type exactly.
    const login = await json("/api/auth/login", { username: "  JOHN   SMITH ", password: "safe-test-password" });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.username, "john smith");
  } finally {
    if (server.process.exitCode === null) {
      const exited = once(server.process, "exit");
      server.process.kill();
      await exited;
    }
    assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(workspace).startsWith("mmqa-username-"));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("deleting a test frees its folder without exposing retained sharing metadata", { timeout: 20000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mmqa-folder-"));
  const server = launch(workspace);
  try {
    const url = await server.ready;
    const send = (method: string, route: string, body?: unknown, cookie?: string) => fetch(`${url}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    const setup = await send("POST", "/api/auth/setup", { username: "owner", password: "safe-test-password" });
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];

    const created = await send("POST", "/api/tests", { file: "temp.json", name: "Temp", folder: "Archive/Old" }, cookie);
    assert.equal(created.status, 201);

    // A folder holding a live test cannot be removed.
    assert.equal((await send("DELETE", "/api/folders?path=Archive%2FOld", undefined, cookie)).status, 409);

    assert.equal((await send("DELETE", "/api/tests/temp.json", undefined, cookie)).status, 204);

    // Sharing metadata is deliberately kept so historical runs stay protected,
    // but it must not keep claiming a place in the folder tree.
    const meta = JSON.parse(fs.readFileSync(path.join(workspace, "ui", "data", "testMeta.json"), "utf8"));
    assert.ok(meta["temp.json"], "metadata is retained for historical run access");

    assert.equal((await send("DELETE", "/api/folders?path=Archive%2FOld", undefined, cookie)).status, 204);
    const folders = await (await send("GET", "/api/folders", undefined, cookie)).json();
    assert.ok(!folders.includes("Archive/Old"), "the emptied folder should be gone");
  } finally {
    if (server.process.exitCode === null) {
      const exited = once(server.process, "exit");
      server.process.kill();
      await exited;
    }
    assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(workspace).startsWith("mmqa-folder-"));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
