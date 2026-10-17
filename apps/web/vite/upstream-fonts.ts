import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyrightOf, type OpenSourceComponent } from "./open-source-licenses.ts";

/** The folder of the upstream font files and their manifest, relative to the app. */
export const UPSTREAM_FONTS_FOLDER = "fonts";

/** One upstream file, as copied, with where it came from. */
export interface UpstreamFontFile {
  /** The copy, relative to the fonts folder. */
  readonly file: string;
  /** The file in the upstream repository. */
  readonly source: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** A family shipped as its upstream's complete, unmodified files. */
export interface UpstreamFontFamily {
  readonly family: string;
  readonly version: string;
  /** The name the license reserves, which only the unmodified files may use. */
  readonly reservedFontName: string;
  readonly repository: string;
  readonly commit: string;
  readonly license: { readonly file: string; readonly source: string };
  readonly files: readonly UpstreamFontFile[];
}

export function readUpstreamFonts(appDir: string): UpstreamFontFamily[] {
  const file = join(appDir, UPSTREAM_FONTS_FOLDER, "manifest.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { families: UpstreamFontFamily[] }).families;
}

/** The upstream font families as listed components, each with its OFL text. */
export function upstreamFontComponents(appDir: string): OpenSourceComponent[] {
  return readUpstreamFonts(appDir).map((family) => {
    const licenseText = readFileSync(
      join(appDir, UPSTREAM_FONTS_FOLDER, family.license.file),
      "utf8",
    )
      .replace(/\r\n/g, "\n")
      .trimEnd();
    return {
      name: family.family,
      title: family.family,
      kind: "font",
      version: family.version,
      license: "OFL-1.1",
      url: family.repository,
      copyright: copyrightOf(licenseText),
      licenseText,
    };
  });
}
