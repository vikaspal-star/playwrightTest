// ============================================================
// IMPORTERS
// ------------------------------------------------------------
// Turns an exported test file from somewhere else into the step
// format this framework runs. Currently understands:
//
//   - Test Studio's own format (passed straight through)
//   - Reflect exports (app.reflect.run "Export test" -> JSON)
//
// Anything it cannot map becomes a clearly-labelled skipped entry
// rather than a silently dropped step, so an import never quietly
// loses part of a test.
// ============================================================

import { validateDesign, TestDesign } from "../src/validation";
export type ImportFormat = "teststudio" | "reflect" | "unknown";

export interface ImportResult {
  format: ImportFormat;
  name: string;
  description: string;
  design?: TestDesign;
  steps: Record<string, unknown>[];
  /** Steps that had no equivalent action, kept for the caller to report. */
  skipped: { index: number; type: string; reason: string }[];
}

interface ReflectStep {
  type?: string;
  url?: string;
  title?: string;
  description?: string;
  selector?: string;
  tag?: string;
  inputText?: string;
  expectedText?: string;
  [key: string]: unknown;
}

export function detectFormat(input: unknown): ImportFormat {
  if (!input || typeof input !== "object") return "unknown";
  const obj = input as Record<string, unknown>;
  const steps = obj.steps;
  if (!Array.isArray(steps)) return "unknown";
  if (!steps.length) return "teststudio";

  const first = steps[0] as Record<string, unknown>;
  if (!first || typeof first !== "object") return "unknown";
  // Ours keys every step by "action"; Reflect keys them by "type".
  if (typeof first.action === "string") return "teststudio";
  if (typeof first.type === "string") return "reflect";
  return "unknown";
}

/**
 * Reflect's recorder emits a step per interaction. The mapping below is
 * deliberately conservative: an assertion we cannot express faithfully is
 * skipped rather than turned into something that would pass for the wrong
 * reason.
 */
type MappedStep =
  | { ok: true; step: Record<string, unknown> }
  | { ok: false; reason: string };

function mapReflectStep(step: ReflectStep): MappedStep {
  const type = String(step.type ?? "").toLowerCase();
  const note = step.description ? String(step.description) : undefined;
  const step_ = (obj: Record<string, unknown>): MappedStep => ({ ok: true, step: note ? { ...obj, note } : obj });
  const skip = (reason: string): MappedStep => ({ ok: false, reason });

  switch (type) {
    case "browser-navigate":
    case "navigate":
      if (!step.url) return skip("no url on the navigate step");
      return step_({ action: "navigate", url: step.url });

    case "browser-url-changed":
      if (!step.url) return skip("no url on the url-changed step");
      return step_({ action: "browser-url-changed", url: step.url });

    case "click":
      if (!step.selector) return skip("no selector on the click step");
      return step_({ action: "click", selector: step.selector });

    case "double-click":
      if (!step.selector) return skip("no selector on the double-click step");
      return step_({ action: "double-click", selector: step.selector });

    case "hover":
      if (!step.selector) return skip("no selector on the hover step");
      return step_({ action: "hover", selector: step.selector });

    case "input":
    case "type":
      if (!step.selector) return skip("no selector on the input step");
      return step_({
        action: "fill",
        selector: step.selector,
        value: step.inputText !== undefined ? String(step.inputText) : ""
      });

    case "select":
      if (!step.selector) return skip("no selector on the select step");
      return step_({
        action: "select",
        selector: step.selector,
        value: step.inputText !== undefined ? String(step.inputText) : ""
      });

    // Presence cannot prove visual equivalence; report unsupported assertions explicitly.
    case "visual-validation":
      return skip("visual validation needs a baseline image and has no faithful equivalent");

    case "assert-text":
    case "text-validation":
      if (step.selector && step.expectedText) {
        return step_({
          action: "element-text-contains",
          selector: step.selector,
          text: String(step.expectedText)
        });
      }
      if (step.expectedText) return step_({ action: "text-visible", text: String(step.expectedText) });
      return skip("text validation without a selector or expected text");

    case "scroll":
      if (typeof step.x !== "number" && typeof step.y !== "number") return skip("scroll has no recorded coordinates");
      return step_({ action: "scroll", ...(typeof step.x === "number" ? { x: step.x } : {}), ...(typeof step.y === "number" ? { y: step.y } : {}) });

    case "key-press":
    case "keypress":
      if (!step.expectedText && !step.inputText) return skip("key press without a key");
      return step_({ action: "keyboard-press", key: String(step.expectedText ?? step.inputText) });

    case "wait":
      if (typeof step.timeout !== "number" || step.timeout <= 0) return skip("wait has no recorded positive timeout");
      return step_({ action: "wait", timeout: step.timeout });

    default:
      return skip(`unsupported Reflect step type "${step.type}"`);
  }
}

export function importTest(input: unknown): ImportResult {
  const format = detectFormat(input);
  if (format === "unknown") {
    throw new Error('Unrecognized file. Expected a Test Studio export or a Reflect export (an object with a "steps" array).');
  }

  const obj = input as Record<string, unknown>;
  const rawSteps = obj.steps as unknown[];
  const name = typeof obj.name === "string" ? obj.name : "";
  const description = typeof obj.description === "string" ? obj.description : "";

  if (format === "teststudio") {
    const steps = rawSteps.filter(
      s => s && typeof s === "object" && typeof (s as Record<string, unknown>).action === "string"
    ) as Record<string, unknown>[];
    return {
      format,
      name,
      description,
      ...(obj.design !== undefined ? { design: validateDesign(obj.design) } : {}),
      steps,
      skipped: rawSteps.length - steps.length
        ? [{ index: 0, type: "unknown", reason: `${rawSteps.length - steps.length} entries had no "action" and were dropped` }]
        : []
    };
  }

  const steps: Record<string, unknown>[] = [];
  const skipped: ImportResult["skipped"] = [];

  rawSteps.forEach((raw, i) => {
    const step = (raw ?? {}) as ReflectStep;
    const mapped = mapReflectStep(step);
    if (!mapped.ok) {
      skipped.push({ index: i + 1, type: String(step.type ?? "?"), reason: mapped.reason });
      return;
    }
    steps.push(mapped.step);
  });

  return { format, name, description, steps, skipped };
}
