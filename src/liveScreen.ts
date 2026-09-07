import type { Page } from "playwright";

export interface LiveFrame { image: string; width: number; height: number; url: string }

/** Transient browser frames: no console logging or permanent screenshot files. */
export function startLiveScreen(currentPage: () => Page, publish: (frame: LiveFrame) => void): () => Promise<void> {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const capture = () => {
    if (stopped || pending) return;
    pending = (async () => {
      try {
        const page = currentPage();
        const image = await page.screenshot({ type: "jpeg", quality: 55, timeout: 2000 });
        if (!stopped) publish({ image: image.toString("base64"), ...(page.viewportSize() || { width: 1280, height: 800 }), url: page.url() });
      } catch { /* Navigation or a closed page must not affect the test. */ }
    })().finally(() => { pending = undefined; });
  };
  const timer = setInterval(capture, 700);
  timer.unref();
  capture();
  return async () => { stopped = true; clearInterval(timer); await pending; };
}
