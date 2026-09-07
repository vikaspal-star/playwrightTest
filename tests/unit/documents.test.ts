import test from "node:test";
import assert from "node:assert/strict";
import { parseUpload, sectionCandidates, validateCandidates, ProjectDocument } from "../../ui/documents";
import { validateTest } from "../../src/validation";
import { importTest } from "../../ui/importers";
import { pdfFixture, docxFixture, requirementText } from "../document-fixtures";

test("document readers extract actual PDF, DOCX, Markdown and UTF-16 text", { timeout: 30000 }, async () => {
  for (const [name, data] of [["requirements.pdf", pdfFixture()], ["requirements.docx", docxFixture()], ["requirements.md", Buffer.from(requirementText)], ["requirements.txt", Buffer.concat([Buffer.from([255, 254]), Buffer.from(requirementText, "utf16le")])]] as const) {
    const result = await parseUpload(name, data.toString("base64"));
    assert.ok(result.text.includes(requirementText), name); assert.equal(result.size, data.length); assert.equal(result.hash.length, 64);
    if (name.endsWith("pdf")) assert.equal(result.pages, 1);
  }
});
test("uploads reject malformed, oversized, empty and unsupported documents", { timeout: 30000 }, async () => {
  for (const [name, data, error] of [["bad.pdf", Buffer.from("not a pdf"), /valid PDF/], ["bad.docx", Buffer.from("PKbroken"), /read|zip|central|signature/i], ["scan.pdf", pdfFixture("", 2), /No usable text/], ["long.pdf", pdfFixture(requirementText, 41), /40 pages/], ["long.txt", Buffer.from("a".repeat(60001)), /60,000/]] as const) await assert.rejects(parseUpload(name, data.toString("base64")), error);
  await assert.rejects(parseUpload("../escape.txt", "aaaa"), /filename/);
  await assert.rejects(parseUpload("macro.docm", "aaaa"), /DOCX/);
  await assert.rejects(parseUpload("big.txt", Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64")), /3 MB/);
  await assert.rejects(parseUpload("bad.txt", "a===a==="), /valid file content/);
});
test("review validates exact source passages and test designs without inventing runnable steps", () => {
  const candidates = sectionCandidates(requirementText);
  const document = { text: requirementText, candidates } as ProjectDocument;
  assert.equal(validateCandidates(candidates, document)[0].quote, requirementText);
  assert.throws(() => validateCandidates([{ ...candidates[0], quote: "This behavior was never documented" }], document, true), /exact passage/);
  assert.throws(() => validateCandidates([{ ...candidates[0], id: "forged" }], document), /exact passage/);
  assert.throws(() => validateCandidates([candidates[0], candidates[0]], document), /more than once/);
  assert.throws(() => validateCandidates([{ ...candidates[0], design: { preconditions: "", steps: [] } }], document), /Test design/);
  const draft = { name: "Login", design: candidates[0].design, steps: [] };
  assert.deepEqual(validateTest(draft).design, draft.design);
  assert.deepEqual(importTest(draft).design, draft.design);
  assert.throws(() => validateTest(draft, true), /at least one step/);
  for (const length of [2501, 60000]) { const text = "Requirement paragraph.\n\n".repeat(3000).slice(0, length); const rows = sectionCandidates(text); assert.ok(rows.length <= 30); assert.equal(validateCandidates(rows, { text, candidates: rows } as ProjectDocument).length, rows.length); }
});
