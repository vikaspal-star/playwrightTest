import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BrowserContext, Page, Request } from "playwright";
import AxeBuilder from "@axe-core/playwright";

export interface CaptureOptions { video: boolean; accessibility: boolean }
export function captureOptions(value: unknown): CaptureOptions {
  if (value === undefined) return { video: true, accessibility: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("Capture options must be an object."), { status: 400 });
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!["video", "accessibility"].includes(key) || typeof input[key] !== "boolean") throw Object.assign(new Error("Choose boolean video and accessibility capture options."), { status: 400 });
  return { video: input.video !== false, accessibility: input.accessibility === true };
}

/** Network evidence intentionally excludes credentials, query values, headers and bodies. */
export function evidenceUrl(value: string): string {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? `${url.origin}${url.pathname}`.slice(0, 1500) : url.protocol; }
  catch { return "(invalid URL)"; }
}
export function evidenceText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/g, url => evidenceUrl(url))
    .replace(/(["']?(?:authorization|password|secret|token|api[-_]?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+[^\s,;]+|[^\s,;}]+)/gi, "$1[redacted]").slice(0, 2000);
}
export interface NetworkEntry { id: number; step: number; at: number; method: string; url: string; type: string; status?: number; durationMs?: number; error?: string }
export interface Diagnostics {
  version: number; capturedAt: string; options: CaptureOptions;
  videos: string[];
  configuration: { browser: string; browserVersion: string; os: string; node: string; viewport: { width: number; height: number } | null };
  console: { step: number; at: number; level: string; text: string; url: string }[];
  network: NetworkEntry[];
  performance: { step: number; url: string; ttfbMs: number | null; domContentLoadedMs: number | null; loadMs: number | null }[];
  accessibility: { testFile: string; url: string; status: "complete" | "error"; error?: string; violations?: { id: string; impact: string | null; help: string; helpUrl: string; targets: string[]; affectedNodes: number }[]; incomplete?: number; passed?: number; engine?: string }[];
  omitted: { console: number; network: number; performance: number; accessibility: number };
}

export class RunDiagnostics {
  readonly data: Diagnostics;
  private step = 0;
  private started = Date.now();
  private requests = new WeakMap<Request, { row: NetworkEntry; started: number }>();
  private cleanups: (() => void)[] = [];
  private active = true;
  constructor(private context: BrowserContext, private dir: string, options: CaptureOptions) {
    this.data = { version: 1, capturedAt: new Date().toISOString(), options, videos: [],
      configuration: { browser: context.browser()?.browserType().name() || "unknown", browserVersion: context.browser()?.version() || "unknown", os: `${os.platform()} ${os.release()}`, node: process.version, viewport: null },
      console: [], network: [], performance: [], accessibility: [], omitted: { console: 0, network: 0, performance: 0, accessibility: 0 } };
    const onPage = (page: Page) => this.watchPage(page);
    const onRequest = (request: Request) => {
      if (!this.active) return;
      if (this.data.network.length >= 500) { this.data.omitted.network++; return; }
      const row: NetworkEntry = { id: this.data.network.length + 1, step: this.step, at: Date.now() - this.started, method: request.method(), url: evidenceUrl(request.url()), type: request.resourceType() };
      this.data.network.push(row); this.requests.set(request, { row, started: Date.now() });
    };
    const onResponse = (response: import("playwright").Response) => { const entry = this.requests.get(response.request()); if (entry) entry.row.status = response.status(); };
    const onFinish = (request: Request) => { const entry = this.requests.get(request); if (entry) { entry.row.durationMs = Math.max(0, Date.now() - entry.started); if (request.failure()) entry.row.error = evidenceText(request.failure()!.errorText); } };
    context.on("page", onPage); context.on("request", onRequest); context.on("response", onResponse); context.on("requestfinished", onFinish); context.on("requestfailed", onFinish);
    this.cleanups.push(() => { context.off("page", onPage); context.off("request", onRequest); context.off("response", onResponse); context.off("requestfinished", onFinish); context.off("requestfailed", onFinish); });
    context.pages().forEach(onPage); this.save();
  }
  private watchPage(page: Page) {
    if (!this.active) return;
    void page.video()?.path().then(file => { if (path.resolve(path.dirname(file)).toLowerCase() === path.resolve(this.dir, "media").toLowerCase()) { this.data.videos.push(`media/${path.basename(file)}`); this.save(); } }).catch(() => {});
    const add = (level: string, text: string, url: string) => {
      if (!this.active) return;
      if (this.data.console.length >= 500) { this.data.omitted.console++; return; }
      this.data.console.push({ step: this.step, at: Date.now() - this.started, level, text: evidenceText(text), url: evidenceUrl(url) });
    };
    const onConsole = (message: import("playwright").ConsoleMessage) => add(message.type(), message.text(), message.location().url || page.url());
    const onError = (error: Error) => add("pageerror", error.message, page.url());
    page.on("console", onConsole); page.on("pageerror", onError);
    this.cleanups.push(() => { page.off("console", onConsole); page.off("pageerror", onError); });
  }
  beginStep(index: number) { this.step = index; }
  async afterStep(page: Page) {
    this.data.configuration.viewport = page.viewportSize();
    if (this.data.performance.length >= 200) { this.data.omitted.performance++; this.save(); return; }
    try {
      const timings = await page.evaluate(() => {
        const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        if (!entry) return null;
        return { ttfbMs: entry.responseStart > 0 ? Math.round(entry.responseStart - entry.requestStart) : null, domContentLoadedMs: entry.domContentLoadedEventEnd > 0 ? Math.round(entry.domContentLoadedEventEnd) : null, loadMs: entry.loadEventEnd > 0 ? Math.round(entry.loadEventEnd) : null };
      });
      if (timings) this.data.performance.push({ step: this.step, url: evidenceUrl(page.url()), ...timings });
    } catch { /* Closed or navigating pages have no timing sample. */ }
    this.save();
  }
  async audit(page: Page, testFile: string) {
    if (!this.data.options.accessibility) return;
    if (this.data.accessibility.length >= 10) { this.data.omitted.accessibility++; return; }
    const url = evidenceUrl(page.url());
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.active = false; // Audit traffic must not be counted as application traffic.
    try {
      const result = await Promise.race([
        new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Accessibility scan exceeded 15 seconds.")), 15000); })
      ]);
      this.data.accessibility.push({ testFile, url, status: "complete", engine: `axe-core ${result.testEngine.version}`, passed: result.passes.length, incomplete: result.incomplete.length,
        violations: result.violations.slice(0, 100).map(v => ({ id: v.id, impact: v.impact || null, help: v.help, helpUrl: v.helpUrl, affectedNodes: v.nodes.length, targets: v.nodes.slice(0, 10).map(n => JSON.stringify(n.target).slice(0, 1000)) })) });
    } catch (error) { this.data.accessibility.push({ testFile, url, status: "error", error: evidenceText(error instanceof Error ? error.message : String(error)) }); }
    finally { clearTimeout(timer); this.active = true; this.save(); }
  }
  finish() { this.active = false; this.cleanups.forEach(fn => fn()); this.save(); }
  private save() {
    try { fs.mkdirSync(this.dir, { recursive: true }); const target = path.join(this.dir, "diagnostics.json"); fs.writeFileSync(`${target}.tmp`, JSON.stringify(this.data)); fs.renameSync(`${target}.tmp`, target); }
    catch { /* Diagnostic storage must not change the functional verdict. */ }
  }
}
