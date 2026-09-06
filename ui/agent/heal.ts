// ============================================================
// SELF-HEALING SELECTORS
// ------------------------------------------------------------
// When a step fails because its selector no longer resolves, this
// looks at the live page and proposes a replacement.
//
// It proposes; it does not silently rewrite. A test that passes
// because the agent clicked something else is worse than a test
// that fails honestly, so a repair is only applied when a person
// accepts it (or when auto-apply is explicitly switched on for a
// test). Every proposal carries the evidence it was based on.
// ============================================================

import type { Page } from "playwright";

export interface HealCandidate {
  selector: string;
  /** 0-100. How closely this element matches what the step was aiming at. */
  confidence: number;
  reasons: string[];
  /** Visible text, trimmed, for the person reviewing the proposal. */
  text?: string;
  tag: string;
}

export interface HealProposal {
  stepIndex: number;
  action: string;
  originalSelector: string;
  /** Why the original failed: missing entirely, or matching several elements. */
  failure: "not-found" | "ambiguous" | "not-actionable";
  matchCount: number;
  candidates: HealCandidate[];
  at: string;
}

export interface HealContext {
  stepIndex: number;
  action: string;
  selector: string;
  /** How the element was described when recorded, e.g. `button "Sign in"`. */
  description?: string;
  /** Selectors previously seen to resolve to the same element. */
  aliases?: string[];
  /** Value the step types, which helps identify the right field. */
  value?: string;
}

/**
 * Runs in the page. Scores visible, interactive elements against what the
 * broken step was trying to reach and returns the best few with a selector
 * for each. Kept self-contained: it is serialized into the browser.
 */
function findCandidates(context: {
  description?: string;
  action: string;
  originalSelector: string;
}): { selector: string; confidence: number; reasons: string[]; text: string; tag: string }[] {
  const cssEscape = (value: string): string =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");

  const isUnique = (selector: string): boolean => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };

  const selectorFor = (el: Element): string | null => {
    if (el.id && isUnique(`#${cssEscape(el.id)}`)) return `#${cssEscape(el.id)}`;
    for (const attr of ["data-testid", "data-test-id", "data-test", "data-qa"]) {
      const value = el.getAttribute(attr);
      if (value && isUnique(`[${attr}="${value}"]`)) return `[${attr}="${value}"]`;
    }
    const tag = el.tagName.toLowerCase();
    for (const attr of ["name", "aria-label", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (value && isUnique(`${tag}[${attr}="${value}"]`)) return `${tag}[${attr}="${value}"]`;
    }
    const classes = Array.from(el.classList).filter(c => !/^(ng-|is-|has-|active$|selected$)/.test(c));
    if (classes.length) {
      const sel = `${tag}.${classes.map(cssEscape).join(".")}`;
      if (isUnique(sel)) return sel;
    }
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (text && text.length <= 40 && /^(a|button|span|li|td|label|h1|h2|h3)$/.test(tag)) {
      return `//${tag}[normalize-space()='${text.replace(/'/g, "")}']`;
    }
    return null;
  };

  // What was the step aiming at? The recorder's description carries the tag and
  // the visible label, e.g. `button "Sign in"`.
  const described = (context.description || "").toLowerCase();
  const quoted = /"([^"]+)"/.exec(context.description || "");
  const wantedText = (quoted ? quoted[1] : "").toLowerCase().trim();
  const wantedTag = (/^([a-z0-9]+)/.exec(described.replace(/^(click|fill|select|check|uncheck|choose|hover)\s+/, "")) || [])[1];

  // Fragments of the original selector still carry intent even when it no
  // longer resolves: #btnLogin suggests something login-ish.
  const selectorWords = (context.originalSelector.match(/[A-Za-z][A-Za-z0-9]+/g) || [])
    .flatMap(w => w.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/\s+/))
    .filter(w => w.length > 2 && !["div", "span", "the", "and", "xpath", "normalize", "space"].includes(w));

  const interactive = Array.from(
    document.querySelectorAll<HTMLElement>("a,button,input,select,textarea,[role=button],[onclick],label,li,td,span,h1,h2,h3")
  );

  const results: { selector: string; confidence: number; reasons: string[]; text: string; tag: string }[] = [];
  const seen = new Set<string>();

  for (const el of interactive) {
    const rect = el.getBoundingClientRect();
    // Invisible elements cannot be what a person clicked.
    if (rect.width < 2 || rect.height < 2) continue;

    const selector = selectorFor(el);
    if (!selector || seen.has(selector)) continue;

    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || text).toLowerCase();

    let confidence = 0;
    const reasons: string[] = [];

    if (wantedText) {
      if (label === wantedText) {
        confidence += 55;
        reasons.push(`label matches the recorded text "${wantedText}"`);
      } else if (label.includes(wantedText) || wantedText.includes(label)) {
        confidence += 32;
        reasons.push(`label is close to the recorded text "${wantedText}"`);
      }
    }

    if (wantedTag && tag === wantedTag) {
      confidence += 18;
      reasons.push(`same element type (${tag}) as recorded`);
    }

    const matchedWords = selectorWords.filter(w => selector.toLowerCase().includes(w) || label.includes(w));
    if (matchedWords.length) {
      confidence += Math.min(24, matchedWords.length * 12);
      reasons.push(`shares "${matchedWords.slice(0, 3).join('", "')}" with the original selector`);
    }

    // A typing step must land on something typable.
    if (/^(fill|type|clear)$/.test(context.action)) {
      if (tag === "input" || tag === "textarea") {
        confidence += 20;
        reasons.push("accepts text input");
      } else {
        confidence -= 40;
      }
    }
    if (/^(click|double-click|right-click)$/.test(context.action) && /^(a|button)$/.test(tag)) {
      confidence += 10;
      reasons.push("is a clickable control");
    }
    if (context.action === "select" && tag !== "select") confidence -= 40;

    // A stable selector is worth more than a positional one.
    if (selector.startsWith("#") || selector.startsWith("[data-")) {
      confidence += 12;
      reasons.push("resolves by a stable id or test id");
    }

    if (confidence <= 20) continue;
    seen.add(selector);
    results.push({ selector, confidence: Math.min(100, confidence), reasons, text, tag });
  }

  return results.sort((a, b) => b.confidence - a.confidence).slice(0, 5);
}

/**
 * Look at the live page and work out what the broken step should point at.
 * Returns null when the selector is actually fine, so callers can tell a
 * selector problem from a genuine product failure.
 */
export async function proposeRepair(page: Page, context: HealContext): Promise<HealProposal | null> {
  const selector = context.selector;
  if (!selector) return null;

  let matchCount = 0;
  try {
    matchCount = await page.locator(selector).count();
  } catch {
    // An unparseable selector counts as not found.
    matchCount = 0;
  }

  // The element is there and unambiguous, so the failure was not the selector.
  // Say so rather than proposing a change that would mask a real bug.
  if (matchCount === 1) return null;

  // A previously-seen alias may already resolve; that is the safest repair.
  const candidates: HealCandidate[] = [];
  for (const alias of context.aliases ?? []) {
    try {
      if ((await page.locator(alias).count()) === 1) {
        candidates.push({
          selector: alias,
          confidence: 95,
          reasons: ["a selector already known to point at this element resolves here"],
          tag: "",
        });
      }
    } catch {
      // ignore an alias that no longer parses
    }
  }

  let found: Awaited<ReturnType<typeof findCandidates>> = [];
  try {
    // tsx compiles this file with esbuild, which wraps named inner functions in
    // a __name() helper that does not exist in the browser. Without this shim
    // the evaluated function throws on its first line and the healer silently
    // proposes nothing. Passed as a string so esbuild cannot rewrite it.
    await page.evaluate("globalThis.__name = globalThis.__name || function (fn) { return fn; };");
    found = await page.evaluate(findCandidates, {
      description: context.description,
      action: context.action,
      originalSelector: selector
    });
  } catch {
    // A page mid-navigation cannot be inspected; fall back to aliases only.
    found = [];
  }

  for (const c of found) {
    if (candidates.some(existing => existing.selector === c.selector)) continue;
    candidates.push({ selector: c.selector, confidence: c.confidence, reasons: c.reasons, text: c.text, tag: c.tag });
  }

  if (!candidates.length) return null;

  return {
    stepIndex: context.stepIndex,
    action: context.action,
    originalSelector: selector,
    failure: matchCount === 0 ? "not-found" : "ambiguous",
    matchCount,
    candidates: candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 5),
    at: new Date().toISOString()
  };
}
