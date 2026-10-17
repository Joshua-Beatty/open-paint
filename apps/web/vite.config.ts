import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { t } from "@openpaint/i18n";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { configDefaults, defineConfig } from "vitest/config";
import { bundledFonts } from "./vite/bundled-fonts.ts";
import { contentSecurityPolicyMeta } from "./vite/content-security-policy.ts";
import { FILE_HANDLER_ACCEPT } from "./vite/file-handlers.ts";
import { fontRuntimeCaching, precacheFontFilter } from "./vite/font-caching.ts";
import {
  crossOriginIsolationHeaders,
  hostHeadersPlugin,
  securityHeaders,
} from "./vite/host-headers.ts";
import { offlineBuildCheck } from "./vite/offline-build.ts";
import { openSourceLicenses } from "./vite/open-source-licenses.ts";

/** The production policy goes into the page as a meta tag, so a host that sends no headers still gets it. */
const cspMetaPlugin = (): Plugin => ({
  name: "openpaint-csp-meta",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: (html) =>
      html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicyMeta()}" />`,
      ),
  },
});

const themeColor = "#1f6feb";

const appDir = fileURLToPath(new URL(".", import.meta.url));

const licenses = openSourceLicenses(appDir);

/** The app version from package.json, shown in diagnostics and the About dialog (SET-ERR-05). */
const appVersion = (
  JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    /** The build time, shown in the About dialog (SET-HELP-02). */
    __APP_BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    bundledFonts(appDir),
    licenses.main,
    cspMetaPlugin(),
    hostHeadersPlugin(),
    offlineBuildCheck(),
    VitePWA({
      registerType: "prompt",
      // The app registers the worker itself, so it can check for updates (SET-UPD-01).
      injectRegister: null,
      includeAssets: ["icon.svg"],
      manifest: {
        id: "/",
        name: t("app.name"),
        short_name: t("app.name"),
        description: t("app.description"),
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: themeColor,
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
        file_handlers: [{ action: "/", accept: FILE_HANDLER_ACCEPT }],
      },
      workbox: {
        // One precache per app version (08 SET-LIFE-01). Workbox deletes the older versions' caches on activation.
        cacheId: `openpaint-${appVersion}`,
        // The notices file is precached too, so the About dialog's licenses work offline.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,wasm,webmanifest,txt}"],
        // Only the default font is installed; the others are cached on first use.
        manifestTransforms: [async (entries) => precacheFontFilter(entries)],
        runtimeCaching: [fontRuntimeCaching],
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
      },
    }),
  ],
  // Module workers so the engine worker can code-split and load WASM via import.meta.url.
  // The worker builds report their modules, so the license list names what they ship.
  worker: { format: "es", plugins: () => [licenses.worker()] },
  server: { headers: { ...crossOriginIsolationHeaders, ...securityHeaders(true) } },
  preview: { headers: { ...crossOriginIsolationHeaders, ...securityHeaders(false) } },
  test: {
    environment: "jsdom",
    // Playwright owns the e2e specs and the browser benchmarks (`pnpm bench`).
    exclude: [...configDefaults.exclude, "e2e/**", "bench/**/*.spec.ts"],
  },
});
