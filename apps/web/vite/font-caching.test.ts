// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fontRuntimeCaching, isPrecachedFont, precacheFontFilter } from "./font-caching";

describe("font caching (WEB-ENV-03)", () => {
  it("installs the default family's Latin faces and leaves the other fonts to first use", () => {
    const entries = [
      { url: "index.html", revision: "1" },
      { url: "assets/noto-sans-latin-400-normal-AbC_12.woff2", revision: null },
      { url: "assets/noto-sans-latin-700-italic-x1.woff2", revision: null },
      { url: "assets/noto-sans-latin-ext-400-normal-x1.woff2", revision: null },
      { url: "assets/noto-sans-mono-latin-400-normal-x1.woff2", revision: null },
      { url: "assets/inter-latin-wght-normal-x1.woff2", revision: null },
      { url: "assets/Lobster-Regular-x1.otf", revision: null },
      { url: "assets/Some-Font-x1.ttf", revision: null },
    ];
    expect(precacheFontFilter(entries).manifest.map((entry) => entry.url)).toEqual([
      "index.html",
      "assets/noto-sans-latin-400-normal-AbC_12.woff2",
      "assets/noto-sans-latin-700-italic-x1.woff2",
    ]);
    expect(isPrecachedFont("assets/pacifico-latin-400-normal-x1.woff2")).toBe(false);
  });

  it("serves same-origin font files from the cache once fetched", () => {
    const match = fontRuntimeCaching.urlPattern as (options: {
      url: URL;
      sameOrigin: boolean;
    }) => boolean;
    expect(match({ url: new URL("https://app.test/assets/a-1.woff2"), sameOrigin: true })).toBe(
      true,
    );
    expect(match({ url: new URL("https://app.test/assets/Lobster-1.otf"), sameOrigin: true })).toBe(
      true,
    );
    expect(match({ url: new URL("https://app.test/assets/b-1.ttf"), sameOrigin: true })).toBe(true);
    expect(match({ url: new URL("https://cdn.test/a.woff2"), sameOrigin: false })).toBe(false);
    // Workbox copies the matcher into the service worker on its own, so it must be self-contained.
    expect(String(match)).not.toMatch(/isFontFile|FONT_FILE/);
    expect(match({ url: new URL("https://app.test/assets/a.js"), sameOrigin: true })).toBe(false);
    expect(fontRuntimeCaching.handler).toBe("CacheFirst");
    // Files downloaded in the background (no Origin header) serve font loads (with one).
    expect(fontRuntimeCaching.options?.matchOptions).toEqual({ ignoreVary: true });
  });
});
