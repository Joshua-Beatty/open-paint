import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Plugin } from "vite";
import {
  BUNDLED_FONT_SPECS,
  bundledFontFiles,
  isUpstreamFontPath,
} from "../src/text/font-manifest.ts";

/** The module that maps each bundled font file to its self-hosted URL (WEB-FONT-01). */
export const BUNDLED_FONT_MODULE_ID = "virtual:bundled-font-files";

const RESOLVED_ID = `\0${BUNDLED_FONT_MODULE_ID}`;

/** An upstream font file's path in the app folder, with "/" separators so it can be imported. */
export function upstreamFontFile(appDir: string, path: string): string {
  return join(appDir, path).replaceAll("\\", "/");
}

/** The bundled font files that are not installed or copied in, so the build can name them. */
export function missingFontFiles(appDir: string): string[] {
  const require = createRequire(join(appDir, "package.json"));
  return bundledFontFiles(BUNDLED_FONT_SPECS).filter((path) => {
    if (isUpstreamFontPath(path)) return !existsSync(upstreamFontFile(appDir, path));
    try {
      return !existsSync(require.resolve(path));
    } catch {
      return true;
    }
  });
}

/**
 * The module source: one asset import per file, so each font is emitted as its own file, and the
 * URLs in the order of `bundledFontFiles`, which keeps the package paths out of the app bundle.
 */
export function bundledFontModule(files: readonly string[]): string {
  // `no-inline` keeps even a tiny font a file, as the policy allows fonts from 'self' only.
  const imports = files.map(
    (path, index) => `import f${index} from ${JSON.stringify(`${path}?no-inline`)};`,
  );
  const urls = files.map((_, index) => `f${index}`).join(", ");
  return [...imports, `export default [${urls}];`, ""].join("\n");
}

/**
 * Serves the font file URLs as a virtual module. The fonts are emitted as hashed assets and are
 * fetched only when a face is used; the service worker caches each on first use.
 */
export function bundledFonts(appDir: string): Plugin {
  return {
    name: "openpaint-bundled-fonts",
    buildStart() {
      const missing = missingFontFiles(appDir);
      if (missing.length > 0) this.error(`Bundled font files are missing:\n${missing.join("\n")}`);
    },
    resolveId(id) {
      return id === BUNDLED_FONT_MODULE_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return bundledFontModule(
        bundledFontFiles(BUNDLED_FONT_SPECS).map((path) =>
          isUpstreamFontPath(path) ? upstreamFontFile(appDir, path) : path,
        ),
      );
    },
  };
}
