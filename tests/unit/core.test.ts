import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateTest } from "../../src/validation";
import { importTest } from "../../ui/importers";
import { readJson, writeJson } from "../../ui/storage";
import { buildKnowledge, LearnRun } from "../../ui/learning";

test("validation canonicalizes aliases and preserves intentional empty input values", () => {
  const result = validateTest({ steps: [{ action: " GOTO ", url: "https://example.com" }, { action: "fill", selector: "#name", value: "" }, { action: "wait", timeout: "10" }] }, true);
  assert.equal(result.steps[0].action, "navigate");
  assert.equal(result.steps[1].value, "");
  assert.equal(result.steps[2].timeout, 10);
});

test("validation rejects invalid steps and empty executions with actionable errors", () => {
  for (const step of [null, [], { action: "unknown" }, { action: "click" }, { action: "wait", timeout: -1 }, { action: "wait", timeout: "Infinity" }, { action: "wait", timeout: true }, { action: "click", selector: "#a", locatorType: "unsafe" }, { action: "navigate", url: "https://" }, { action: "navigate", url: "file:///etc/passwd" }]) {
    assert.throws(() => validateTest({ steps: [step] }), /Step 1/);
  }
  assert.deepEqual(validateTest({ steps: [] }).steps, []);
  assert.throws(() => validateTest({ steps: [] }, true), /at least one step/);
  assert.throws(() => validateTest(null), /object/);
});

test("Reflect visual assertions are reported, never silently weakened", () => {
  const imported = importTest({ steps: [{ type: "navigate", url: "https://example.com" }, { type: "visual-validation", selector: "#hero" }] });
  assert.equal(imported.steps.length, 1);
  assert.equal(imported.skipped[0].index, 2);
  assert.match(imported.skipped[0].reason, /baseline/);
  assert.throws(() => importTest({ steps: [null] }), /Unrecognized/);
  const incomplete = importTest({ steps: [{ type: "scroll" }, { type: "wait" }] });
  assert.equal(incomplete.steps.length, 0);
  assert.equal(incomplete.skipped.length, 2);
});

test("storage distinguishes first boot from corrupt data and replaces complete files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmqa-storage-"));
  try {
    const file = path.join(dir, "users.json");
    assert.deepEqual(readJson(file, []), []);
    writeJson(file, [{ username: "owner" }]);
    assert.deepEqual(readJson(file, []), [{ username: "owner" }]);
    fs.writeFileSync(file, "{");
    assert.throws(() => readJson(file, []), /Restore a valid backup/);
    assert.equal(fs.readdirSync(dir).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("running work does not dilute pass rate and alternating results indicate flakiness", () => {
  const runs: LearnRun[] = ["passed", "failed", "passed", "running"].map((status, index) => ({ id: String(index), file: "smoke.json", name: "Smoke", status: status as LearnRun["status"], startedAt: new Date(2026, 8, index + 1).toISOString(), durationMs: 100, steps: [] }));
  const knowledge = buildKnowledge("smoke.json", runs);
  assert.equal(knowledge.finishedRuns, 3);
  assert.equal(knowledge.passed, 2);
  assert.equal(knowledge.flakinessScore, 100);
});

test("AI spend is metered from reported tokens, priced, and capped", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mmqa-usage-"));
  const previous = { ws: process.env.STUDIO_WORKSPACE, cap: process.env.AI_DAILY_TOKEN_CAP };
  process.env.STUDIO_WORKSPACE = workspace;
  process.env.AI_DAILY_TOKEN_CAP = "2000";
  try {
    // Loaded after the workspace is set so it writes into the temp directory.
    const usage = require("../../ui/aiUsage") as typeof import("../../ui/aiUsage");

    // Cost comes from the provider's own token counts, not an estimate.
    const row = usage.record({
      feature: "step-analysis",
      model: "test-model",
      username: "sageer",
      usage: { input_tokens: 1000, output_tokens: 500 }
    });
    assert.equal(row.inputTokens, 1000);
    assert.equal(row.outputTokens, 500);
    assert.equal(row.costUsd, usage.costOf(1000, 500));
    assert.ok(row.costUsd > 0, "a call that used tokens must cost something");

    // A failed call still consumed input tokens, so it is still recorded.
    usage.record({ feature: "run-summary", model: "test-model", username: "priya", ok: false, error: "timeout" });

    const summary = usage.summary(30);
    assert.equal(summary.calls, 2);
    assert.equal(summary.failedCalls, 1);
    assert.equal(summary.totalTokens, 1500);
    assert.deepEqual(summary.byUser.map(u => u.username).sort(), ["priya", "sageer"]);

    // 1500 of a 2000 cap is still spendable.
    usage.assertWithinCap();

    // Crossing it stops further spending rather than letting a loop run away.
    usage.record({ feature: "agent-testing", model: "test-model", usage: { input_tokens: 600, output_tokens: 0 } });
    assert.equal(usage.tokensUsedToday(), 2100);
    assert.throws(() => usage.assertWithinCap(), /daily AI token cap/);
  } finally {
    if (previous.ws === undefined) delete process.env.STUDIO_WORKSPACE; else process.env.STUDIO_WORKSPACE = previous.ws;
    if (previous.cap === undefined) delete process.env.AI_DAILY_TOKEN_CAP; else process.env.AI_DAILY_TOKEN_CAP = previous.cap;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
