/// <reference types="node" />
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices, type Project } from "@playwright/test";
import { BENCH_BROWSER } from "./bench/browser.ts";
import { CHROMIUM_WEBGPU_ARGS } from "./playwright.config.ts";

/**
 * A port of its own, so the bench never reuses an e2e server running an older build. `BENCH_PORT`
 * moves it, so benches of two checkouts can run side by side.
 */
const port = Number(process.env.BENCH_PORT ?? 4183);

const viewport = { width: 1440, height: 900 };

const profileDir = process.env.BENCH_PROFILE;

/**
 * With `BENCH_PROFILE=<dir>`, desktop Firefox runs its own profiler from startup over every thread
 * of every process and writes `<dir>/firefox-<time>.json` when it closes. Summarize it with
 * `node bench/gecko-profile.ts <file>`.
 */
function firefoxProfilerEnv(dir: string): Record<string, string> {
  mkdirSync(dir, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return {
    ...env,
    MOZ_PROFILER_STARTUP: "1",
    MOZ_PROFILER_STARTUP_INTERVAL: "1",
    MOZ_PROFILER_STARTUP_ENTRIES: "268435456",
    MOZ_PROFILER_STARTUP_FEATURES: "js,stackwalk,cpu,markersallthreads",
    MOZ_PROFILER_STARTUP_FILTERS: "*",
    MOZ_PROFILER_SHUTDOWN: resolve(dir, `firefox-${Date.now()}.json`),
  };
}

/** The one project `BENCH_BROWSER` selects (bench/browser.ts). */
const projects: Record<typeof BENCH_BROWSER, Project> = {
  // BENCH_DEVICE=phone emulates a phone with touch (the compact layout) for the M scenarios.
  chromium: {
    name: "chromium",
    use:
      process.env.BENCH_DEVICE === "phone"
        ? {
            ...devices["Pixel 7"],
            channel: "chromium",
            launchOptions: { args: CHROMIUM_WEBGPU_ARGS },
          }
        : {
            ...devices["Desktop Chrome"],
            viewport,
            channel: "chromium",
            launchOptions: { args: CHROMIUM_WEBGPU_ARGS },
          },
  },
  firefox: {
    name: "firefox",
    use: {
      ...devices["Desktop Firefox"],
      viewport,
      ...(profileDir !== undefined && { launchOptions: { env: firefoxProfilerEnv(profileDir) } }),
    },
  },
  "firefox-desktop": {
    name: "firefox-desktop",
    use: {
      browserName: "firefox",
      channel: "moz-firefox",
      viewport,
      // Headless desktop Firefox finds no WebGPU adapter, so it runs headed unless asked not to.
      headless: process.env.BENCH_HEADLESS === "1",
      ...(profileDir !== undefined && { launchOptions: { env: firefoxProfilerEnv(profileDir) } }),
    },
  },
};

/**
 * Browser benchmarks (`pnpm bench`). They run one at a time against the production build, so the
 * numbers are comparable between runs. Chromium with WebGPU by default; `BENCH_BROWSER` picks
 * Firefox (bench/browser.ts).
 */
export default defineConfig({
  testDir: "bench",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A 20-layer 4000 x 3000 scenario can take minutes on the v1 engine.
  timeout: 20 * 60_000,
  reporter: "list",
  // Writes .perf/results/<engine>-<date>.json and prints the table.
  globalTeardown: "./bench/teardown.ts",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "off",
  },
  projects: [projects[BENCH_BROWSER]],
  // BENCH_DEV=1 measures the Vite dev server instead (React dev mode, unbundled modules), which is
  // what `pnpm dev` users see. Its numbers are not comparable with the production ones.
  // BENCH_NO_BUILD=1 serves the existing build, e.g. to run the same build in several browsers.
  webServer: {
    command: process.env.BENCH_DEV
      ? `pnpm dev --port ${port} --strictPort`
      : process.env.BENCH_NO_BUILD
        ? `pnpm preview --port ${port} --strictPort`
        : `pnpm build && pnpm preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
