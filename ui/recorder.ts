// ============================================================
// RECORDER
// ------------------------------------------------------------
// Opens a real browser at a URL and turns what you do in it into
// test steps. A capture script is injected into every page; it
// reports clicks, typing, selects, and key presses back to Node,
// where they become the same JSON steps the editor produces.
//
// The embedded browser streams into Studio; a separate headed
// browser remains available when explicitly requested.
// ============================================================

import crypto from "crypto";
import { chromium, devices, Page } from "playwright";
import * as screencast from "./agent/screencast";

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
  page: Page;
  queue: Promise<unknown>;
  frame?: Promise<{ image: string; width: number; height: number; url: string }>;
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
      if (!target || /^(HTML|BODY)$/.test(target.tagName)) return;
      // Typing is captured on change; a click into a field is noise.
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const { selector, fragile } = selectorFor(target);
      send({ action: "click", selector, fragile, note: `Click ${describe(target)}` });
    },
    true
  );

  for (const [eventName, action] of [["dblclick", "double-click"], ["contextmenu", "right-click"]]) {
    document.addEventListener(eventName, event => {
      const target = interesting(event.target as Element);
      if (!target || /^(HTML|BODY)$/.test(target.tagName)) return;
      const { selector, fragile } = selectorFor(target);
      send({ action, selector, fragile, note: `${action} ${describe(target)}` });
    }, true);
  }

  const lastValues = new WeakMap<Element, string>();
  const recordValue = (event: Event) => {
      const target = event.target as HTMLInputElement | HTMLSelectElement | null;
      if (!target || !target.tagName) return;
      const signature = `${target.value}:${(target as HTMLInputElement).checked}`;
      if (lastValues.get(target) === signature) return;
      lastValues.set(target, signature);
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
      if (tag === "INPUT" || tag === "TEXTAREA") {
        send({ action: "fill", selector, value: input.value, fragile, note: `Fill ${describe(target)}` });
      }
    };
  document.addEventListener("input", recordValue, true);
  document.addEventListener("change", recordValue, true);

  document.addEventListener(
    "keydown",
    event => {
      if (event.key !== "Enter" && event.key !== "Escape" && event.key !== "Tab") return;
      send({ action: "keyboard-press", key: event.shiftKey ? `Shift+${event.key}` : event.key, note: `Press ${event.key}` });
    },
    true
  );
}

export function get(id: string): RecordingSession | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  const { close: _c, listeners: _l, onEnd: _e, page: _p, queue: _q, frame: _f, ...view } = session;
  return view;
}

export function listFor(username: string): RecordingSession[] {
  return [...sessions.values()]
    .filter(s => s.startedBy === username)
    .map(session => get(session.id)!);
}

export function currentUrl(id: string): string | undefined {
  return sessions.get(id)?.page.url();
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

/** Launch the browser at `url` and start turning interactions into steps. */
let launching = 0;
export async function start(url: string, startedBy: string, options: { embedded?: boolean } = {}): Promise<RecordingSession> {
  const embedded = options.embedded !== false && process.env.RECORDER_HEADLESS !== "0";
  if ([...sessions.values()].filter(s => s.status === "recording").length + launching >= 2) throw new Error("Two recordings are already open. Stop one before starting another.");
  launching++;
  try { return await launch(url, startedBy, embedded); } finally { launching--; }
}
async function launch(url: string, startedBy: string, embedded: boolean): Promise<RecordingSession> {
  const id = crypto.randomBytes(6).toString("hex");
  // Embed by default; an explicitly headed session can still be driven directly.
  const headless = embedded || process.env.RECORDER_HEADLESS === "1";
  const browser = await chromium.launch({
    headless,
    args: headless ? [] : ["--start-maximized"]
  });
  // Headed: let the real window size drive the viewport. Playwright rejects
  // deviceScaleFactor alongside a null viewport, so drop it in that case.
  const profile = devices["Desktop Chrome"];
  const { deviceScaleFactor: _scale, viewport: _viewport, ...profileRest } = profile;
  const context = await browser.newContext(
    headless ? { ...profile, viewport: { width: 1280, height: 800 } } : { ...profileRest, viewport: null }
  );
  const page = await context.newPage();

  const session: InternalSession = {
    page,
    queue: Promise.resolve(),
    id,
    url,
    startedBy,
    startedAt: new Date().toISOString(),
    status: "recording",
    steps: [],
    listeners: new Set(),
    onEnd: new Set(),
    close: async () => {
      await screencast.stop(id).catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  };
  sessions.set(id, session);

  const push = (step: Omit<RecordedStep, "at">): void => {
    if (session.status !== "recording") return;
    const entry: RecordedStep = { ...step, at: new Date().toISOString() };

    if (entry.action === "double-click") {
      for (let i = 0; i < 2; i++) {
        const prior = session.steps[session.steps.length - 1];
        if (prior?.action !== "click" || prior.selector !== entry.selector || Date.now() - Date.parse(prior.at) > 1500) break;
        session.steps.pop();
      }
    }

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

  await context.exposeBinding("__tsRecord", (source, payload: Record<string, unknown>) => {
    if (source.frame !== source.page.mainFrame()) {
      session.error = "An interaction inside an iframe needs a manual frame-switch step before replay.";
      return;
    }
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
  const watchPage = (current: Page) => {
  current.on("framenavigated", frame => {
    if (frame !== current.mainFrame() || session.page !== current) return;
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
  current.on("close", () => {
    if (session.status !== "recording") return;
    const remaining = context.pages().find(p => p !== current && !p.isClosed());
    if (remaining) { session.page = remaining; void screencast.start(id, remaining).catch(() => {}); }
    else void stop(id);
  });
  };
  watchPage(page);
  context.on("page", current => {
    session.page = current;
    void screencast.start(id, current).catch(() => {});
    session.error = "A new tab opened. Review browser-switch steps before replaying this recording.";
    watchPage(current);
  });

  await screencast.start(id, page).catch(() => {});
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e: unknown) => {
    session.error = e instanceof Error ? e.message : String(e);
  });

  return get(id)!;
}

function activeSession(id: string): InternalSession {
  const session = sessions.get(id);
  if (!session || session.status !== "recording") throw new Error("This recording has stopped.");
  return session;
}

/** One shared in-flight capture per recording prevents overlapping screenshot work. */
export async function screen(id: string) {
  const session = activeSession(id);
  const streamed = screencast.latest(id);
  if (streamed && streamed.width > 0 && streamed.height > 0) {
    return { image: streamed.data, width: streamed.width, height: streamed.height, url: session.page.url() };
  }
  if (!session.frame) session.frame = (async () => {
    const page = session.page;
    const size = page.viewportSize() || { width: 1280, height: 800 };
    const buffer = await page.screenshot({ type: "jpeg", quality: 65, timeout: 3000 });
    return { image: buffer.toString("base64"), ...size, url: page.url() };
  })().finally(() => { session.frame = undefined; });
  return session.frame;
}

/** All remote input is validated by the HTTP layer and serialized for event ordering. */
export async function input(id: string, action: { type: string; x?: number; y?: number; deltaY?: number; key?: string; text?: string; url?: string; button?: "left" | "right"; clickCount?: number; normalized?: boolean }) {
  const session = activeSession(id);
  const work = session.queue.then(async () => {
    activeSession(id);
    const page = session.page;
    const size = page.viewportSize() || { width: 1280, height: 800 };
    const x = action.x! * (action.normalized ? size.width - 1 : 1);
    const y = action.y! * (action.normalized ? size.height - 1 : 1);
    if (action.type === "click") await page.mouse.click(x, y, { button: action.button, clickCount: action.clickCount });
    if (action.type === "move") await page.mouse.move(x, y);
    if (action.type === "wheel") {
      if (action.x !== undefined && action.y !== undefined) await page.mouse.move(x, y);
      await page.mouse.wheel(0, action.deltaY!);
    }
    if (action.type === "key") await page.keyboard.press(action.key!);
    if (action.type === "text") await page.keyboard.insertText(action.text!);
    if (action.type === "navigate") await page.goto(action.url!, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (action.type === "blur") await page.locator(":focus").evaluateAll(elements => elements.forEach(element => (element as HTMLElement).blur()));
    if (action.type === "screenshot") {
      const step = { action: "screenshot", note: "Capture the application screen", at: new Date().toISOString() };
      session.steps.push(step);
      for (const listener of session.listeners) listener(step);
    }
  });
  session.queue = work.catch(() => {});
  await work;
}

export async function stop(id: string): Promise<RecordingSession | undefined> {
  const session = sessions.get(id);
  if (!session) return undefined;
  if (session.status === "stopped") return get(id);
  await session.queue;
  await session.page.locator(":focus").evaluateAll(elements => elements.forEach(element => (element as HTMLElement).blur())).catch(() => {});
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
