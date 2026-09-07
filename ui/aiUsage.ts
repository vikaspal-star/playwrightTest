// ============================================================
// AI USAGE AND SPEND
// ------------------------------------------------------------
// Every call to the model provider is metered here: which feature
// asked for it, who triggered it, how many tokens it cost and what
// that is worth in money.
//
// Without this the AI features are an unbounded, invisible expense.
// With it a workspace can see where the spend goes, and a daily cap
// can stop a runaway loop before it becomes a bill.
//
// Token counts come from the provider's own `usage` block, so they
// are reported, not estimated. Prices are configurable because they
// change; the default is only a starting point.
// ============================================================

import path from "node:path";
import { DATA_DIR } from "./config";
import { readJson, writeJson } from "./storage";

const FILE = path.join(DATA_DIR, "aiUsage.json");

/** Keep a bounded tail: this is an operating record, not an audit log. */
const MAX_RECORDS = 2000;

/**
 * US dollars per million tokens. Override per deployment with
 * AI_PRICE_INPUT / AI_PRICE_OUTPUT, since published prices change and
 * a wrong constant silently misreports spend.
 */
const PRICE_PER_MILLION_INPUT = Number(process.env.AI_PRICE_INPUT ?? 3);
const PRICE_PER_MILLION_OUTPUT = Number(process.env.AI_PRICE_OUTPUT ?? 15);

/** Optional guard rail: 0 or unset means no cap. */
const DAILY_TOKEN_CAP = Number(process.env.AI_DAILY_TOKEN_CAP ?? 0);

export type AiFeature = "step-analysis" | "run-summary" | "environment-review" | "agent-testing";

export interface UsageRecord {
  at: string;
  feature: AiFeature;
  model: string;
  username?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** What the call was about, e.g. a run id or test file. */
  subject?: string;
  ok: boolean;
  error?: string;
}

export interface ProviderUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export function costOf(inputTokens: number, outputTokens: number): number {
  const cost =
    (inputTokens / 1_000_000) * PRICE_PER_MILLION_INPUT +
    (outputTokens / 1_000_000) * PRICE_PER_MILLION_OUTPUT;
  // Sub-cent precision matters when a single analysis is a fraction of a cent.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

function load(): UsageRecord[] {
  return readJson<UsageRecord[]>(FILE, []);
}

function save(records: UsageRecord[]): void {
  writeJson(FILE, records.slice(-MAX_RECORDS));
}

export function record(entry: {
  feature: AiFeature;
  model: string;
  username?: string;
  usage?: ProviderUsage;
  subject?: string;
  ok?: boolean;
  error?: string;
}): UsageRecord {
  const inputTokens = Math.max(0, Math.round(entry.usage?.input_tokens ?? 0));
  const outputTokens = Math.max(0, Math.round(entry.usage?.output_tokens ?? 0));

  const row: UsageRecord = {
    at: new Date().toISOString(),
    feature: entry.feature,
    model: entry.model,
    username: entry.username,
    inputTokens,
    outputTokens,
    costUsd: costOf(inputTokens, outputTokens),
    subject: entry.subject,
    ok: entry.ok !== false,
    error: entry.error ? entry.error.split("\n")[0].slice(0, 200) : undefined
  };

  const records = load();
  records.push(row);
  save(records);
  return row;
}

function since(days: number): UsageRecord[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return load().filter(r => Date.parse(r.at) >= cutoff);
}

export interface UsageSummary {
  days: number;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  byFeature: { feature: string; calls: number; totalTokens: number; costUsd: number }[];
  byUser: { username: string; calls: number; totalTokens: number; costUsd: number }[];
  byDay: { date: string; totalTokens: number; costUsd: number }[];
  cap: { dailyTokenCap: number; usedToday: number; remaining: number | null };
  pricing: { inputPerMillionUsd: number; outputPerMillionUsd: number };
}

function group<T extends string>(
  records: UsageRecord[],
  key: (r: UsageRecord) => T
): { name: T; calls: number; totalTokens: number; costUsd: number }[] {
  const map = new Map<T, { calls: number; totalTokens: number; costUsd: number }>();
  for (const r of records) {
    const k = key(r);
    const entry = map.get(k) ?? { calls: 0, totalTokens: 0, costUsd: 0 };
    entry.calls++;
    entry.totalTokens += r.inputTokens + r.outputTokens;
    entry.costUsd += r.costUsd;
    map.set(k, entry);
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v, costUsd: Math.round(v.costUsd * 1_000_000) / 1_000_000 }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export function tokensUsedToday(): number {
  const today = new Date().toISOString().slice(0, 10);
  return load()
    .filter(r => r.at.slice(0, 10) === today)
    .reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
}

/** Throws when the configured daily cap would be exceeded. */
export function assertWithinCap(): void {
  if (!DAILY_TOKEN_CAP || DAILY_TOKEN_CAP <= 0) return;
  const used = tokensUsedToday();
  if (used >= DAILY_TOKEN_CAP) {
    throw new Error(
      `The daily AI token cap of ${DAILY_TOKEN_CAP.toLocaleString()} has been reached (${used.toLocaleString()} used). ` +
      "Raise AI_DAILY_TOKEN_CAP or wait until tomorrow."
    );
  }
}

export function summary(days = 30): UsageSummary {
  const records = since(days);
  const inputTokens = records.reduce((sum, r) => sum + r.inputTokens, 0);
  const outputTokens = records.reduce((sum, r) => sum + r.outputTokens, 0);
  const costUsd = Math.round(records.reduce((sum, r) => sum + r.costUsd, 0) * 1_000_000) / 1_000_000;

  const byDayMap = new Map<string, { totalTokens: number; costUsd: number }>();
  for (const r of records) {
    const date = r.at.slice(0, 10);
    const entry = byDayMap.get(date) ?? { totalTokens: 0, costUsd: 0 };
    entry.totalTokens += r.inputTokens + r.outputTokens;
    entry.costUsd += r.costUsd;
    byDayMap.set(date, entry);
  }

  const usedToday = tokensUsedToday();

  return {
    days,
    calls: records.length,
    failedCalls: records.filter(r => !r.ok).length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    byFeature: group(records, r => r.feature).map(({ name, ...rest }) => ({ feature: name, ...rest })),
    byUser: group(records, r => (r.username ?? "unattributed") as string).map(({ name, ...rest }) => ({ username: name, ...rest })),
    byDay: [...byDayMap.entries()]
      .map(([date, v]) => ({ date, totalTokens: v.totalTokens, costUsd: Math.round(v.costUsd * 1_000_000) / 1_000_000 }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    cap: {
      dailyTokenCap: DAILY_TOKEN_CAP,
      usedToday,
      remaining: DAILY_TOKEN_CAP > 0 ? Math.max(0, DAILY_TOKEN_CAP - usedToday) : null
    },
    pricing: {
      inputPerMillionUsd: PRICE_PER_MILLION_INPUT,
      outputPerMillionUsd: PRICE_PER_MILLION_OUTPUT
    }
  };
}

export function recent(limit = 50): UsageRecord[] {
  return load().slice(-limit).reverse();
}
