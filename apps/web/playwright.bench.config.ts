/// <reference types="node" />
import { defineConfig, devices } from "@playwright/test";
import { CHROMIUM_WEBGPU_ARGS } from "./playwright.config.ts";

/** A port of its own, so the bench never reuses an e2e server running an older build. */
const port = 4183;

/**
 * Browser benchmarks (`pnpm bench`). They run one at a time in Chromium with
 * WebGPU against the production build, so the numbers are comparable between runs.
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
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        channel: "chromium",
        launchOptions: { args: CHROMIUM_WEBGPU_ARGS },
      },
    },
  ],
  // BENCH_DEV=1 measures the Vite dev server instead (React dev mode, unbundled modules), which is
  // what `pnpm dev` users see. Its numbers are not comparable with the production ones.
  webServer: {
    command: process.env.BENCH_DEV
      ? `pnpm dev --port ${port} --strictPort`
      : `pnpm build && pnpm preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
