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
