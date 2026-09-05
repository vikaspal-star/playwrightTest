// ============================================================
// RECORDER
// ------------------------------------------------------------
// Opens a real browser at a URL and turns what you do in it into
// test steps. A capture script is injected into every page; it
// reports clicks, typing, selects, and key presses back to Node,
// where they become the same JSON steps the editor produces.
//
// The browser is headed on purpose: you drive it, watch the steps
// appear in Test Studio, then keep the ones you want.
// ============================================================

import crypto from "crypto";
import { chromium, devices } from "playwright";

export interface RecordedStep {
  action: string;
  selector?: string;
  url?: string;
  value?: string;
  key?: string;
  note?: string;
  /** Set when the recorder is unsure the selector is stable. */
  fragile?: boolean;
  at: string;
}

export interface RecordingSession {
  id: string;
  url: string;
  startedBy: string;
  startedAt: string;
  status: "recording" | "stopped";
  steps: RecordedStep[];
  error?: string;
}

interface InternalSession extends RecordingSession {
  close: () => Promise<void>;
  listeners: Set<(step: RecordedStep) => void>;
  onEnd: Set<() => void>;
}

const sessions = new Map<string, InternalSession>();

/**
 * Runs inside the page. Builds the most stable selector it can for an
 * element and reports interactions. Kept dependency-free and defensive:
 * a recorder that throws inside the page would break the page itself.
 */
export function captureScript(): void {
  const w = window as unknown as {
    __tsRecordBound?: boolean;
    __tsRecord?: (payload: Record<string, unknown>) => void;
  };
  if (w.__tsRecordBound) return;
  w.__tsRecordBound = true;

  const send = (payload: Record<string, unknown>) => {
    try {
      if (typeof w.__tsRecord === "function") w.__tsRecord(payload);
    } catch {
      /* never let recording break the page */
    }
  };

  const cssEscape = (value: string): string =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");

  const isUnique = (selector: string): boolean => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };

  const describe = (el: Element): string => {
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ");
    const tag = el.tagName.toLowerCase();
    return label ? `${tag} "${label.slice(0, 40)}"` : tag;
  };

  // Preference order: id, test ids, name, aria-label, unique class, text for
  // buttons and links, then a structural path as a last resort.
  const selectorFor = (el: Element): { selector: string; fragile: boolean } => {
    if (el.id && isUnique(`#${cssEscape(el.id)}`)) {
      return { selector: `#${cssEscape(el.id)}`, fragile: false };
    }

    for (const attr of ["data-testid", "data-test-id", "data-test", "data-qa"]) {
      const value = el.getAttribute(attr);
      if (value) {
        const sel = `[${attr}="${value}"]`;
        if (isUnique(sel)) return { selector: sel, fragile: false };
      }
    }

    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute("name");
    if (name) {
      const sel = `${tag}[name="${name}"]`;
      if (isUnique(sel)) return { selector: sel, fragile: false };
    }

    const aria = el.getAttribute("aria-label");
    if (aria) {
      const sel = `${tag}[aria-label="${aria}"]`;
      if (isUnique(sel)) return { selector: sel, fragile: false };
    }

    const placeholder = el.getAttribute("placeholder");
    if (placeholder) {
      const sel = `${tag}[placeholder="${placeholder}"]`;
      if (isUnique(sel)) return { selector: sel, fragile: false };
    }

    const classes = Array.from(el.classList).filter(c => !/^(ng-|is-|has-|active$|selected$)/.test(c));
    if (classes.length) {
      const sel = `${tag}.${classes.map(cssEscape).join(".")}`;
      if (isUnique(sel)) return { selector: sel, fragile: false };
    }

    // Text-based XPath for the things people actually click.
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (text && text.length <= 40 && /^(a|button|span|li|td|label|h1|h2|h3)$/.test(tag)) {
      const xpath = `//${tag}[normalize-space()='${text.replace(/'/g, "")}']`;
      return { selector: xpath, fragile: false };
    }

    // Structural fallback: nth-of-type chain, stable enough to replay but
    // brittle against layout changes, so flag it.
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      const nodeTag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      const parent: Element | null = node.parentElement;
      if (!parent) {
        parts.unshift(nodeTag);
        break;
      }
      const siblings = Array.from(parent.children).filter(c => c.tagName === node!.tagName);
      const index = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${nodeTag}:nth-of-type(${index})` : nodeTag);
      node = parent;
    }
    return { selector: parts.join(" > "), fragile: true };
  };

  const interesting = (el: Element | null): Element | null => {
    if (!el) return null;
    // Prefer the actionable ancestor over an inner icon or span.
    const actionable = el.closest("a,button,input,select,textarea,[role=button],[onclick],label");
    return actionable ?? el;
  };

  document.addEventListener(
    "click",
    event => {
      const target = interesting(event.target as Element);
      if (!target) return;
      // Typing is captured on change; a click into a field is noise.
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const { selector, fragile } = selectorFor(target);
      send({ action: "click", selector, fragile, note: `Click ${describe(target)}` });
    },
    true
  );

  document.addEventListener(
    "change",
    event => {
      const target = event.target as HTMLInputElement | HTMLSelectElement | null;
      if (!target || !target.tagName) return;
      const { selector, fragile } = selectorFor(target);
      const tag = target.tagName;

      if (tag === "SELECT") {
        send({ action: "select", selector, value: target.value, fragile, note: `Select in ${describe(target)}` });
        return;
      }

      const input = target as HTMLInputElement;
      if (input.type === "checkbox") {
        send({
          action: input.checked ? "check" : "uncheck",
          selector,
          fragile,
          note: `${input.checked ? "Check" : "Uncheck"} ${describe(target)}`
        });
        return;
      }
      if (input.type === "radio") {
        send({ action: "check", selector, fragile, note: `Choose ${describe(target)}` });
        return;
      }
      // Passwords are recorded as a step but never with their value.
      if (input.type === "password") {
        send({ action: "fill", selector, value: "", fragile, note: "Fill password (value not recorded)" });
        return;
      }
      if (input.value !== "") {
        send({ action: "fill", selector, value: input.value, fragile, note: `Fill ${describe(target)}` });
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    event => {
      if (event.key !== "Enter" && event.key !== "Escape" && event.key !== "Tab") return;
      send({ action: "keyboard-press", key: event.key, note: `Press ${event.key}` });
    },
    true
  );
}

export function get(id: string): RecordingSession | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  const { close: _c, listeners: _l, onEnd: _e, ...view } = session;
  return view;
}

export function listFor(username: string): RecordingSession[] {
  return [...sessions.values()]
    .filter(s => s.startedBy === username)
    .map(({ close: _c, listeners: _l, onEnd: _e, ...view }) => view);
}

export function subscribe(id: string, onStep: (step: RecordedStep) => void, onEnd: () => void): () => void {
  const session = sessions.get(id);
  if (!session) return () => {};
  session.listeners.add(onStep);
  session.onEnd.add(onEnd);
  return () => {
    session.listeners.delete(onStep);
    session.onEnd.delete(onEnd);
  };
}

/** Launch a headed browser at `url` and start turning interactions into steps. */
export async function start(url: string, startedBy: string): Promise<RecordingSession> {
  const id = crypto.randomBytes(6).toString("hex");
  // Headed by default - you drive the browser. RECORDER_HEADLESS=1 is for
  // machines with no display (and for testing the pipeline itself).
  const headless = process.env.RECORDER_HEADLESS === "1";
  const browser = await chromium.launch({
    headless,
    args: headless ? [] : ["--start-maximized"]
  });
  // Headed: let the real window size drive the viewport. Playwright rejects
  // deviceScaleFactor alongside a null viewport, so drop it in that case.
  const profile = devices["Desktop Chrome"];
  const { deviceScaleFactor: _scale, viewport: _viewport, ...profileRest } = profile;
  const context = await browser.newContext(
    headless ? { ...profile } : { ...profileRest, viewport: null }
  );
  const page = await context.newPage();

  const session: InternalSession = {
    id,
    url,
    startedBy,
    startedAt: new Date().toISOString(),
    status: "recording",
    steps: [],
    listeners: new Set(),
    onEnd: new Set(),
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  };
  sessions.set(id, session);

  const push = (step: Omit<RecordedStep, "at">): void => {
    if (session.status !== "recording") return;
    const entry: RecordedStep = { ...step, at: new Date().toISOString() };

    // Collapse consecutive fills on the same field so typing does not produce
    // a step per keystroke-driven change event.
    const last = session.steps[session.steps.length - 1];
    if (
      last && entry.action === "fill" && last.action === "fill" &&
      last.selector === entry.selector
    ) {
      session.steps[session.steps.length - 1] = entry;
    } else {
      session.steps.push(entry);
    }

    for (const listener of session.listeners) listener(entry);
  };

  await context.exposeBinding("__tsRecord", (_source, payload: Record<string, unknown>) => {
    const action = String(payload.action ?? "");
    if (!action) return;
    push({
      action,
      selector: payload.selector ? String(payload.selector) : undefined,
      value: payload.value !== undefined ? String(payload.value) : undefined,
      key: payload.key ? String(payload.key) : undefined,
      note: payload.note ? String(payload.note) : undefined,
      fragile: Boolean(payload.fragile)
    });
  });

  // tsx compiles this file with esbuild, which wraps inner functions in a
  // __name() helper. That helper does not exist in the browser, so the
  // serialized init script would throw before binding any listener. Define a
  // no-op shim first, injected as a raw string so esbuild cannot rewrite it.
  await context.addInitScript({ content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };" });
  await context.addInitScript(captureScript);

  // Record navigations for the main frame only, so in-page iframes do not
  // produce spurious steps.
  page.on("framenavigated", frame => {
    if (frame !== page.mainFrame()) return;
    const to = frame.url();
    if (!to || to === "about:blank") return;
    const last = session.steps[session.steps.length - 1];
    if (last && (last.action === "navigate" || last.action === "browser-url-changed") && last.url === to) return;
    push({
      action: session.steps.length ? "browser-url-changed" : "navigate",
      url: to,
      note: session.steps.length ? "URL changed" : "Open the starting URL"
    });
  });

  // Closing the browser window ends the recording.
  page.on("close", () => {
    if (session.status === "recording") void stop(id);
  });

  await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e: unknown) => {
    session.error = e instanceof Error ? e.message : String(e);
  });

  return get(id)!;
}

export async function stop(id: string): Promise<RecordingSession | undefined> {
  const session = sessions.get(id);
  if (!session) return undefined;
  if (session.status === "stopped") return get(id);
  session.status = "stopped";
  await session.close();
  for (const end of session.onEnd) end();
  const view = get(id);
  // Keep the steps around briefly so the UI can collect them after stopping.
  setTimeout(() => sessions.delete(id), 5 * 60 * 1000).unref();
  return view;
}

export async function stopAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map(id => stop(id)));
}

/** Strip recorder-only fields, leaving steps the runner understands. */
export function toTestSteps(steps: RecordedStep[]): Record<string, unknown>[] {
  return steps.map(step => {
    const out: Record<string, unknown> = { action: step.action };
    if (step.selector) out.selector = step.selector;
    if (step.url) out.url = step.url;
    if (step.value !== undefined) out.value = step.value;
    if (step.key) out.key = step.key;
    if (step.note) out.note = step.note;
    return out;
  });
}
