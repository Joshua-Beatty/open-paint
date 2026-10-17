import type { ManifestEntry, RuntimeCaching } from "workbox-build";
import { FONT_CACHE } from "../src/text/font-offline.ts";

/**
 * The font files the service worker installs with the app: the Latin faces of the default family
 * (WEB-FONT-02), so text works offline from the first load. The other bundled fonts are cached the
 * first time they are used (shown in the font list or drawn), or when the app downloads them in the
 * background (src/text/font-offline.ts), which keeps them out of the install.
 */
const PRECACHED_FONT = /(?:^|\/)noto-sans-latin-\d+-(?:normal|italic)-[\w-]+\.woff2$/;

/** A font file: the subsets are WOFF2, an upstream file may also be OpenType or TrueType. */
const FONT_FILE = /\.(?:woff2|otf|ttf)$/i;

export function isFontFile(path: string): boolean {
  return FONT_FILE.test(path);
}

export function isPrecachedFont(url: string): boolean {
  return PRECACHED_FONT.test(url);
}

/** Drops the font files from the precache manifest, except the default family's. */
export function precacheFontFilter<Entry extends ManifestEntry>(
  entries: readonly Entry[],
): {
  manifest: Entry[];
  warnings: string[];
} {
  return {
    manifest: entries.filter((entry) => !isFontFile(entry.url) || isPrecachedFont(entry.url)),
    warnings: [],
  };
}

/**
 * Font files are content-hashed, so a cached copy never goes stale: it is served from the cache,
 * and fetched (then kept) only the first time. Old versions' files are evicted by count.
 */
export const fontRuntimeCaching: RuntimeCaching = {
  // Workbox copies this function into the service worker, so it must not use anything around it.
  urlPattern: ({ url, sameOrigin }) => sameOrigin && /\.(?:woff2|otf|ttf)$/i.test(url.pathname),
  handler: "CacheFirst",
  options: {
    cacheName: FONT_CACHE,
    expiration: { maxEntries: 300 },
    // A font load sends an Origin header and the server varies on it, but a file the app
    // downloaded in the background was fetched without one; it is the same file either way.
    matchOptions: { ignoreVary: true },
    cacheableResponse: { statuses: [200] },
  },
};
