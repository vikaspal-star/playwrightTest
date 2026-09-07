import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { DATA_DIR, ROOT } from "./config";
import { readJson, writeJson } from "./storage";
import { validateDesign, TestDesign } from "../src/validation";

export interface DocumentCandidate { id: string; title: string; description: string; quote: string; design: TestDesign }
export interface ProjectDocument { id: string; projectId: string; name: string; hash: string; size: number; text: string; pages?: number; revision: string; uploadedAt: string; uploadedBy: string; method: "sections" | "ai"; candidates: DocumentCandidate[] }
const base = path.join(DATA_DIR, "documents");
const safe = (id: string) => { if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw Object.assign(new Error("Invalid document identifier."), { status: 400 }); return id; };
const directory = (projectId: string) => path.join(base, safe(projectId));
const file = (projectId: string, id: string) => path.join(directory(projectId), `${safe(id)}.json`);
export function listDocuments(projectId: string): ProjectDocument[] { const dir = directory(projectId); return fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => /^[a-zA-Z0-9-]+\.json$/.test(name)).map(name => readJson<ProjectDocument>(path.join(dir, name), null as never)).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)) : []; }
export function getDocument(projectId: string, id: string): ProjectDocument { const value = readJson<ProjectDocument | null>(file(projectId, id), null); if (!value) throw Object.assign(new Error("Document not found."), { status: 404 }); return value; }
export function saveDocument(value: ProjectDocument) { writeJson(file(value.projectId, value.id), value); }
export function deleteDocument(projectId: string, id: string) { fs.unlinkSync(file(projectId, id)); }
export function draftDesign(title: string, description: string): TestDesign { return { preconditions: "Open the project environment with an appropriate test account and data.", steps: [{ instruction: `Verify: ${title}`, expected: description }] }; }
export function sectionCandidates(text: string): DocumentCandidate[] {
  // Text sections are only candidates: a tester decides which are requirements.
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 2500, text.length);
    if (end < text.length) { const boundary = text.lastIndexOf("\n\n", end); if (boundary > start + 2000) end = boundary; }
    if (text.length - end < 100) end = text.length;
    const chunk = text.slice(start, end).trim(); if (chunk) chunks.push(chunk); start = end;
  }
  return chunks.map((quote, index) => { const title = quote.split("\n").find(line => line.trim())!.replace(/^#+\s*/, "").slice(0, 140) || `Requirement ${index + 1}`; return { id: crypto.randomUUID(), title, description: quote, quote, design: draftDesign(title, quote) }; });
}
export function validateCandidates(value: unknown, document: ProjectDocument, fromAI = false): DocumentCandidate[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw Object.assign(new Error("Review between 1 and 30 requirements."), { status: 400 });
  const seen = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 160 || typeof raw.description !== "string" || !raw.description.trim() || raw.description.length > 6000) throw Object.assign(new Error("Each requirement needs a title (160 characters) and acceptance criteria (6,000 characters)."), { status: 400 });
    const source = fromAI ? null : document.candidates.find(candidate => candidate.id === raw.id);
    const quote = fromAI ? raw.quote : source?.quote;
    if (typeof quote !== "string" || quote.length < 10 || quote.length > 6000 || !document.text.includes(quote)) throw Object.assign(new Error("Each requirement must cite an exact passage from the uploaded document."), { status: 400 });
    const id = fromAI ? crypto.randomUUID() : source!.id;
    if (seen.has(id)) throw Object.assign(new Error("A requirement was selected more than once."), { status: 400 }); seen.add(id);
    return { id, title: raw.title.trim(), description: raw.description.trim(), quote, design: validateDesign(raw.design || draftDesign(raw.title, raw.description)) };
  });
}
let parsing = 0;
export async function parseUpload(name: unknown, content: unknown): Promise<{ name: string; hash: string; size: number; text: string; pages?: number }> {
  if (typeof name !== "string" || !name.trim() || name.length > 180 || /[\\/\x00-\x1f]/.test(name)) throw Object.assign(new Error("Choose a file with a plain filename up to 180 characters."), { status: 400 });
  const extension = path.extname(name).toLowerCase();
  if (![".pdf", ".docx", ".txt", ".md"].includes(extension)) throw Object.assign(new Error("Upload a PDF, DOCX, TXT or Markdown file."), { status: 400 });
  if (typeof content !== "string" || !content.length || content.length > 4194304 || content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(content)) throw Object.assign(new Error("Upload a document up to 3 MB."), { status: 400 });
  const data = Buffer.from(content, "base64");
  if (!data.length || data.length > 3 * 1024 * 1024 || data.toString("base64") !== content) throw Object.assign(new Error("Upload a document up to 3 MB with valid file content."), { status: 400 });
  if (parsing >= 2) throw Object.assign(new Error("Two documents are being read. Try again shortly."), { status: 429 });
  parsing++;
  try {
    const parsed = await new Promise<{ text: string; pages?: number }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=192", "--import", "tsx", path.join(ROOT, "ui", "documentParser.ts")], { cwd: ROOT, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = ""; let settled = false;
      const finish = (error?: Error, value?: { text: string; pages?: number }) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill(); reject(Object.assign(error, { status: 422 })); } else resolve(value!); };
      const timer = setTimeout(() => finish(new Error("Document extraction exceeded 20 seconds. Use a smaller or simpler document.")), 20000);
      child.on("error", () => finish(new Error("Document reader could not start.")));
      child.stdout.on("data", chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > 600000) finish(new Error("Extracted content is too large.")); });
      child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
      child.on("close", code => { try { const result = JSON.parse(output); if (code || result.error || typeof result.text !== "string") finish(new Error(result.error || "Document could not be read. Use an unencrypted PDF or valid DOCX.")); else finish(undefined, result); } catch { finish(new Error("Document could not be read. Use an unencrypted PDF or valid DOCX.")); } });
      child.stdin.end(JSON.stringify({ extension, base64: content }));
    });
    return { name: name.trim(), hash: crypto.createHash("sha256").update(data).digest("hex"), size: data.length, ...parsed };
  } finally { parsing--; }
}
