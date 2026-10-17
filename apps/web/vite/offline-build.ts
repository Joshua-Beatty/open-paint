import type { Plugin } from "vite";

/** An attribute that loads a resource: `<script src>`, `<link href>` and similar. */
const HTML_RESOURCE = /\b(?:src|href|action|poster)\s*=\s*(["'])(.*?)\1/gi;
/** A `url(...)` in a stylesheet, such as a font face or a background image. */
const CSS_URL = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
/** A stylesheet `@import` written as a string. */
const CSS_IMPORT = /@import\s+(["'])(.*?)\1/gi;
/** A dynamic `import()` or `importScripts()` in a script. */
const SCRIPT_LOAD = /\b(?:import|importScripts)\(\s*(["'`])(.*?)\1/g;

/** Data and blob URLs stay inside the page, so they are not external. */
const INLINE_URL = /^(?:data|blob):/i;
/** A URL with a scheme, or a protocol-relative `//host` URL, leaves the origin. */
const EXTERNAL_URL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

function referencesOf(fileName: string, text: string): string[] {
  const patterns = fileName.endsWith(".html")
    ? [HTML_RESOURCE]
    : fileName.endsWith(".css")
      ? [CSS_URL, CSS_IMPORT]
      : fileName.endsWith(".js")
        ? [SCRIPT_LOAD]
        : [];
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[2] ?? "").filter((target) => target !== ""),
  );
}

/** The references in one emitted file that would reach another origin. */
export function externalReferences(fileName: string, text: string): string[] {
  return referencesOf(fileName, text).filter(
    (target) => EXTERNAL_URL.test(target) && !INLINE_URL.test(target),
  );
}

/** The root-relative HTML references that the bundle does not contain. */
export function missingHtmlAssets(text: string, bundledFiles: ReadonlySet<string>): string[] {
  return referencesOf("index.html", text).filter(
    (target) => target.startsWith("/") && !bundledFiles.has(target.slice(1)),
  );
}

/**
 * Fails the production build if the app would fetch anything from another origin or if its HTML
 * points at a file it does not ship. Every resource must come from the output itself, so the
 * app runs offline once it is cached (WEB-ENV-03, WEB-SEC-02).
 */
export function offlineBuildCheck(): Plugin {
  return {
    name: "openpaint-offline-build-check",
    apply: "build",
    generateBundle(_options, bundle) {
      const bundled = new Set(Object.keys(bundle));
      const problems: string[] = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        const text =
          output.type === "chunk"
            ? output.code
            : typeof output.source === "string"
              ? output.source
              : new TextDecoder().decode(output.source);
        for (const target of externalReferences(fileName, text)) {
          problems.push(`${fileName} loads ${target} from another origin`);
        }
        if (fileName.endsWith(".html")) {
          for (const target of missingHtmlAssets(text, bundled)) {
            problems.push(`${fileName} points at ${target}, which is not in the build`);
          }
        }
      }
      if (problems.length > 0) {
        this.error(`The build is not self-contained:\n${problems.join("\n")}`);
      }
    },
  };
}
