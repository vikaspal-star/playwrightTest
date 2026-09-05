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
  await page.locator("#confirm-input").fill("editor-test.json");
  await page.locator("#confirm-ok").click();
  await page.getByRole("button", { name: "+ Add step", exact: true }).click();
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
  await expect(page.getByRole("heading", { name: /^Test library/ })).toBeVisible();
  const partner = page.getByRole("button", { name: `Open test ${name}`, exact: true });
  await expect(partner).toBeVisible();
  await page.getByRole("button", { name: `Collapse folder ${folder}`, exact: true }).click();
  await expect(partner).toHaveCount(0);
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
  await page.getByRole("button", { name: "← Test library", exact: true }).click();
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
