// @vitest-environment node
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./content-security-policy";
import { crossOriginIsolationHeaders, hostHeadersFile, securityHeaders } from "./host-headers";

describe("hostHeadersFile", () => {
  const lines = hostHeadersFile().split("\n");

  it("sends the cross-origin isolation and policy headers to every path", () => {
    expect(lines[0]).toBe("/*");
    expect(lines).toContain("  Cross-Origin-Opener-Policy: same-origin");
    expect(lines).toContain("  Cross-Origin-Embedder-Policy: require-corp");
    expect(lines).toContain(`  Content-Security-Policy: ${contentSecurityPolicy(false)}`);
  });

  it("carries the same header values as the dev and preview servers", () => {
    expect(crossOriginIsolationHeaders).toEqual({
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    expect(securityHeaders(false)).toEqual({
      "Content-Security-Policy": contentSecurityPolicy(false),
    });
    expect(hostHeadersFile()).toContain(
      `  Content-Security-Policy: ${securityHeaders(false)["Content-Security-Policy"]}`,
    );
  });

  it("stops the browser caching the app shell and the service worker, and caches assets for a year", () => {
    const rules = hostHeadersFile()
      .split(/\n\n/)
      .map((block) => block.split("\n"));
    const cacheFor = (path: string) =>
      rules.find((block) => block[0] === path)?.find((line) => line.includes("Cache-Control"));
    expect(cacheFor("/")).toBe("  Cache-Control: no-cache");
    expect(cacheFor("/index.html")).toBe("  Cache-Control: no-cache");
    expect(cacheFor("/sw.js")).toBe("  Cache-Control: no-cache");
    expect(cacheFor("/assets/*")).toBe("  Cache-Control: public, max-age=31536000, immutable");
  });
});
