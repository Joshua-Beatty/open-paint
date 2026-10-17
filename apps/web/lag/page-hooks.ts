import type { ToolChange } from "./analyze.ts";

declare global {
  interface Window {
    /** Set by the lag recorder's init script: when the active tool changed. */
    __lagTools?: ToolChange[];
  }
}

/**
 * Runs in the page before the app (as a Playwright init script, so it must not use anything from
 * this module's scope). It logs the active tool, read from the Tools panel's checked radio, each
 * time a tool radio's `aria-checked` changes and on every pointer down and key press. It watches
 * only that attribute, so it adds no work to ordinary renders.
 */
export function installToolTracker(): void {
  const log: ToolChange[] = [];
  window.__lagTools = log;
  let last: string | undefined;
  const read = () => {
    const radio = document.querySelector(".tools-grid [role=radio][aria-checked=true]");
    const tool = radio?.getAttribute("aria-label") ?? radio?.textContent?.trim() ?? undefined;
    if (tool !== undefined && tool !== "" && tool !== last) {
      last = tool;
      log.push({ time: performance.now(), tool });
    }
    return tool;
  };
  const start = () => {
    new MutationObserver(read).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked"],
    });
    // The panel mounts after the app starts.
    const timer = setInterval(() => {
      if (read() !== undefined) clearInterval(timer);
    }, 500);
  };
  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, read, { capture: true, passive: true });
  }
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}
