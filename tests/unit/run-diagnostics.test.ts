import test from "node:test";
import assert from "node:assert/strict";
import { captureOptions, evidenceText, evidenceUrl, RunDiagnostics } from "../../src/runDiagnostics";
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("diagnostic capture rejects ambiguous options and removes URL credentials and query secrets", () => {
  assert.deepEqual(captureOptions(undefined), { video: true, accessibility: false });
  assert.deepEqual(captureOptions({ video: false, accessibility: true }), { video: false, accessibility: true });
  for (const value of [null, [], "all", { video: "false" }, { headers: true }]) assert.throws(() => captureOptions(value));
  assert.equal(evidenceUrl("https://user:private@example.com/api/orders?token=private#private"), "https://example.com/api/orders");
  assert.equal(evidenceUrl("data:text/plain,private"), "data:");
  const text = evidenceText('password=private token:private api_key=private https://example.com/path?private {"password":"private with spaces"} Authorization: Bearer private');
  assert.ok(!text.includes("private"));
  assert.ok(text.includes("https://example.com/path"));
});

test("a noisy page has bounded evidence and a closed-page audit is recorded as an error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmqa-diagnostics-"));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("https://diagnostics.test/**", route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Local fixture</title><p>Ready</p>" }));
    const collector = new RunDiagnostics(context, dir, { video: false, accessibility: true });
    const page = await context.newPage(); collector.beginStep(1);
    await page.goto("https://diagnostics.test/");
    await page.evaluate(async () => {
      for (let i = 0; i < 530; i++) console.log(`diagnostic line ${i}`);
      for (let offset = 0; offset < 520; offset += 20) await Promise.all(Array.from({ length: 20 }, (_, i) => fetch(`/api/${offset + i}?token=private`)));
    });
    await collector.afterStep(page);
    assert.equal(collector.data.console.length, 500);
    assert.equal(collector.data.omitted.console, 30);
    assert.equal(collector.data.network.length, 500);
    assert.equal(collector.data.omitted.network, 21);
    assert.ok(!JSON.stringify(collector.data.network).includes("private"));
    await page.close(); await collector.audit(page, "fixture.json"); collector.finish();
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "diagnostics.json"), "utf8"));
    assert.equal(stored.accessibility[0].status, "error");
    assert.equal(stored.network.length, 500);
  } finally {
    await browser.close();
    if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith("mmqa-diagnostics-")) fs.rmSync(dir, { recursive: true });
  }
});
