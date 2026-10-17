/// <reference types="node" />
import { defineConfig, devices } from "@playwright/test";

const port = 4174;
/** A desktop Firefox browser server (`scripts/firefox-server.mjs`); adds the `firefox` project. */
const firefoxEndpoint = process.env.GOLDEN_FIREFOX_WS;

export default defineConfig({
  testDir: "browser",
  testMatch: "**/*.golden.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Full Chromium exposes WebGPU adapters headless; the headless shell does not.
        channel: "chromium",
        launchOptions: {
          args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"],
        },
      },
    },
    ...(firefoxEndpoint
      ? [
          {
            name: "firefox",
            use: {
              browserName: "firefox" as const,
              connectOptions: { wsEndpoint: firefoxEndpoint },
            },
          },
        ]
      : []),
  ],
  // The browser page is served by Vite straight from this package; fixtures are static files here.
  webServer: {
    command: `vite --port ${port} --strictPort`,
    url: `http://localhost:${port}/browser/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
