import crypto from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "./config";
import { readJson, writeJson } from "./storage";

export interface Requirement {
  id: string; projectId: string; title: string; description: string;
  status: "draft" | "approved"; tests: string[]; revision: string; updatedAt: string; updatedBy: string;
  source?: { documentId: string; candidateId: string; name: string; quote: string };
  design?: import("../src/validation").TestDesign;
}
const FILE = path.join(DATA_DIR, "requirements.json");
export function listRequirements(): Requirement[] { return readJson<Requirement[]>(FILE, []); }
export function saveRequirements(rows: Requirement[]): void { writeJson(FILE, rows); }
export function requirementInput(raw: unknown): Pick<Requirement, "title" | "description" | "status" | "tests"> {
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("Requirement must be an object.");
  const value = raw as Record<string, unknown>;
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 160) return invalid("Enter a requirement title up to 160 characters.");
  if (typeof value.description !== "string" || value.description.length > 12000) return invalid("Requirement details must be text up to 12000 characters.");
  if (value.status !== "draft" && value.status !== "approved") return invalid("Choose Draft or Approved.");
  if (!Array.isArray(value.tests) || value.tests.length > 200 || value.tests.some(t => typeof t !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json$/.test(t) || t.includes(".."))) return invalid("Link up to 200 valid test files.");
  return { title: value.title.trim(), description: value.description.trim(), status: value.status, tests: [...new Set(value.tests as string[])] };
}
export function newRequirement(projectId: string, raw: unknown, username: string): Requirement {
  return { ...requirementInput(raw), id: crypto.randomUUID(), projectId, revision: crypto.randomUUID(), updatedAt: new Date().toISOString(), updatedBy: username };
}
