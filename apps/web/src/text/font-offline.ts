/** The cache the service worker keeps font files in once they are fetched (vite/font-caching.ts). */
export const FONT_CACHE = "openpaint-fonts";

/** How many font files download at once. */
export const FONT_PREFETCH_CONCURRENCY = 2;

/** How long after the last pointer, wheel or key input the downloads stay paused, in ms. */
export const INPUT_QUIET_MS = 1000;

/** How long a paused download waits before it checks again whether the user is still busy, in ms. */
const BUSY_RETRY_MS = 250;

/** What the background font download needs from the page. Tests pass fakes. */
export interface FontPrefetchPorts {
  /** Whether the file is in a cache already (the precache or the font cache). */
  isCached(url: string): Promise<boolean>;
  /** Fetches the file at low priority and keeps it for offline use. Rejects when it cannot. */
  download(url: string): Promise<void>;
  /** Resolves when the browser is idle. */
  idle(): Promise<void>;
  /** Whether the user is interacting, so the download waits. */
  busy(): boolean;
  wait(ms: number): Promise<void>;
}

export interface FontPrefetchResult {
  /** The files downloaded in this run. */
  readonly downloaded: number;
  /** The files that were cached already. */
  readonly cached: number;
  /** Whether a download failed (offline, say), which ends the run; the next session resumes it. */
  readonly interrupted: boolean;
}

/**
 * Downloads every bundled font file that is not cached yet, a few at a time and only while the
 * browser is idle and the user is not interacting (L5), so all fonts work offline. Fonts still load
 * on first use as before; a file that is cached already is skipped, so a run that was interrupted
 * resumes where it stopped.
 */
export async function prefetchFonts(
  urls: readonly string[],
  ports: FontPrefetchPorts,
  concurrency = FONT_PREFETCH_CONCURRENCY,
): Promise<FontPrefetchResult> {
  const queue = [...new Set(urls)];
  let downloaded = 0;
  let cached = 0;
  let interrupted = false;
  const quiet = async () => {
    for (;;) {
      await ports.idle();
      if (!ports.busy()) return;
      await ports.wait(BUSY_RETRY_MS);
    }
  };
  const lane = async () => {
    for (;;) {
      if (interrupted) return;
      const url = queue.shift();
      if (url === undefined) return;
      if (await ports.isCached(url)) {
        cached++;
        continue;
      }
      await quiet();
      if (interrupted) return;
      try {
        await ports.download(url);
        downloaded++;
      } catch {
        interrupted = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
  return { downloaded, cached, interrupted };
}

interface NetworkInformationLike {
  readonly saveData?: boolean;
  readonly type?: string;
  readonly effectiveType?: string;
}

/**
 * Whether the connection asks for data to be saved: the Save-Data preference, a cellular (likely
 * metered) connection or a 2G one, where the browser tells. Unknown connections allow the download.
 */
export function connectionSavesData(connection: NetworkInformationLike | undefined): boolean {
  if (connection === undefined) return false;
  if (connection.saveData === true) return true;
  if (connection.type === "cellular") return true;
  return connection.effectiveType === "slow-2g" || connection.effectiveType === "2g";
}

/** Tracks the time of the user's last pointer, wheel or key input on the page. */
export class InputActivity {
  #last = Number.NEGATIVE_INFINITY;
  readonly #now: () => number;

  constructor(target: Pick<EventTarget, "addEventListener">, now: () => number = Date.now) {
    this.#now = now;
    const mark = () => {
      this.#last = this.#now();
    };
    for (const type of ["pointerdown", "pointermove", "wheel", "keydown"]) {
      target.addEventListener(type, mark, { capture: true, passive: true });
    }
  }

  /** Whether there was input within the last `INPUT_QUIET_MS`. */
  get recent(): boolean {
    return this.#now() - this.#last < INPUT_QUIET_MS;
  }
}

function browserIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve());
    else setTimeout(resolve, 200);
  });
}

/** The page's ports: Cache Storage, low-priority fetches and idle callbacks. */
export function browserFontPrefetchPorts(busy: () => boolean): FontPrefetchPorts {
  return {
    async isCached(url) {
      return (await caches.match(url)) !== undefined;
    },
    async download(url) {
      const response = await fetch(url, { priority: "low" } as RequestInit);
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      // Under the service worker its font route keeps the file; without one, the page does.
      if (navigator.serviceWorker?.controller == null) {
        await (await caches.open(FONT_CACHE)).put(url, response);
      } else {
        await response.arrayBuffer();
      }
    },
    idle: browserIdle,
    busy,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

let prefetchStarted = false;

/** How long after the page has loaded the downloads begin, in ms. */
export const FONT_PREFETCH_DELAY_MS = 2000;

/**
 * Starts the background download of all bundled fonts once the page has loaded and settled,
 * unless the browser has no Cache Storage or the connection asks to save data.
 */
export function startFontPrefetch(urls: readonly string[], busy: () => boolean): void {
  if (prefetchStarted || typeof caches === "undefined") return;
  prefetchStarted = true;
  const connection = (navigator as { connection?: NetworkInformationLike }).connection;
  if (connectionSavesData(connection)) return;
  const input = new InputActivity(window);
  const ports = browserFontPrefetchPorts(() => busy() || input.recent);
  const begin = () => {
    setTimeout(
      () => void prefetchFonts(urls, ports).catch(() => undefined),
      FONT_PREFETCH_DELAY_MS,
    );
  };
  if (document.readyState === "complete") begin();
  else window.addEventListener("load", begin, { once: true });
}
