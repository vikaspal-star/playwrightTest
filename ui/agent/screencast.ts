// ============================================================
// LIVE SCREEN
// ------------------------------------------------------------
// Streams the browser the studio is driving into the app itself,
// so recording and running are watched in the right-hand panel
// rather than in a window that opens somewhere else.
//
// Frames come from Chrome DevTools' screencast, which is what
// Playwright is already talking to. Each frame is a JPEG; they go
// out over Server-Sent Events as data URLs. Clicks and keystrokes
// from the panel are replayed into the real page, so the embedded
// view can be driven as well as watched.
// ============================================================

import type { Page } from "playwright";

export interface Frame {
  data: string; // base64 JPEG
  width: number;
  height: number;
  at: number;
}

interface Cast {
  page: Page;
  listeners: Set<(frame: Frame) => void>;
  stop: () => Promise<void>;
  latest?: Frame;
}

const casts = new Map<string, Cast>();

/**
 * Begin streaming `page` under `id`. Safe to call twice: the second call
 * replaces the first, which matters when a run navigates to a new page.
 */
export async function start(id: string, page: Page, options: { maxWidth?: number; quality?: number } = {}): Promise<void> {
  await stop(id);

  const session = await page.context().newCDPSession(page);
  const cast: Cast = {
    page,
    listeners: new Set(),
    stop: async () => {
      // Detaching a session whose page has already gone is not an error worth
      // surfacing; the frames simply stop.
      await session.send("Page.stopScreencast").catch(() => {});
      await session.detach().catch(() => {});
    }
  };

  session.on("Page.screencastFrame", async (event: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
    // Chrome pauses the stream until each frame is acknowledged.
    await session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    const frame: Frame = {
      data: event.data,
      width: Math.round(event.metadata?.deviceWidth ?? 0),
      height: Math.round(event.metadata?.deviceHeight ?? 0),
      at: Date.now()
    };
    cast.latest = frame;
    for (const listener of cast.listeners) listener(frame);
  });

  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: options.quality ?? 60,
    maxWidth: options.maxWidth ?? 1280,
    maxHeight: 900,
    everyNthFrame: 1
  });

  casts.set(id, cast);
}

export async function stop(id: string): Promise<void> {
  const cast = casts.get(id);
  if (!cast) return;
  casts.delete(id);
  cast.listeners.clear();
  await cast.stop();
}

export function isActive(id: string): boolean {
  return casts.has(id);
}

export function latest(id: string): Frame | undefined {
  return casts.get(id)?.latest;
}

export function subscribe(id: string, onFrame: (frame: Frame) => void): () => void {
  const cast = casts.get(id);
  if (!cast) return () => {};
  cast.listeners.add(onFrame);
  // Send what we already have so a late viewer is not staring at nothing.
  if (cast.latest) onFrame(cast.latest);
  return () => cast.listeners.delete(onFrame);
}

export type PointerAction =
  | { kind: "click"; x: number; y: number; button?: "left" | "right"; clickCount?: number }
  | { kind: "move"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; deltaY: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string };

/**
 * Replay an interaction from the embedded view into the real page.
 * Coordinates arrive normalized (0-1) so the panel can be any size.
 */
export async function interact(id: string, action: PointerAction): Promise<void> {
  const cast = casts.get(id);
  if (!cast) throw new Error("That screen is no longer live.");
  const page = cast.page;
  const size = page.viewportSize() ?? { width: cast.latest?.width || 1280, height: cast.latest?.height || 800 };

  const toPixels = (x: number, y: number): { x: number; y: number } => ({
    x: Math.max(0, Math.min(size.width, x * size.width)),
    y: Math.max(0, Math.min(size.height, y * size.height))
  });

  switch (action.kind) {
    case "move": {
      const p = toPixels(action.x, action.y);
      await page.mouse.move(p.x, p.y);
      return;
    }
    case "click": {
      const p = toPixels(action.x, action.y);
      await page.mouse.click(p.x, p.y, {
        button: action.button ?? "left",
        clickCount: action.clickCount ?? 1
      });
      return;
    }
    case "scroll": {
      const p = toPixels(action.x, action.y);
      await page.mouse.move(p.x, p.y);
      await page.mouse.wheel(0, action.deltaY);
      return;
    }
    case "type":
      await page.keyboard.type(action.text);
      return;
    case "key":
      await page.keyboard.press(action.key);
      return;
  }
}
