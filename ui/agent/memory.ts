// ============================================================
// AGENT MEMORY
// ------------------------------------------------------------
// What the studio has learned about the pages it drives, kept
// per selector rather than per run.
//
// `ui/learning.ts` answers "how did this run compare to history".
// This answers "what do we know about this element": how reliably
// its selector resolves, which other selectors have pointed at the
// same thing, and how it was described when it was recorded. That
// is what makes a repair proposal defensible rather than a guess.
//
// Storage is a plain JSON document. It is derived knowledge: losing
// it costs accuracy, never correctness, so it is safe to delete.
// ============================================================

import path from "node:path";
import { DATA_DIR } from "../config";
import { readJson, writeJson } from "../storage";

const FILE = path.join(DATA_DIR, "agentMemory.json");

/** Keep the tail bounded so one noisy test cannot grow the file without limit. */
const MAX_OUTCOMES = 40;
const MAX_ALIASES = 12;

export interface SelectorOutcome {
  at: string;
  runId: string;
  ok: boolean;
  /** First line only: enough to classify, not a whole stack. */
  error?: string;
}

export interface SelectorKnowledge {
  /** Test file this selector belongs to. */
  test: string;
  stepIndex: number;
  action: string;
  selector: string;
  /** How the recorder described the element, e.g. `button "Sign in"`. */
  description?: string;
  outcomes: SelectorOutcome[];
  /** Other selectors confirmed to resolve to the same element. */
  aliases: string[];
  /** Set when a repair was proposed and accepted. */
  healedFrom?: string;
  healedAt?: string;
}

type MemoryFile = Record<string, SelectorKnowledge>;

function keyFor(test: string, stepIndex: number, selector: string): string {
  return `${test}#${stepIndex}#${selector}`;
}

function load(): MemoryFile {
  return readJson<MemoryFile>(FILE, {});
}

function save(memory: MemoryFile): void {
  writeJson(FILE, memory);
}

/** Record how a selector behaved on one step of one run. */
export function recordOutcome(entry: {
  test: string;
  stepIndex: number;
  action: string;
  selector: string;
  description?: string;
  runId: string;
  ok: boolean;
  error?: string;
}): void {
  const memory = load();
  const key = keyFor(entry.test, entry.stepIndex, entry.selector);
  const existing = memory[key] ?? {
    test: entry.test,
    stepIndex: entry.stepIndex,
    action: entry.action,
    selector: entry.selector,
    outcomes: [],
    aliases: []
  };

  existing.action = entry.action;
  if (entry.description) existing.description = entry.description;
  existing.outcomes.push({
    at: new Date().toISOString(),
    runId: entry.runId,
    ok: entry.ok,
    error: entry.error ? entry.error.split("\n")[0].slice(0, 200) : undefined
  });
  if (existing.outcomes.length > MAX_OUTCOMES) {
    existing.outcomes = existing.outcomes.slice(-MAX_OUTCOMES);
  }

  memory[key] = existing;
  save(memory);
}

/** Note that another selector resolves to the same element. */
export function recordAlias(test: string, stepIndex: number, selector: string, alias: string): void {
  if (alias === selector) return;
  const memory = load();
  const key = keyFor(test, stepIndex, selector);
  const existing = memory[key];
  if (!existing) return;
  if (!existing.aliases.includes(alias)) {
    existing.aliases = [alias, ...existing.aliases].slice(0, MAX_ALIASES);
    save(memory);
  }
}

/** Record that a selector was repaired, so the new one inherits the history. */
export function recordHeal(test: string, stepIndex: number, from: string, to: string): void {
  const memory = load();
  const oldKey = keyFor(test, stepIndex, from);
  const newKey = keyFor(test, stepIndex, to);
  const previous = memory[oldKey];

  memory[newKey] = {
    test,
    stepIndex,
    action: previous?.action ?? "",
    selector: to,
    description: previous?.description,
    // The new selector starts with a clean record; the old history stays under
    // its own key so a repair cannot make a flaky step look healthy.
    outcomes: [],
    aliases: previous ? [from, ...previous.aliases].slice(0, MAX_ALIASES) : [from],
    healedFrom: from,
    healedAt: new Date().toISOString()
  };
  save(memory);
}

export function get(test: string, stepIndex: number, selector: string): SelectorKnowledge | undefined {
  return load()[keyFor(test, stepIndex, selector)];
}

export function forTest(test: string): SelectorKnowledge[] {
  return Object.values(load())
    .filter(k => k.test === test)
    .sort((a, b) => a.stepIndex - b.stepIndex);
}

export interface SelectorHealth {
  selector: string;
  stepIndex: number;
  action: string;
  description?: string;
  runs: number;
  failures: number;
  failureRate: number;
  lastError?: string;
  aliases: string[];
  healedFrom?: string;
  /** True when the recent tail is failing, which is what makes a repair worth proposing. */
  failingNow: boolean;
}

export function health(test: string): SelectorHealth[] {
  return forTest(test).map(k => {
    const runs = k.outcomes.length;
    const failures = k.outcomes.filter(o => !o.ok).length;
    const recent = k.outcomes.slice(-3);
    return {
      selector: k.selector,
      stepIndex: k.stepIndex,
      action: k.action,
      description: k.description,
      runs,
      failures,
      failureRate: runs ? Math.round((failures / runs) * 100) : 0,
      lastError: [...k.outcomes].reverse().find(o => !o.ok)?.error,
      aliases: k.aliases,
      healedFrom: k.healedFrom,
      failingNow: recent.length > 0 && recent.every(o => !o.ok)
    };
  });
}

/** Drop everything learned about a test, e.g. when it is deleted or rewritten. */
export function forget(test: string): void {
  const memory = load();
  let changed = false;
  for (const [key, value] of Object.entries(memory)) {
    if (value.test === test) {
      delete memory[key];
      changed = true;
    }
  }
  if (changed) save(memory);
}
