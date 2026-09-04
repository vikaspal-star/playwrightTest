// ============================================================
// REPORTS
// ------------------------------------------------------------
// Aggregates the stored run records (./runs/<id>/run.json) into a
// summary the dashboard renders: totals, per-test and per-suite
// pass rates, a daily trend, and the most recent failures.
// ============================================================

export type RunKind = "test" | "suite";

interface StepLike {
  index: number;
  action: string;
  status: string;
  error?: string;
  testFile?: string;
}

export interface RunLike {
  id: string;
  file: string;
  name: string;
  kind?: RunKind;
  status: "running" | "passed" | "failed";
  startedAt: string;
  startedBy?: string;
  durationMs?: number;
  steps: StepLike[];
}

export interface SubjectStats {
  file: string;
  name: string;
  kind: RunKind;
  runs: number;
  finished: number;
  running: number;
  passed: number;
  failed: number;
  /** null when nothing has finished yet, so the UI can show "-" instead of a misleading 0%. */
  passRate: number | null;
  avgDurationMs: number;
  lastRunAt?: string;
  lastStatus?: string;
}

export interface UserStats {
  username: string;
  runs: number;
  finished: number;
  running: number;
  passed: number;
  failed: number;
  passRate: number | null;
  testRuns: number;
  suiteRuns: number;
  stepsExecuted: number;
  avgDurationMs: number;
  lastRunAt?: string;
  lastStatus?: string;
}

export interface ReportSummary {
  days: number;
  generatedAt: string;
  totals: {
    runs: number;
    passed: number;
    failed: number;
    running: number;
    passRate: number;
    stepsExecuted: number;
    avgDurationMs: number;
  };
  perTest: SubjectStats[];
  perSuite: SubjectStats[];
  perUser: UserStats[];
  dailyTrend: { date: string; passed: number; failed: number }[];
  recentFailures: {
    runId: string;
    file: string;
    name: string;
    kind: RunKind;
    startedAt: string;
    startedBy?: string;
    stepIndex?: number;
    action?: string;
    error?: string;
    testFile?: string;
  }[];
  topFailingSteps: { action: string; failures: number }[];
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function statsFor(runs: RunLike[], kind: RunKind): SubjectStats[] {
  const byFile = new Map<string, RunLike[]>();
  for (const run of runs) {
    if ((run.kind ?? "test") !== kind) continue;
    if (!byFile.has(run.file)) byFile.set(run.file, []);
    byFile.get(run.file)!.push(run);
  }

  const out: SubjectStats[] = [];
  for (const [file, list] of byFile) {
    const finished = list.filter(r => r.status !== "running");
    const passed = finished.filter(r => r.status === "passed").length;
    const failed = finished.filter(r => r.status === "failed").length;
    const withDuration = finished.filter(r => typeof r.durationMs === "number");
    const newest = [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    out.push({
      file,
      name: newest?.name || file,
      kind,
      runs: list.length,
      finished: finished.length,
      running: list.length - finished.length,
      passed,
      failed,
      passRate: finished.length ? Math.round((passed / finished.length) * 100) : null,
      avgDurationMs: withDuration.length
        ? Math.round(withDuration.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) / withDuration.length)
        : 0,
      lastRunAt: newest?.startedAt,
      lastStatus: newest?.status
    });
  }
  return out.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

function statsPerUser(runs: RunLike[]): UserStats[] {
  const byUser = new Map<string, RunLike[]>();
  for (const run of runs) {
    const who = run.startedBy || "unattributed";
    if (!byUser.has(who)) byUser.set(who, []);
    byUser.get(who)!.push(run);
  }

  const out: UserStats[] = [];
  for (const [username, list] of byUser) {
    const finished = list.filter(r => r.status !== "running");
    const passed = finished.filter(r => r.status === "passed").length;
    const failed = finished.filter(r => r.status === "failed").length;
    const withDuration = finished.filter(r => typeof r.durationMs === "number");
    const newest = [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    out.push({
      username,
      runs: list.length,
      finished: finished.length,
      running: list.length - finished.length,
      passed,
      failed,
      passRate: finished.length ? Math.round((passed / finished.length) * 100) : null,
      testRuns: list.filter(r => (r.kind ?? "test") === "test").length,
      suiteRuns: list.filter(r => r.kind === "suite").length,
      stepsExecuted: list.reduce(
        (sum, r) => sum + r.steps.filter(s => s.status === "passed" || s.status === "failed").length,
        0
      ),
      avgDurationMs: withDuration.length
        ? Math.round(withDuration.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) / withDuration.length)
        : 0,
      lastRunAt: newest?.startedAt,
      lastStatus: newest?.status
    });
  }
  return out.sort((a, b) => b.runs - a.runs || a.username.localeCompare(b.username));
}

export function buildReport(allRuns: RunLike[], days: number): ReportSummary {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const runs = allRuns.filter(r => Date.parse(r.startedAt) >= cutoff);

  const finished = runs.filter(r => r.status !== "running");
  const passed = finished.filter(r => r.status === "passed").length;
  const failed = finished.filter(r => r.status === "failed").length;
  const withDuration = finished.filter(r => typeof r.durationMs === "number");
  const stepsExecuted = runs.reduce(
    (sum, r) => sum + r.steps.filter(s => s.status === "passed" || s.status === "failed").length,
    0
  );

  // Daily trend, oldest first, one entry per day in the window.
  const trendMap = new Map<string, { passed: number; failed: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    trendMap.set(d, { passed: 0, failed: 0 });
  }
  for (const run of finished) {
    const key = dayKey(run.startedAt);
    const bucket = trendMap.get(key);
    if (!bucket) continue;
    if (run.status === "passed") bucket.passed++;
    else bucket.failed++;
  }

  const recentFailures = runs
    .filter(r => r.status === "failed")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 15)
    .map(run => {
      const step = run.steps.find(s => s.status === "failed");
      return {
        runId: run.id,
        file: run.file,
        name: run.name,
        kind: (run.kind ?? "test") as RunKind,
        startedAt: run.startedAt,
        startedBy: run.startedBy,
        stepIndex: step?.index,
        action: step?.action,
        error: step?.error ? step.error.split("\n")[0].slice(0, 200) : undefined,
        testFile: step?.testFile
      };
    });

  const failureByAction = new Map<string, number>();
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.status !== "failed") continue;
      failureByAction.set(step.action, (failureByAction.get(step.action) ?? 0) + 1);
    }
  }

  return {
    days,
    generatedAt: new Date().toISOString(),
    totals: {
      runs: runs.length,
      passed,
      failed,
      running: runs.filter(r => r.status === "running").length,
      passRate: finished.length ? Math.round((passed / finished.length) * 100) : 0,
      stepsExecuted,
      avgDurationMs: withDuration.length
        ? Math.round(withDuration.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) / withDuration.length)
        : 0
    },
    perTest: statsFor(runs, "test"),
    perSuite: statsFor(runs, "suite"),
    perUser: statsPerUser(runs),
    dailyTrend: [...trendMap.entries()].map(([date, v]) => ({ date, ...v })),
    recentFailures,
    topFailingSteps: [...failureByAction.entries()]
      .map(([action, failures]) => ({ action, failures }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 8)
  };
}
