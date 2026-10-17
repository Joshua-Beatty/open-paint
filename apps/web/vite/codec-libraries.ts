import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyrightOf, type OpenSourceComponent } from "./open-source-licenses.ts";

/** The folder of the copied codec license texts and their manifest, relative to the app. */
export const CODEC_LICENSES_DIR = join("licenses", "vendored");

/** A C or C++ library compiled into the WebAssembly of a codec package. */
export interface CodecLibrary {
  readonly name: string;
  readonly title: string;
  readonly version: string;
  /** The SPDX license of the library. */
  readonly license: string;
  /** The project. */
  readonly url: string;
  /** Where the license text was copied from, at the version that was compiled. */
  readonly source: string;
  /** The copied license text, relative to the manifest. */
  readonly licenseFile: string;
  /** The copyright line, for a license text that has none of its own. */
  readonly copyright?: string;
  /**
   * The Emscripten loaders whose .wasm contains the library, as paths inside `node_modules`
   * ("<package>/<file>").
   */
  readonly modules: readonly string[];
}

/** The codec libraries named in the manifest. */
export function readCodecLibraries(appDir: string): CodecLibrary[] {
  const file = join(appDir, CODEC_LICENSES_DIR, "manifest.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { libraries: CodecLibrary[] }).libraries;
}

/** A module id as a "/" path without the query or the virtual-module prefix. */
function modulePath(moduleId: string): string {
  return (moduleId.replace(/^\0/, "").split("?")[0] ?? "").replaceAll("\\", "/");
}

/** Whether the build loads one of the library's WebAssembly loaders. */
export function codecLibraryShipped(library: CodecLibrary, moduleIds: readonly string[]): boolean {
  const loaders = library.modules.map((module) => `/node_modules/${module}`);
  return moduleIds.some((id) => loaders.some((loader) => modulePath(id).endsWith(loader)));
}

/**
 * The codec libraries the build ships, with their copied license texts: those whose WebAssembly
 * loader is one of the build's modules. Without the module list (the dev server), all of them.
 */
export function codecLibraryComponents(
  appDir: string,
  moduleIds?: Iterable<string>,
): OpenSourceComponent[] {
  const ids = moduleIds === undefined ? undefined : [...moduleIds];
  return readCodecLibraries(appDir)
    .filter((library) => ids === undefined || codecLibraryShipped(library, ids))
    .map((library) => {
      const licenseText = readFileSync(
        join(appDir, CODEC_LICENSES_DIR, library.licenseFile),
        "utf8",
      )
        .replace(/\r\n/g, "\n")
        .trimEnd();
      return {
        name: library.name,
        title: library.title,
        kind: "codec",
        version: library.version,
        license: library.license,
        url: library.url,
        copyright: library.copyright ?? copyrightOf(licenseText),
        licenseText,
      };
    });
}
