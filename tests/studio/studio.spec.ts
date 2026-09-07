import { test, expect, APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

let admin: APIRequestContext;
let member: APIRequestContext;
const password = "Local-test-password-42";
// This file is one ordered workspace journey with shared disposable fixtures.
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ playwright }) => {
  admin = await playwright.request.newContext({ baseURL: "http://127.0.0.1:4187" });
  member = await playwright.request.newContext({ baseURL: "http://127.0.0.1:4187" });
  expect((await admin.post("/api/auth/setup", { data: { username: "owner", password } })).status()).toBe(201);
  expect((await admin.post("/api/users", { data: { username: "viewer", password, role: "member", features: ["tests.run", "suites.run", "reports.view"] } })).status()).toBe(201);
  expect((await member.post("/api/auth/login", { data: { username: "viewer", password } })).ok()).toBeTruthy();
});

test.afterAll(async () => { await admin.dispose(); await member.dispose(); });

test("API rejects malformed input, cross-origin mutations and unauthorized edits", async () => {
  expect((await admin.post("/api/tests", { data: { file: "invalid", steps: [{ action: "click" }] } })).status()).toBe(400);
  expect((await admin.post("/api/tests", { data: { file: "bad-folder", folder: "../secret", steps: [] } })).status()).toBe(400);
  expect((await admin.get("/api/tests/bad-folder.json")).status()).toBe(404);
  expect((await admin.post("/api/tests", { data: { file: "csrf" }, headers: { Origin: "https://foreign.example" } })).status()).toBe(403);
  expect((await member.post("/api/tests", { data: { file: "forbidden" } })).status()).toBe(403);
  expect((await admin.post("/api/tests", { data: "{broken", headers: { "Content-Type": "application/json" } })).status()).toBe(400);
  const response = await admin.get("/api/auth/status", { headers: { Cookie: "studio_sid=%ZZ" } });
  expect(response.status()).toBe(200);
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-powered-by"]).toBeUndefined();
});

test("restricted tests protect suites, run details, events, screenshots, reports and AI", async () => {
  expect((await admin.post("/api/tests", { data: { file: "private", steps: [{ action: "wait", timeout: 1 }] } })).status()).toBe(201);
  expect((await admin.post("/api/suites", { data: { file: "private-suite", tests: ["private.json"] } })).status()).toBe(201);
  expect((await admin.put("/api/tests/private.json/sharing", { data: { visibility: "restricted", sharedWith: [] } })).ok()).toBeTruthy();
  const record = { id: "private-run", file: "private.json", name: "Confidential test", status: "passed", startedAt: new Date().toISOString(), steps: [{ index: 1, action: "wait", status: "passed" }], log: ["confidential"] };
  const dir = path.join(process.env.STUDIO_TEST_WORKSPACE!, "runs", record.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(record));
  fs.writeFileSync(path.join(dir, "step-1.png"), "private artifact");
  for (const route of ["/api/tests/private.json", "/api/suites/private-suite.json", "/api/runs/private-run", "/api/runs/private-run/events", "/api/runs/private-run/report", "/runs/private-run/step-1.png", "/api/knowledge/private.json"]) {
    expect((await member.get(route)).status(), route).toBe(404);
  }
  expect(await (await member.get("/api/runs")).json()).toEqual([]);
  expect(await (await member.get("/api/suites")).json()).toEqual([]);
  expect(JSON.stringify(await (await member.get("/api/reports/summary")).json())).not.toContain("private.json");
  expect((await admin.get("/runs/private-run/step-1.png")).status()).toBe(200);
  expect((await admin.get("/runs/private-run/run.json")).status()).toBe(404);
  expect((await admin.delete("/api/tests/private.json")).status()).toBe(409);
  expect((await admin.delete("/api/suites/private-suite.json")).status()).toBe(204);
  expect((await admin.delete("/api/tests/private.json")).status()).toBe(204);
  expect((await admin.post("/api/tests", { data: { file: "private", steps: [] } })).status()).toBe(201);
  expect((await member.get("/api/runs/private-run")).status()).toBe(404);
});

test("single tests produce isolated reports and suite sessions carry between tests", async () => {
  const first = [{ action: "navigate", url: "http://127.0.0.1:4187" }, { action: "fill", selector: "#login-username", value: "shared-session" }];
  const second = [{ action: "verify-value", selector: "#login-username", value: "shared-session" }];
  for (const [file, steps] of [["session-first", first], ["session-second", second]] as const) {
    expect((await admin.post("/api/tests", { data: { file, steps } })).status()).toBe(201);
  }
  const singleResponse = await admin.post("/api/tests/session-first.json/run");
  expect(singleResponse.status()).toBe(202);
  const single = await singleResponse.json();
  await expect.poll(async () => (await (await admin.get(`/api/runs/${single.id}`)).json()).status, { timeout: 45000 }).toBe("passed");
  expect((await admin.get(`/runs/${single.id}/step-1.png`)).status()).toBe(200);
  expect((await admin.get(`/runs/${single.id}/report/index.html`)).status()).toBe(200);
  expect((await admin.get(`/runs/${single.id}/input/session-first.json`)).status()).toBe(404);
  expect((await admin.post("/api/suites", { data: { file: "session-suite", tests: ["session-first.json", "session-second.json"] } })).status()).toBe(201);
  const suite = await (await admin.post("/api/suites/session-suite.json/run")).json();
  await expect.poll(async () => (await (await admin.get(`/api/runs/${suite.id}`)).json()).status, { timeout: 30000 }).toBe("passed");
});

test("recordings are owned and cannot bypass the test editing feature", async () => {
  const response = await admin.post("/api/record/start", { data: { url: "http://127.0.0.1:4187" } });
  expect(response.status()).toBe(201);
  const recording = await response.json();
  try {
    expect((await member.get(`/api/record/${recording.id}`)).status()).toBe(404);
    expect((await member.get(`/api/record/${recording.id}/events`)).status()).toBe(404);
    expect((await member.get(`/api/screen/${recording.id}/events`)).status()).toBe(404);
    expect((await member.post(`/api/screen/${recording.id}/interact`, { data: { kind: "click", x: 0.5, y: 0.5 } })).status()).toBe(404);
    expect((await member.post(`/api/record/${recording.id}/stop`)).status()).toBe(404);
    expect((await member.post(`/api/record/${recording.id}/apply`, { data: { file: "session-first.json" } })).status()).toBe(403);
  } finally { await admin.post(`/api/record/${recording.id}/stop`); }
});

test("editor supports validation recovery, accessible labels and responsive overview", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.locator("#login-form").getByLabel("Username", { exact: true }).fill("owner");
  await page.locator("#login-form").getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace overview", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "+ Create a test", exact: true }).click();
  await page.getByRole("dialog", { name: "New test", exact: true }).getByLabel("Test name", { exact: true }).fill("Editor test");
  await page.getByRole("dialog", { name: "New test", exact: true }).getByLabel("Project", { exact: true }).selectOption({ label: "General" });
  await page.getByRole("button", { name: "Create test", exact: true }).click();
  await page.getByRole("button", { name: "+ Add step", exact: true }).click();
  await page.getByRole("button", { name: "Add manually", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#test-validation")).toContainText("selector is required");
  await page.getByLabel("Selector", { exact: false }).fill("#login-username");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#dirty")).toBeHidden();
  await expect(page.locator("#test-validation")).toBeHidden();
  await page.getByRole("button", { name: "Workspace overview", exact: true }).click();
  await page.screenshot({ path: "test-results/studio-overview-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/studio-overview-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
});

test("viewers see read-only editors and cannot stop someone else's run", async ({ page }) => {
  await page.goto("/");
  await page.locator("#login-form").getByLabel("Username", { exact: true }).fill("viewer");
  await page.locator("#login-form").getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.goto("/#session-first.json");
  await expect(page.locator("#steps input").first()).toBeDisabled();
  await expect(page.locator("#btn-save")).toBeDisabled();
  await expect(page.locator("#btn-run")).toBeEnabled();
  await expect(page.locator("#btn-record")).toBeHidden();
  expect((await admin.post("/api/tests", { data: { file: "long-run", steps: [{ action: "wait", timeout: 60000 }] } })).status()).toBe(201);
  const run = await (await admin.post("/api/tests/long-run.json/run")).json();
  expect((await member.post(`/api/runs/${run.id}/stop`)).status()).toBe(403);
  expect((await admin.post(`/api/runs/${run.id}/stop`)).status()).toBe(202);
  await expect.poll(async () => (await (await admin.get(`/api/runs/${run.id}`)).json()).status).toBe("failed");
});

test("libraries support folders, filters, draft navigation and mobile access", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const folder = "Partner Sandbox/Channel partner onboarding";
  const name = "Channel partner onboarding — validate administrator permissions and organization settings";
  expect((await admin.post("/api/folders", { data: { path: folder } })).status()).toBe(201);
  expect((await admin.post("/api/tests", { data: { file: "partner-onboarding", name, folder, steps: [{ action: "wait", timeout: 1 }] } })).status()).toBe(201);
  await page.context().addCookies((await admin.storageState()).cookies);
  await page.goto("/#view:tests");
  await expect(page.getByRole("heading", { name: /^Projects/ })).toBeVisible();
  const partner = page.getByRole("button", { name: `Open test ${name}`, exact: true });
  await expect(partner).toBeVisible();
  await page.getByRole("button", { name: "Open project Partner", exact: true }).click();
  await expect(partner).toBeVisible();
  await expect(page.getByRole("button", { name: "Open environment Sandbox", exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search tests" }).fill("Channel partner");
  await expect(partner).toBeVisible();
  await expect(page.locator("#test-tree .test-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.screenshot({ path: "test-results/studio-library-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: "test-results/studio-library-compact.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await partner.click();
  await page.locator("#test-name").fill("Unsaved partner draft");
  await page.getByRole("button", { name: "← Projects", exact: true }).click();
  await page.getByRole("button", { name: "+ New test", exact: true }).click();
  await expect(page.locator("#confirm-message")).toContainText("Discard unsaved test changes");
  await page.locator("#confirm-cancel").click();
  await partner.click();
  await expect(page.locator("#test-name")).toHaveValue("Unsaved partner draft");
  await expect(page.locator("#dirty")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#tests-panel")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#test-name")).toHaveValue("Unsaved partner draft");
  await page.locator("#test-name").fill(name);
  await page.locator("#btn-save").click();
  await expect(page.locator("#dirty")).toBeHidden();
  await page.locator(".editor-menu > summary").click();
  await expect(page.locator("#btn-record")).toBeVisible();
  await page.getByRole("button", { name: "Share test", exact: true }).click();
  await expect(page.locator("#share-modal")).toBeVisible();
  await page.locator("#btn-share-cancel").click();
  await expect(page.locator(".editor-menu > summary")).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: "test-results/studio-editor-desktop.png", fullPage: true });
  await page.locator(".tab[data-tab=suites]").click();
  await page.getByRole("button", { name: "Open suite session-suite", exact: true }).click();
  await expect(page.locator("#suite-workspace")).toBeVisible();
  await page.getByRole("button", { name: "← Suites", exact: true }).click();
  await expect(page.locator("#suites-panel")).toBeVisible();
  await page.locator(".tab[data-tab=reports]").click();
  await expect(page.locator("#report-days")).toBeVisible();
  await page.locator("#report-days").selectOption("7");
  await expect(page.locator(".report-body")).not.toContainText("Loading");
  await page.screenshot({ path: "test-results/studio-reports-desktop.png", fullPage: true });
  await page.locator(".tab[data-tab=overview]").click();
  await page.getByRole("button", { name: /^Never run/ }).click();
  await expect(page.locator(".chip[data-filter=none]")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/studio-library-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Workspace overview", exact: true }).click();
  await expect(page.locator("#empty")).toBeVisible();
  await expect(page.locator("#nav-backdrop")).toBeHidden();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test("user management supports account creation, search, role guidance and responsive access", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.context().addCookies((await admin.storageState()).cookies);
  await page.goto("/");
  await page.locator("#account-menu > summary").click();
  await page.getByRole("button", { name: "Manage users", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Manage users", exact: true });
  const form = dialog.locator("#add-user-form");
  await expect(dialog.getByRole("button", { name: "Remove owner", exact: true })).toBeDisabled();
  await form.getByLabel("Username", { exact: true }).fill("owner");
  await form.getByLabel("Password", { exact: true }).fill(password);
  await form.getByRole("button", { name: "Show password", exact: true }).click();
  await expect(form.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await form.getByRole("button", { name: "Hide password", exact: true }).click();
  await form.getByLabel("Role", { exact: true }).selectOption("admin");
  await expect(dialog.locator("#new-role-help")).toContainText("member accounts");
  await form.getByLabel("Role", { exact: true }).selectOption("member");
  await form.getByRole("button", { name: /Add user/ }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await expect(form.getByLabel("Username", { exact: true })).toHaveValue("owner");
  await form.getByLabel("Username", { exact: true }).fill("design-reviewer");
  await form.getByRole("button", { name: /Add user/ }).click();
  await expect(dialog.getByRole("button", { name: "Manage access for design-reviewer", exact: true })).toBeVisible();
  await expect(form.getByLabel("Password", { exact: true })).toHaveValue("");
  await dialog.getByRole("searchbox", { name: "Search members" }).fill("no-matching-person");
  await expect(dialog.getByRole("status")).toContainText("No matching members");
  await dialog.getByRole("searchbox", { name: "Search members" }).fill("design-reviewer");
  await expect(dialog.locator(".member-row")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Manage access for design-reviewer", exact: true }).click();
  await expect(page.locator("#features-modal")).toBeVisible();
  await page.locator("#btn-features-cancel").click();
  await expect(dialog.getByRole("button", { name: "Manage access for design-reviewer", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Remove design-reviewer", exact: true }).click();
  await page.locator("#confirm-cancel").click();
  await expect(dialog.getByRole("button", { name: "Remove design-reviewer", exact: true })).toBeVisible();
  await dialog.getByRole("searchbox", { name: "Search members" }).fill("");
  await dialog.getByRole("heading", { name: "Add a teammate", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/studio-users-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("heading", { name: "Add a teammate", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/studio-users-mobile.png", fullPage: true });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBeTruthy();
  await dialog.getByRole("searchbox", { name: "Search members" }).fill("design-reviewer");
  await expect(dialog.getByRole("button", { name: "Manage access for design-reviewer", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#account-menu > summary")).toBeFocused();
  expect(errors).toEqual([]);

  // Non-site admins can only create members, matching the server's role rules.
  expect((await admin.post("/api/users", { data: { username: "team-manager", password, role: "admin" } })).status()).toBe(201);
  const context = await browser.newContext();
  try {
    await context.request.post("http://127.0.0.1:4187/api/auth/login", { data: { username: "team-manager", password } });
    const managerPage = await context.newPage();
    await managerPage.goto("http://127.0.0.1:4187/");
    await managerPage.locator("#account-menu > summary").click();
    await managerPage.getByRole("button", { name: "Manage users", exact: true }).click();
    await expect(managerPage.locator("#new-role option[value=admin]")).toBeDisabled();
    await expect(managerPage.locator("#new-role option[value=site_admin]")).toBeDisabled();
    await expect(managerPage.locator(".member-access")).toHaveCount(0);
    await expect(managerPage.getByRole("button", { name: "Remove owner", exact: true })).toBeDisabled();
    await managerPage.keyboard.press("Escape");
    await expect(managerPage.locator("#users-modal")).toBeHidden();
  } finally { await context.close(); }
});

test("projects, unique test names, embedded recording, insertion and live playback work together", async ({ page }) => {
  test.setTimeout(120000);
  const { createServer } = await import("node:http");
  const fixture = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body style="font:18px Arial;background:#f5f8ff;margin:0"><h1 style="position:absolute;left:40px;top:8px">Partner application</h1><input id="name" aria-label="Name" placeholder="Name" style="position:absolute;left:40px;top:85px;width:260px;height:36px"><input id="password" type="password" aria-label="Password" style="position:absolute;left:40px;top:145px;width:260px;height:36px"><button id="save" style="position:absolute;left:40px;top:215px;width:140px;height:40px" onclick="document.getElementById('result').textContent='Saved '+document.getElementById('name').value">Save profile</button><h2 id="result" style="position:absolute;left:40px;top:290px">Pending</h2></body></html>`);
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/`;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let recordingId: string | undefined;
  try {
    await page.context().addCookies((await admin.storageState()).cookies);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/#view:tests");
    await page.getByRole("button", { name: "+ New project", exact: true }).click();
    const projectDialog = page.getByRole("dialog", { name: "New project", exact: true });
    await projectDialog.getByLabel("Project name", { exact: true }).fill("Recorder project");
    await projectDialog.getByLabel("Application URL", { exact: true }).fill(url);
    await projectDialog.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(projectDialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open project Recorder project", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "+ New test", exact: true }).click();
    await page.getByRole("dialog", { name: "New test", exact: true }).getByLabel("Test name").fill("Recorded journey");
    await page.getByRole("button", { name: "Create test", exact: true }).click();
    await expect(page.locator("#test-name")).toHaveValue("Recorded journey");
    const file = "recorded-journey.json";
    const store = await (await admin.get("/api/projects")).json();
    const assignment = store.assignments[file];
    const repeat = await (await admin.post("/api/tests", { data: { name: "Recorded journey", ...assignment } })).json();
    expect(repeat.file).toBe("recorded-journey-2.json");
    await page.locator("#test-description").fill("Keep this unsaved description");
    await page.getByRole("button", { name: "Record screen", exact: true }).click();
    await expect(page.locator("#record-url")).toHaveValue(url);
    const started = page.waitForResponse(response => response.url().endsWith("/api/record/start") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Start recording", exact: true }).click();
    recordingId = (await (await started).json()).id;
    await expect(page.locator("#record-screen-img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    expect((await member.get(`/api/record/${recordingId}/screen`)).status()).toBe(404);
    expect((await member.post(`/api/record/${recordingId}/input`, { data: { type: "click", x: 1, y: 1 } })).status()).toBe(404);
    expect((await admin.post(`/api/record/${recordingId}/input`, { data: { type: "click", x: -10, y: 100 } })).status()).toBe(400);
    expect((await admin.post(`/api/screen/${recordingId}/interact`, { data: { kind: "click", x: "bad", y: 0.5 } })).status()).toBe(400);
    expect((await admin.post(`/api/screen/${recordingId}/interact`, { data: { kind: "move", x: 0.5, y: 0.5 } })).status()).toBe(204);
    const streamed = await page.evaluate(id => new Promise<boolean>(resolve => {
      const source = new EventSource(`/api/screen/${id}/events`);
      const timer = setTimeout(() => { source.close(); resolve(false); }, 5000);
      source.addEventListener("frame", event => {
        const frame = JSON.parse((event as MessageEvent).data);
        clearTimeout(timer); source.close(); resolve(frame.width === 1280 && frame.height === 800 && frame.data.length > 100);
      });
    }), recordingId);
    expect(streamed).toBe(true);
    const clickScreen = async (x: number, y: number) => {
      const box = (await page.locator("#record-screen-img").boundingBox())!;
      await page.mouse.click(box.x + x / 1280 * box.width, box.y + y / 800 * box.height);
    };
    await clickScreen(900, 500); // Background clicks should never become replay steps.
    await clickScreen(90, 103);
    await page.keyboard.type("Alex");
    await expect.poll(async () => (await (await admin.get(`/api/record/${recordingId}`)).json()).steps.some((step: { value: string }) => step.value === "Alex")).toBe(true);
    await clickScreen(90, 163);
    await page.keyboard.type("private-recording-value");
    await clickScreen(90, 235);
    await expect.poll(async () => (await (await admin.get(`/api/record/${recordingId}`)).json()).steps.some((step: { selector: string; action: string }) => step.selector === "#save" && step.action === "click")).toBe(true);
    await page.getByRole("button", { name: "Capture screenshot step", exact: true }).click();
    await page.getByRole("button", { name: "Stop recording", exact: false }).click();
    await expect(page.locator("#record-badge")).toHaveText("stopped");
    const captured = await (await admin.get(`/api/record/${recordingId}`)).json();
    expect(JSON.stringify(captured)).not.toContain("private-recording-value");
    expect(captured.steps.find((step: { selector: string }) => step.selector === "#password").value).toBe("");
    await page.screenshot({ path: "test-results/studio-embedded-recorder.png", fullPage: true });
    await page.getByRole("button", { name: "Add to draft", exact: true }).click();
    await expect(page.locator("#dirty")).toBeVisible();
    await expect(page.locator("#test-description")).toHaveValue("Keep this unsaved description");
    // The saved navigation is retained; the recorder's opening navigation is skipped.
    await expect(page.locator("#steps .step-card")).toHaveCount(5);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#dirty")).toBeHidden();
    const saved = await (await admin.get(`/api/tests/${file}`)).json();
    expect(saved.description).toBe("Keep this unsaved description");
    expect(saved.steps.map((step: { action: string }) => step.action)).toEqual(["navigate", "fill", "fill", "click", "screenshot"]);
    // Add a meaningful assertion and enough time to verify frames during execution.
    expect((await admin.put(`/api/tests/${file}`, { data: { ...saved, steps: [...saved.steps, { action: "text-visible", text: "Saved Alex" }, { action: "wait", timeout: 3000 }] } })).status()).toBe(200);
    await page.reload();
    await page.getByRole("button", { name: "Hide navigation", exact: true }).click();
    await expect(page.locator(".app")).toHaveClass(/drawer-collapsed/);
    await page.reload();
    await expect(page.locator(".app")).toHaveClass(/drawer-collapsed/);
    await page.keyboard.press("\\");
    await expect(page.locator(".app")).not.toHaveClass(/drawer-collapsed/);
    await page.keyboard.press("\\");
    await expect(page.locator(".app")).toHaveClass(/drawer-collapsed/);
    const left = (await page.locator("#workspace .pane-steps").boundingBox())!;
    const right = (await page.locator("#workspace .pane-run").boundingBox())!;
    expect(right.width).toBeGreaterThan(left.width * 2);
    await page.locator("#btn-run").click();
    await expect(page.locator("#viewer-img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/, { timeout: 30000 });
    await expect(page.locator("#playback-address")).toContainText(url);
    await expect(page.locator("#run-status .badge")).toHaveText("passed", { timeout: 45000 });
    await page.screenshot({ path: "test-results/studio-project-playback.png", fullPage: true });
    const target = await (await admin.post("/api/projects", { data: { name: "Release project", environment: { name: "Production", type: "production", url: "https://destination.example/" } } })).json();
    await page.goto(`/#${repeat.file}`);
    await expect(page.locator("#test-file")).toContainText(repeat.file);
    await page.locator("#btn-move-folder").click();
    const move = page.getByRole("dialog", { name: "Move test · AI adaptation", exact: true });
    await move.getByLabel("Project", { exact: true }).selectOption(target.id);
    await move.getByRole("button", { name: "Review changes", exact: true }).click();
    await expect(move).toContainText("1 URL changes proposed");
    await expect(move).toContainText("Production selected");
    await page.screenshot({ path: "test-results/studio-move-preview.png", fullPage: true });
    await move.getByRole("button", { name: "Move test", exact: true }).click();
    await expect(move).toHaveCount(0);
    const moved = await (await admin.get(`/api/tests/${repeat.file}`)).json();
    expect(moved.steps[0].url).toBe("https://destination.example/");
    const afterMove = await (await admin.get("/api/projects")).json();
    expect(afterMove.assignments[repeat.file].projectId).toBe(target.id);
    expect(errors).toEqual([]);
  } finally {
    if (recordingId) await admin.post(`/api/record/${recordingId}/stop`);
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
});

test("agent testing creates, runs and exports real multi-turn conversations from a responsive workspace", async ({ page, playwright }) => {
  const { createServer } = await import("node:http");
  const requests: Array<{ message: string; sessionId: string; messages: unknown[] }> = [];
  const fixture = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); requests.push(data);
    if (req.url === "/slow") { res.setHeader("Content-Type", "application/json"); res.write("{"); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ reply: data.message.includes("name") ? "Your name is Ana. I can help with returns." : "I can help. Returns are accepted within 30 days." }));
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(fixture.address() as import("node:net").AddressInfo).port}/chat`;
  const other = await playwright.request.newContext({ baseURL: "http://127.0.0.1:4187" });
  try {
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    const project = await (await admin.post("/api/projects", { data: { name: "Agent evaluation", environment: { name: "Sandbox", type: "sandbox", url: "http://localhost:9999/" } } })).json();
    expect((await member.get("/api/agent-tests")).status()).toBe(403);
    expect((await admin.post("/api/users", { data: { username: "agent-tester", password, role: "member", features: ["agents.manage"] } })).status()).toBe(201);
    expect((await other.post("/api/auth/login", { data: { username: "agent-tester", password } })).status()).toBe(200);
    await page.context().addCookies((await admin.storageState()).cookies);
    await page.goto("/#view:agents");
    await expect(page.getByRole("heading", { name: "Agent Testing", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create your first agent test", exact: true }).click();
    await page.getByLabel("Agent name", { exact: true }).fill("Returns assistant");
    await page.getByLabel("Project", { exact: true }).selectOption(project.id);
    await page.getByLabel("Chat API URL", { exact: true }).fill(url);
    await page.getByLabel("Agent requirements", { exact: true }).fill("Help with returns. The return window is 30 days. Remember the customer's name.");
    await page.getByRole("button", { name: "Continue to scenarios →", exact: true }).click();
    await page.getByLabel("User messages (one per line)", { exact: true }).fill("My name is Ana\nWhat is my name?");
    await page.getByLabel("Expected behavior or text", { exact: true }).fill("Ana");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#agent-save-state")).toHaveText("All changes saved");
    const saved = (await (await admin.get("/api/agent-tests")).json()).plans.find((p: { plan: { name: string } }) => p.plan.name === "Returns assistant");
    expect(saved.plan.environmentId).toBe(project.environments[0].id);
    expect((await other.get("/api/agent-tests")).status()).toBe(200);
    expect((await (await other.get("/api/agent-tests")).json()).plans).toEqual([]);
    expect((await other.put(`/api/agent-tests/${saved.id}`, { data: { plan: saved.plan, revision: saved.revision } })).status()).toBe(404);
    await page.getByRole("button", { name: "Run all scenarios", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Conversation evidence", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Export JSON", exact: true })).toBeVisible();
    const history = await (await admin.get(`/api/agent-tests/${saved.id}/runs`)).json();
    expect(history[0].status).toBe("passed");
    const runId = history[0].id;
    const run = await (await admin.get(`/api/agent-tests/runs/${runId}`)).json();
    expect(run.results[0].transcript).toHaveLength(4);
    expect(requests[0].sessionId).toBe(requests[1].sessionId); expect(requests[1].messages).toHaveLength(3);
    expect(run.results[0].checks[0].evidence).toContain("Ana");
    for (const route of [`/api/agent-tests/${saved.id}/runs`, `/api/agent-tests/runs/${runId}`, `/api/agent-tests/runs/${runId}/export`]) expect((await other.get(route)).status()).toBe(404);
    expect((await other.post(`/api/agent-tests/runs/${runId}/cancel`, { data: {} })).status()).toBe(404);
    const xml = await (await admin.get(`/api/agent-tests/runs/${runId}/export?format=junit`)).text(); expect(xml).toContain('failures="0"'); expect(xml).toContain("Your name is Ana");
    await page.screenshot({ path: "test-results/agent-testing-results.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/agent-testing-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Failures preserve evidence and historical plans remain unchanged after edits.
    saved.plan.scenarios[0].criteria[0].value = "a phrase never returned";
    const updated = await (await admin.put(`/api/agent-tests/${saved.id}`, { data: { plan: saved.plan, revision: saved.revision } })).json();
    expect((await admin.put(`/api/agent-tests/${saved.id}`, { data: { plan: saved.plan, revision: saved.revision } })).status()).toBe(409);
    const failedRun = await (await admin.post(`/api/agent-tests/${saved.id}/run`, { data: { revision: updated.revision } })).json();
    await expect.poll(async () => (await (await admin.get(`/api/agent-tests/runs/${failedRun.id}`)).json()).status).toBe("failed");
    expect(await (await admin.get(`/api/agent-tests/runs/${failedRun.id}/export?format=junit`)).text()).toContain('failures="1"');
    expect((await (await admin.get(`/api/agent-tests/runs/${runId}`)).json()).plan.scenarios[0].criteria[0].value).toBe("Ana");
    updated.plan.endpoint = url.replace("/chat", "/slow");
    const slow = await (await admin.put(`/api/agent-tests/${saved.id}`, { data: { plan: updated.plan, revision: updated.revision } })).json();
    const running = await (await admin.post(`/api/agent-tests/${saved.id}/run`, { data: { revision: slow.revision } })).json();
    await expect.poll(() => requests.length).toBeGreaterThanOrEqual(5);
    expect((await admin.post(`/api/agent-tests/runs/${running.id}/cancel`, { data: {} })).status()).toBe(202);
    await expect.poll(async () => (await (await admin.get(`/api/agent-tests/runs/${running.id}`)).json()).status).toBe("cancelled");
    expect(await (await admin.get(`/api/agent-tests/runs/${running.id}/export?format=junit`)).text()).toContain("<failure");
    const ownAI = { ...saved.plan, name: "Private rubric" }; ownAI.scenarios[0].criteria[0].kind = "ai";
    const privatePlan = await (await other.post("/api/agent-tests", { data: ownAI })).json();
    expect((await other.post(`/api/agent-tests/${privatePlan.id}/run`, { data: { revision: privatePlan.revision } })).status()).toBe(403);
    privatePlan.plan.scenarios.push({ ...structuredClone(privatePlan.plan.scenarios[0]), criteria: [{ name: "Text only", kind: "contains", value: "Ana", critical: true, threshold: 0.8 }] });
    const mixedPlan = await (await other.put(`/api/agent-tests/${privatePlan.id}`, { data: { revision: privatePlan.revision, plan: privatePlan.plan } })).json();
    const textOnly = await other.post(`/api/agent-tests/${privatePlan.id}/run`, { data: { revision: mixedPlan.revision, scenarioIndex: 1 } });
    expect(textOnly.status()).toBe(202);
    const textOnlyRun = await textOnly.json();
    await expect.poll(async () => (await (await other.get(`/api/agent-tests/runs/${textOnlyRun.id}`)).json()).status).toBe("passed");
    expect((await other.post("/api/agent-tests/generate", { data: { requirements: "test" } })).status()).toBe(403);
    // Manual testing needs no endpoint and never makes target API requests.
    const requestsBeforeManual = requests.length;
    await page.getByRole("button", { name: "+ New agent test", exact: true }).click();
    await page.getByLabel("Testing method", { exact: true }).selectOption("manual");
    await expect(page.getByLabel("Chat API URL", { exact: true })).toBeHidden();
    await page.getByLabel("Agent name", { exact: true }).fill("Manual support review");
    await page.getByLabel("Project", { exact: true }).selectOption(project.id);
    await page.getByLabel("Agent requirements", { exact: true }).fill("Help the customer with their request.");
    await page.getByRole("button", { name: "Start manual test", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Record your manual test", exact: true })).toBeVisible();
    await page.getByLabel("Observed reply 1.1", { exact: true }).fill("I can help with your account.");
    await page.getByLabel("Observed reply 1.2", { exact: true }).fill("Please open Settings to continue.");
    await page.getByRole("button", { name: "Save evidence & evaluate", exact: true }).click();
    await expect(page.locator("#agent-content")).toContainText("Manually entered evidence");
    await expect(page.getByRole("link", { name: "Export JSON", exact: true })).toBeVisible();
    expect(requests.length).toBe(requestsBeforeManual);
    const manualPlan = (await (await admin.get("/api/agent-tests")).json()).plans.find((p: { plan: { name: string } }) => p.plan.name === "Manual support review");
    expect(manualPlan.plan.endpoint).toBe("");
    expect((await admin.post(`/api/agent-tests/${manualPlan.id}/run`, { data: { revision: manualPlan.revision } })).status()).toBe(400);
    await page.screenshot({ path: "test-results/agent-testing-manual.png", fullPage: true });
    // Overview counts are live aggregates, without exposing account records.
    const counts = await (await admin.get("/api/overview/counts")).json();
    await page.getByRole("button", { name: "Workspace overview", exact: true }).click();
    await expect(page.locator(".stat-projects strong")).toHaveText(String(counts.projects));
    await expect(page.locator(".stat-users strong")).toHaveText(String(counts.users));
    await page.screenshot({ path: "test-results/overview-projects-users.png", fullPage: true });
    // Telemetry scopes calls to their owner except for site-admin workspace totals.
    const usage = [{ at: new Date().toISOString(), feature: "agent-testing", model: "fixture", username: "owner", inputTokens: 100, outputTokens: 50, costUsd: 0.001, ok: true, subject: "private-plan" }, { at: new Date().toISOString(), feature: "agent-testing", model: "fixture", username: "agent-tester", inputTokens: 20, outputTokens: 10, costUsd: 0.0002, ok: true }];
    fs.writeFileSync(path.join(process.env.STUDIO_TEST_WORKSPACE!, "ui", "data", "aiUsage.json"), JSON.stringify(usage));
    const ownUsage = await (await other.get("/api/ai/usage")).json();
    expect(ownUsage.scope).toBe("personal"); expect(ownUsage.summary.totalTokens).toBe(30); expect(JSON.stringify(ownUsage)).not.toContain("private-plan"); expect(JSON.stringify(ownUsage)).not.toContain('"owner"');
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Telemetry · AI usage", exact: true })).toBeVisible();
    await expect(page.locator("#settings-telemetry")).toContainText("180");
    await expect(page.locator("#settings-telemetry")).toContainText("agent-testing");
    await page.screenshot({ path: "test-results/settings-telemetry.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally { await other.dispose(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
});

test("password form revokes other sessions and keeps the current session", async ({ playwright, page }) => {
  const other = await playwright.request.newContext({ baseURL: "http://127.0.0.1:4187" });
  try {
    await other.post("/api/auth/login", { data: { username: "viewer", password } });
    await page.context().addCookies((await member.storageState()).cookies);
    await page.goto("/");
    await page.locator("#account-menu > summary").click();
    await page.getByRole("button", { name: "Password", exact: true }).click();
    await page.getByLabel("Current password", { exact: true }).fill(password);
    await page.getByLabel("New password", { exact: true }).fill(`${password}-new`);
    await page.getByLabel("Confirm new password", { exact: true }).fill(`${password}-new`);
    await page.getByRole("button", { name: "Update password", exact: true }).click();
    await expect(page.locator("#password-modal")).toBeHidden();
    expect((await other.get("/api/tests")).status()).toBe(401);
    expect((await page.request.get("/api/tests")).status()).toBe(200);
  } finally { await other.dispose(); }
});

test("authentication attempts are bounded with an explicit retry time", async ({ request }) => {
  let status = 0;
  for (let i = 0; i < 22; i++) {
    const response = await request.post("/api/auth/login", { data: { username: "missing", password: "incorrect" } });
    status = response.status();
    if (status === 429) {
      expect(Number(response.headers()["retry-after"])).toBeGreaterThan(0);
      break;
    }
    expect(status).toBe(401);
  }
  expect(status).toBe(429);
});
