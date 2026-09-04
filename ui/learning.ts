// ============================================================
// LEARNING
// ------------------------------------------------------------
// Turns run history into things worth telling someone after a run:
// which steps keep breaking, whether a failure is new or familiar,
// whether a test is flaky, and whether it just got slower.
//
// Storage-agnostic on purpose: it takes run records as input, so it
// works off the JSON files today and off Postgres when that is up.
// Everything is derived, so history can be recomputed at any time.
// ============================================================

export interface LearnStep {
  index: number;
  action: string;
  status: string;
  durationMs?: number;
  error?: string;
  testFile?: string;
}

export interface LearnRun {
  id: string;
  file: string;
  name: string;
  kind?: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  startedBy?: string;
  durationMs?: number;
  steps: LearnStep[];
}

export type InsightLevel = "good" | "warn" | "bad" | "info";

export interface Insight {
  level: InsightLevel;
  title: string;
  detail: string;
}

export interface StepKnowledge {
  index: number;
  action: string;
  runsSeen: number;
  failures: number;
  failureRate: number;
  lastError?: string;
  avgDurationMs: number;
}

export interface Knowledge {
  file: string;
  totalRuns: number;
  finishedRuns: number;
  passed: number;
  failed: number;
  passRate: number | null;
  /** Consecutive same-status finished runs, newest first. */
  streak: { status: string; length: number } | null;
  /** Alternations between pass and fail over the finished history, 0-100. */
  flakinessScore: number;
  avgDurationMs: number;
  medianDurationMs: number;
  fragileSteps: StepKnowledge[];
  firstSeenAt?: string;
  lastRunAt?: string;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Aggregate everything learned about one test or suite from its run history. */
export function buildKnowledge(file: string, history: LearnRun[]): Knowledge {
  const ordered = [...history].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const finished = ordered.filter(r => r.status !== "running");
  const passed = finished.filter(r => r.status === "passed").length;
  const failed = finished.filter(r => r.status === "failed").length;

  // Streak: how many newest finished runs share the same status.
  let streak: Knowledge["streak"] = null;
  if (finished.length) {
    const status = finished[0].status;
    let length = 0;
    for (const run of finished) {
      if (run.status !== status) break;
      length++;
    }
    streak = { status, length };
  }

  // Flakiness: how often the result flips between consecutive runs. A test that
  // alternates pass/fail/pass scores high; one that is steadily red scores 0.
  let flips = 0;
  for (let i = 1; i < finished.length; i++) {
    if (finished[i].status !== finished[i - 1].status) flips++;
  }
  const flakinessScore = finished.length > 1 ? Math.round((flips / (finished.length - 1)) * 100) : 0;

  // Per-step knowledge, keyed by position + action so a renamed step starts fresh.
  const stepMap = new Map<string, StepKnowledge & { durations: number[] }>();
  for (const run of finished) {
    for (const step of run.steps) {
      if (step.status !== "passed" && step.status !== "failed") continue;
      const key = `${step.index}:${step.action}`;
      let entry = stepMap.get(key);
      if (!entry) {
        entry = {
          index: step.index, action: step.action, runsSeen: 0, failures: 0,
          failureRate: 0, avgDurationMs: 0, durations: []
        };
        stepMap.set(key, entry);
      }
      entry.runsSeen++;
      if (step.status === "failed") {
        entry.failures++;
        entry.lastError = step.error ?? entry.lastError;
      }
      if (typeof step.durationMs === "number") entry.durations.push(step.durationMs);
    }
  }

  const fragileSteps = [...stepMap.values()]
    .map(e => ({
      index: e.index,
      action: e.action,
      runsSeen: e.runsSeen,
      failures: e.failures,
      failureRate: e.runsSeen ? Math.round((e.failures / e.runsSeen) * 100) : 0,
      lastError: e.lastError,
      avgDurationMs: mean(e.durations)
    }))
    .filter(e => e.failures > 0)
    .sort((a, b) => b.failures - a.failures || b.failureRate - a.failureRate)
    .slice(0, 5);

  const durations = finished
    .map(r => r.durationMs)
    .filter((d): d is number => typeof d === "number");

  return {
    file,
    totalRuns: ordered.length,
    finishedRuns: finished.length,
    passed,
    failed,
    passRate: finished.length ? Math.round((passed / finished.length) * 100) : null,
    streak,
    flakinessScore,
    avgDurationMs: mean(durations),
    medianDurationMs: median(durations),
    fragileSteps,
    firstSeenAt: ordered.length ? ordered[ordered.length - 1].startedAt : undefined,
    lastRunAt: ordered.length ? ordered[0].startedAt : undefined
  };
}

/**
 * What this particular run tells us, given everything before it.
 * `history` should include the run itself; it is filtered out here.
 */
export function insightsForRun(run: LearnRun, history: LearnRun[]): Insight[] {
  const previous = history
    .filter(r => r.id !== run.id && r.status !== "running")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const insights: Insight[] = [];

  if (!previous.length) {
    insights.push({
      level: "info",
      title: "First recorded run",
      detail: "Nothing to compare against yet. From the next run on, Test Studio will flag new failures, flakiness, and slowdowns here."
    });
    return insights;
  }

  const knowledge = buildKnowledge(run.file, previous);

  // --- Failures: is this new, or something we have seen before? ---
  const failedSteps = run.steps.filter(s => s.status === "failed");
  for (const step of failedSteps) {
    const priorSameStep = previous.flatMap(r =>
      r.steps.filter(s => s.index === step.index && s.action === step.action)
    );
    const priorFailures = priorSameStep.filter(s => s.status === "failed").length;

    if (priorFailures === 0) {
      insights.push({
        level: "bad",
        title: `New failure at step ${step.index} (${step.action})`,
        detail: priorSameStep.length
          ? `This step passed in each of the last ${priorSameStep.length} run${priorSameStep.length === 1 ? "" : "s"}, so something changed recently.`
          : "This step has no history yet, so treat it as a fresh problem."
      });
    } else {
      const rate = Math.round((priorFailures / priorSameStep.length) * 100);
      insights.push({
        level: "warn",
        title: `Known problem at step ${step.index} (${step.action})`,
        detail: `Already failed in ${priorFailures} of the previous ${priorSameStep.length} runs (${rate}%). Worth fixing the step or the product bug behind it rather than re-running.`
      });
    }
  }

  // --- Recovery ---
  if (run.status === "passed" && knowledge.streak && knowledge.streak.status === "failed") {
    insights.push({
      level: "good",
      title: "Back to passing",
      detail: `This run recovered after ${knowledge.streak.length} consecutive failure${knowledge.streak.length === 1 ? "" : "s"}.`
    });
  }

  // --- Flakiness ---
  if (knowledge.finishedRuns >= 4 && knowledge.flakinessScore >= 50) {
    insights.push({
      level: "warn",
      title: `Flaky: result flips ${knowledge.flakinessScore}% of the time`,
      detail: `Across the last ${knowledge.finishedRuns} runs the outcome changed repeatedly. Hard waits and timing-sensitive selectors are the usual cause.`
    });
  }

  // --- Duration drift ---
  if (typeof run.durationMs === "number" && knowledge.medianDurationMs > 0) {
    const delta = run.durationMs - knowledge.medianDurationMs;
    const pct = Math.round((delta / knowledge.medianDurationMs) * 100);
    if (pct >= 30) {
      insights.push({
        level: "warn",
        title: `${pct}% slower than usual`,
        detail: `Took ${Math.round(run.durationMs / 1000)}s against a typical ${Math.round(knowledge.medianDurationMs / 1000)}s across ${knowledge.finishedRuns} runs.`
      });
    } else if (pct <= -30) {
      insights.push({
        level: "good",
        title: `${Math.abs(pct)}% faster than usual`,
        detail: `Took ${Math.round(run.durationMs / 1000)}s against a typical ${Math.round(knowledge.medianDurationMs / 1000)}s.`
      });
    }
  }

  // --- Long-standing fragile steps, even on a green run ---
  const stillFragile = knowledge.fragileSteps.filter(
    s => s.failureRate >= 40 && !failedSteps.some(f => f.index === s.index)
  );
  if (stillFragile.length) {
    const worst = stillFragile[0];
    insights.push({
      level: "info",
      title: `Step ${worst.index} (${worst.action}) has a history of failing`,
      detail: `It passed this time but has failed ${worst.failures} of ${worst.runsSeen} recorded runs (${worst.failureRate}%). Keep an eye on it.`
    });
  }

  // --- Steady green ---
  if (run.status === "passed" && !insights.length && knowledge.streak?.status === "passed") {
    insights.push({
      level: "good",
      title: `Stable: ${knowledge.streak.length + 1} passes in a row`,
      detail: `Consistent with the previous ${knowledge.finishedRuns} recorded runs. Median duration ${Math.round(knowledge.medianDurationMs / 1000)}s.`
    });
  }

  return insights;
}

// ------------------------------------------------------------
// Per-run report: what this run actually spent its time on
// ------------------------------------------------------------

export interface RunReport {
  runId: string;
  file: string;
  name: string;
  kind: string;
  status: string;
  startedAt: string;
  startedBy?: string;
  finishedAt?: string;
  /** Wall-clock time for the whole run. */
  durationMs?: number;
  /** Time actually accounted for by steps (excludes startup/teardown). */
  stepTimeMs: number;
  counts: { total: number; passed: number; failed: number; skipped: number; pending: number };
  passRate: number | null;
  slowestSteps: { index: number; action: string; durationMs: number; share: number; testFile?: string }[];
  timeByAction: { action: string; totalMs: number; count: number; share: number }[];
  /** Suite runs only: a row per test in the chain. */
  perTest: { file: string; total: number; passed: number; failed: number; skipped: number; durationMs: number }[];
  failures: { index: number; action: string; error?: string; testFile?: string }[];
}

export function buildRunReport(run: LearnRun): RunReport {
  const steps = run.steps;
  const counts = {
    total: steps.length,
    passed: steps.filter(s => s.status === "passed").length,
    failed: steps.filter(s => s.status === "failed").length,
    skipped: steps.filter(s => s.status === "skipped").length,
    pending: steps.filter(s => s.status === "pending" || s.status === "running").length
  };
  const executed = counts.passed + counts.failed;
  const stepTimeMs = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

  const slowestSteps = steps
    .filter(s => typeof s.durationMs === "number" && s.durationMs > 0)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 5)
    .map(s => ({
      index: s.index,
      action: s.action,
      durationMs: s.durationMs ?? 0,
      share: stepTimeMs ? Math.round(((s.durationMs ?? 0) / stepTimeMs) * 100) : 0,
      testFile: s.testFile
    }));

  const byAction = new Map<string, { totalMs: number; count: number }>();
  for (const s of steps) {
    if (typeof s.durationMs !== "number") continue;
    const entry = byAction.get(s.action) ?? { totalMs: 0, count: 0 };
    entry.totalMs += s.durationMs;
    entry.count++;
    byAction.set(s.action, entry);
  }
  const timeByAction = [...byAction.entries()]
    .map(([action, v]) => ({
      action,
      totalMs: v.totalMs,
      count: v.count,
      share: stepTimeMs ? Math.round((v.totalMs / stepTimeMs) * 100) : 0
    }))
    .sort((a, b) => b.totalMs - a.totalMs);

  const perTestMap = new Map<string, { total: number; passed: number; failed: number; skipped: number; durationMs: number }>();
  for (const s of steps) {
    if (!s.testFile) continue;
    const entry = perTestMap.get(s.testFile) ?? { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 };
    entry.total++;
    if (s.status === "passed") entry.passed++;
    else if (s.status === "failed") entry.failed++;
    else if (s.status === "skipped") entry.skipped++;
    entry.durationMs += s.durationMs ?? 0;
    perTestMap.set(s.testFile, entry);
  }

  return {
    runId: run.id,
    file: run.file,
    name: run.name,
    kind: run.kind ?? "test",
    status: run.status,
    startedAt: run.startedAt,
    startedBy: run.startedBy,
    durationMs: run.durationMs,
    stepTimeMs,
    counts,
    passRate: executed ? Math.round((counts.passed / executed) * 100) : null,
    slowestSteps,
    timeByAction,
    perTest: [...perTestMap.entries()].map(([file, v]) => ({ file, ...v })),
    failures: steps
      .filter(s => s.status === "failed")
      .map(s => ({ index: s.index, action: s.action, error: s.error, testFile: s.testFile }))
  };
}
