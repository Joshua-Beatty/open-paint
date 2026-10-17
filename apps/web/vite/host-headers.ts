import type { Plugin } from "vite";
import { contentSecurityPolicy } from "./content-security-policy.ts";

/** Cross-origin isolation enables SharedArrayBuffer and therefore threaded WASM (WEB-ENV-05). */
export const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/** The policy header for the dev and preview servers and for the production host (WEB-SEC-01). */
export const securityHeaders = (development: boolean) => ({
  "Content-Security-Policy": contentSecurityPolicy(development),
});

/** The file static hosts read for response headers (Netlify and Cloudflare Pages). */
export const HOST_HEADERS_FILE = "_headers";

/**
 * The production `_headers` file. It carries the same isolation and policy headers as the dev and
 * preview servers. The app shell and the service worker script are never cached by the browser,
 * so a deployed update is picked up (WEB-UPD-01). Hashed assets are cached for a year.
 */
export function hostHeadersFile(): string {
  const headers = { ...crossOriginIsolationHeaders, ...securityHeaders(false) };
  const lines = [
    "/*",
    ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`),
    "",
    "/",
    "  Cache-Control: no-cache",
    "",
    "/index.html",
    "  Cache-Control: no-cache",
    "",
    "/sw.js",
    "  Cache-Control: no-cache",
    "",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ];
  return lines.join("\n");
}

/** Writes the `_headers` file into the build output. */
export function hostHeadersPlugin(): Plugin {
  return {
    name: "openpaint-host-headers",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: HOST_HEADERS_FILE, source: hostHeadersFile() });
    },
  };
}
