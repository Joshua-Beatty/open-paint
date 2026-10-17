/// <reference types="node" />
import { defineConfig, devices } from "@playwright/test";

/** E2E_PORT lets several checkouts run their suites side by side without sharing a server. */
const port = Number(process.env.E2E_PORT ?? 4173);

/** Full Chromium (new headless) exposes WebGPU adapters with these; the headless shell has none. */
export const CHROMIUM_WEBGPU_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--ignore-gpu-blocklist",
];

/** The specs for phones and tablets, which only the mobile projects run. */
const MOBILE_SPECS = /mobile\.spec\.ts$/;

export default defineConfig({
  testDir: "e2e",
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
      testIgnore: MOBILE_SPECS,
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        launchOptions: { args: CHROMIUM_WEBGPU_ARGS },
      },
    },
    // Firefox and WebKit run the same suite. WebGPU is used only where the engine finds an
    // adapter, so the CPU backend is the baseline there (WEB-GPU-01, WEB-GPU-02).
    {
      name: "firefox",
      testIgnore: MOBILE_SPECS,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: MOBILE_SPECS,
      use: { ...devices["Desktop Safari"] },
    },
    // A phone and a tablet with touch emulation run the touch and compact-layout checks, in
    // Chromium, whose DevTools protocol sends multi-touch input.
    {
      name: "mobile-phone",
      testMatch: MOBILE_SPECS,
      use: {
        ...devices["Pixel 7"],
        channel: "chromium",
        launchOptions: { args: CHROMIUM_WEBGPU_ARGS },
      },
    },
    {
      name: "mobile-tablet",
      testMatch: MOBILE_SPECS,
      use: {
        ...devices["iPad Pro 11"],
        browserName: "chromium",
        channel: "chromium",
        launchOptions: { args: CHROMIUM_WEBGPU_ARGS },
      },
    },
    // E2E_FIREFOX_DESKTOP=1 adds the installed desktop Firefox (headed, since headless it finds no
    // WebGPU adapter), to run the suite on Firefox's own WebGPU.
    ...(process.env.E2E_FIREFOX_DESKTOP
      ? [
          {
            name: "firefox-desktop",
            use: { browserName: "firefox" as const, channel: "moz-firefox", headless: false },
          },
        ]
      : []),
  ],
  // E2E runs against the built PWA, served by `vite preview` with the production headers.
  webServer: {
    command: `pnpm build && pnpm preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
