import { FIELD_META, findAction } from "./actionCatalog";

export class ValidationError extends Error {
  readonly status = 400;
}

const numeric = new Set(["timeout", "x", "y"]);
const emptyAllowed = new Set(["value", "text", "message", "promptText"]);

export interface TestDesign { preconditions: string; steps: { instruction: string; expected: string }[]; requirementId?: string }
export function validateDesign(value: unknown): TestDesign {
  const input = value as TestDesign;
  if (!input || typeof input !== "object" || typeof input.preconditions !== "string" || input.preconditions.length > 3000 || !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 12 || input.steps.some(step => !step || typeof step.instruction !== "string" || !step.instruction.trim() || step.instruction.length > 3000 || typeof step.expected !== "string" || !step.expected.trim() || step.expected.length > 6000)) throw new ValidationError("Test design needs preconditions and 1–12 actions with expected results.");
  if (input.requirementId !== undefined && (typeof input.requirementId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(input.requirementId))) throw new ValidationError("Invalid requirement reference.");
  return { preconditions: input.preconditions, steps: input.steps.map(step => ({ instruction: step.instruction, expected: step.expected })), ...(input.requirementId ? { requirementId: input.requirementId } : {}) };
}

/** Catalog validation shared by the API and CLI. Drafts can be empty; executions cannot. */
export function validateTest(body: unknown, runnable = false): { name?: string; description?: string; design?: TestDesign; steps: Record<string, unknown>[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Test must be an object.");
  const input = body as Record<string, unknown>;
  if (!Array.isArray(input.steps)) throw new ValidationError("steps must be an array.");
  if (input.steps.length > 2000) throw new ValidationError("A test can contain at most 2000 steps.");
  if (runnable && !input.steps.length) throw new ValidationError("Add at least one step before running.");
  for (const key of ["name", "description"]) {
    if (input[key] !== undefined && typeof input[key] !== "string") throw new ValidationError(`${key} must be text.`);
  }
  const steps = input.steps.map((raw, index) => {
    const fail = (message: string): never => { throw new ValidationError(`Step ${index + 1}: ${message}`); };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("must be an object.");
    const step = raw as Record<string, unknown>;
    const spec = typeof step.action === "string" ? findAction(step.action.trim()) : undefined;
    if (!spec) return fail("choose an action from the catalog.");
    const clean: Record<string, unknown> = { action: spec.action };
    for (const [key, value] of Object.entries(step)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) return fail(`invalid field ${key}.`);
      if (key === "action" || value === undefined || value === null) continue;
      if (value === "" && !emptyAllowed.has(key)) continue;
      if (numeric.has(key)) {
        if (typeof value !== "number" && typeof value !== "string") return fail(`${key} must be a number.`);
        const number = Number(value);
        if (!Number.isFinite(number)) return fail(`${key} must be a finite number.`);
        if (key === "timeout" && (!Number.isInteger(number) || number <= 0 || number > 600000)) return fail("timeout must be between 1 and 600000 ms.");
        clean[key] = number;
      } else {
        if (typeof value !== "string" && !(key === "fragile" && typeof value === "boolean")) return fail(`${key} must be text.`);
        const meta = FIELD_META[key as keyof typeof FIELD_META];
        if (meta?.options && !meta.options.includes(String(value))) return fail(`invalid ${key}.`);
        clean[key] = value;
      }
    }
    for (const key of spec.required) {
      if (!(key in clean) || (!emptyAllowed.has(key) && String(clean[key]).trim() === "")) return fail(`${key} is required for ${spec.action}.`);
    }
    if (["navigate", "wait-for-url", "browser-url-changed", "url-not-match", "url-contains"].includes(spec.action) && typeof clean.url !== "string") return fail("url is required.");
    if (spec.action === "navigate") {
      try {
        const url = new URL(String(clean.url));
        if (!["http:", "https:"].includes(url.protocol)) return fail("navigation URL must use http:// or https://.");
      } catch { return fail("enter a complete URL starting with http:// or https://."); }
    }
    return clean;
  });
  return {
    ...(input.design !== undefined ? { design: validateDesign(input.design) } : {}),
    ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim() } : {}),
    ...(typeof input.description === "string" && input.description.trim() ? { description: input.description.trim() } : {}),
    steps
  };
}
