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

test("project migration is additive; test creation and moves preserve data and reject stale previews", { timeout: 20000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mmqa-projects-"));
  const data = path.join(workspace, "ui", "data");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(workspace, "json"));
  const original = JSON.stringify({ name: "Partner journey", steps: [{ action: "navigate", url: "https://coro.sb.example/login" }, { action: "fill", selector: "#name", value: "existing input" }] });
  const metadata = JSON.stringify({ "partner.json": { folder: "Coro Sandbox/Channel Partner", createdBy: "owner", visibility: "restricted", sharedWith: [] } });
  fs.writeFileSync(path.join(data, "folders.json"), JSON.stringify(["Acronis", "Coro Sandbox/Channel Partner"]));
  fs.writeFileSync(path.join(data, "testMeta.json"), metadata);
  fs.writeFileSync(path.join(workspace, "json", "partner.json"), original);
  const server = launch(workspace);
  try {
    const url = await server.ready;
    const request = (route: string, method = "GET", body?: unknown, cookie?: string) => fetch(url + route, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const setup = await request("/api/auth/setup", "POST", { username: "owner", password: "safe-test-password" });
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    const api = (route: string, method = "GET", body?: unknown) => request(route, method, body, cookie);
    const first = await (await api("/api/projects")).json();
    assert.deepEqual(first.projects.map((p: { name: string }) => p.name).sort(), ["Acronis", "Coro"]);
    assert.equal(fs.readFileSync(path.join(data, "testMeta.json"), "utf8"), metadata);
    assert.equal(fs.readFileSync(path.join(workspace, "json", "partner.json"), "utf8"), original);
    assert.deepEqual(await (await api("/api/projects")).json(), first);
    const created = await api("/api/projects", "POST", { name: "Anomali", environment: { name: "Production", type: "production", url: "https://anomali.example/" } });
    assert.equal(created.status, 201);
    const target = await created.json();
    const destination = { projectId: target.id, environmentId: target.environments[0].id };
    const firstNew = await (await api("/api/tests", "POST", { name: "New test", ...destination })).json();
    const secondNew = await (await api("/api/tests", "POST", { name: "New test", ...destination })).json();
    assert.equal(firstNew.file, "new-test.json");
    assert.equal(secondNew.file, "new-test-2.json");
    assert.deepEqual(firstNew.steps, [{ action: "navigate", url: "https://anomali.example/" }]);
    assert.equal((await api("/api/tests", "POST", { file: "new-test.json" })).status, 409);
    const preview = await (await api("/api/tests/partner.json/move-preview", "POST", destination)).json();
    assert.equal(preview.changes[0].after, "https://anomali.example/login");
    await api("/api/tests/partner.json", "PUT", { name: "Edited while reviewing", steps: JSON.parse(original).steps });
    assert.equal((await api("/api/tests/partner.json/move", "POST", { ...destination, revision: preview.revision, adaptUrls: true })).status, 409);
    const refreshed = await (await api("/api/tests/partner.json/move-preview", "POST", destination)).json();
    const moved = await (await api("/api/tests/partner.json/move", "POST", { ...destination, revision: refreshed.revision, adaptUrls: true })).json();
    assert.equal(moved.name, "Edited while reviewing");
    assert.equal(moved.steps[0].url, "https://anomali.example/login");
    assert.equal(moved.steps[1].value, "existing input");
    assert.equal(moved.meta.folder, "Coro Sandbox/Channel Partner");
    assert.equal(moved.meta.visibility, "restricted");
    assert.ok(fs.readdirSync(path.join(data, "project-moves")).length > 0);
    const final = await (await api("/api/projects")).json();
    assert.deepEqual(final.assignments["partner.json"], destination);
    const badScope = { projectId: first.projects[0].id, environmentId: destination.environmentId };
    assert.equal((await api("/api/tests/partner.json/move-preview", "POST", badScope)).status, 400);
    assert.equal((await request("/api/projects")).status, 401);
    await api("/api/users", "POST", { username: "viewer", password: "safe-test-password", role: "member", features: ["folders.manage", "tests.edit"] });
    const login = await request("/api/auth/login", "POST", { username: "viewer", password: "safe-test-password" });
    const viewerCookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await request("/api/tests/partner.json/move-preview", "POST", destination, viewerCookie)).status, 404);
    assert.equal((await (await request("/api/projects", "GET", undefined, viewerCookie)).json()).assignments["partner.json"], undefined);
  } finally {
    if (server.process.exitCode === null) { const exited = once(server.process, "exit"); server.process.kill(); await exited; }
    assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(workspace).startsWith("mmqa-projects-"));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("departments are attached to accounts and normalized so a team is spelled one way", { timeout: 20000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mmqa-dept-"));
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

    // Stray and repeated whitespace must not create a second "QA".
    const created = await send("POST", "/api/users", { username: "tester", password: "safe-test-password", department: "  Q  A  " }, cookie);
    assert.equal(created.status, 201);
    assert.equal((await created.json()).department, "Q A");

    const second = await send("POST", "/api/users", { username: "other", password: "safe-test-password", department: "QA" }, cookie);
    const otherId = (await second.json()).id;

    // A department is descriptive, never a grant.
    const users = await (await send("GET", "/api/users", undefined, cookie)).json();
    const other = users.find((u: { id: string }) => u.id === otherId);
    assert.equal(other.department, "QA");
    assert.ok(!other.effectiveFeatures.includes("users.manage"), "a department must not confer access");

    // Editing and clearing both work.
    await send("PUT", `/api/users/${otherId}`, { department: "Engineering" }, cookie);
    assert.equal((await (await send("GET", "/api/users", undefined, cookie)).json())
      .find((u: { id: string }) => u.id === otherId).department, "Engineering");

    await send("PUT", `/api/users/${otherId}`, { department: "" }, cookie);
    assert.equal((await (await send("GET", "/api/users", undefined, cookie)).json())
      .find((u: { id: string }) => u.id === otherId).department, undefined);

    const departments = await (await send("GET", "/api/departments", undefined, cookie)).json();
    assert.deepEqual(departments, ["Q A"], "only departments still in use are offered");
  } finally {
    if (server.process.exitCode === null) {
      const exited = once(server.process, "exit");
      server.process.kill();
      await exited;
    }
    assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(workspace).startsWith("mmqa-dept-"));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("renaming a department moves every member of it at once", { timeout: 20000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mmqa-deptflow-"));
  const server = launch(workspace);
  try {
    const url = await server.ready;
    const send = (method: string, route: string, body?: unknown, cookie?: string) => fetch(`${url}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    // The first account is created before Manage users exists, so setup must
    // be able to record a department too.
    const setup = await send("POST", "/api/auth/setup", { username: "owner", password: "safe-test-password", department: "QA" });
    const cookie = setup.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await setup.json()).user.department, "QA");

    await send("POST", "/api/users", { username: "second", password: "safe-test-password", department: "QA" }, cookie);
    await send("POST", "/api/users", { username: "third", password: "safe-test-password", department: "Product" }, cookie);

    // Renaming has to move everyone; editing one at a time is how a workspace
    // ends up with two spellings of the same team.
    const renamed = await send("PUT", "/api/departments", { from: "QA", to: "Quality Assurance" }, cookie);
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).moved, 2);

    const after = await (await send("GET", "/api/users", undefined, cookie)).json();
    const departments = after.map((u: { department?: string }) => u.department).sort();
    assert.deepEqual(departments, ["Product", "Quality Assurance", "Quality Assurance"]);

    // Clearing a department leaves the accounts intact.
    const cleared = await send("PUT", "/api/departments", { from: "Quality Assurance", to: "" }, cookie);
    assert.equal((await cleared.json()).moved, 2);
    assert.deepEqual(await (await send("GET", "/api/departments", undefined, cookie)).json(), ["Product"]);
    assert.equal((await (await send("GET", "/api/users", undefined, cookie)).json()).length, 3);
  } finally {
    if (server.process.exitCode === null) {
      const exited = once(server.process, "exit");
      server.process.kill();
      await exited;
    }
    assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(workspace).startsWith("mmqa-deptflow-"));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
