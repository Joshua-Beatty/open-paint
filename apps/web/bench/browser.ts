/// <reference types="node" />

/**
 * The browser the bench runs in (`BENCH_BROWSER`):
 * - `chromium` (default): Playwright's Chromium with WebGPU.
 * - `firefox`: Playwright's bundled Firefox, which has no WebGPU, so the CPU backend runs.
 * - `firefox-desktop`: the installed desktop Firefox over WebDriver BiDi (`moz-firefox` channel),
 *   with its own WebGPU. It runs headed, since headless it finds no adapter (`BENCH_HEADLESS=1`
 *   runs it headless anyway, on the CPU backend).
 */
export type BenchBrowser = "chromium" | "firefox" | "firefox-desktop";

function benchBrowser(value: string | undefined): BenchBrowser {
  if (value === undefined || value === "" || value === "chromium") return "chromium";
  if (value === "firefox" || value === "firefox-desktop") return value;
  throw new Error(`BENCH_BROWSER must be chromium, firefox or firefox-desktop, not "${value}".`);
}

export const BENCH_BROWSER: BenchBrowser = benchBrowser(process.env.BENCH_BROWSER);

/** Chromium exposes CDP, so only it can record CPU profiles with `BENCH_PROFILE`. */
export const HAS_CDP = BENCH_BROWSER === "chromium";

/** The name results are filed under: the engine, plus the browser when it is not Chromium. */
export function resultsKey(engine: string): string {
  return BENCH_BROWSER === "chromium" ? engine : `${engine}-${BENCH_BROWSER}`;
}
