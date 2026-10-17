/**
 * The bundled font families (WEB-FONT-01), as data the build and the app both read. Most families
 * are a Fontsource npm package pinned in package.json (tarball integrity in pnpm-lock.yaml), whose
 * files are Google Fonts' subsets of the upstream font. A font whose license reserves its name may
 * not ship as a subset (a modified version) under that name, so those families ship as their
 * upstream's complete, unmodified files instead, copied into fonts/<id>/ with their source, version
 * and hash in fonts/manifest.json. The build turns each file into a self-hosted asset
 * (vite/bundled-fonts.ts) and lists each family with its license text in the third-party notices.
 * Only SIL Open Font License 1.1 and Apache 2.0 fonts are bundled.
 */

/** The script subsets bundled: Latin, and Latin Extended loaded only for the characters it covers. */
export type FontSubset = "latin" | "latin-ext";

/** A complete font file, as its upstream ships it, used for every character it has. */
export const COMPLETE = "complete";

/** The files of a face: a subset, or the complete font. */
export type FontFileSet = FontSubset | typeof COMPLETE;

export type FontStyle = "normal" | "italic";

/** One face of a family, in each of its subsets. */
export interface FontFileSpec {
  /** The file in the package's `files` folder, with `{subset}` standing for the subset name. */
  readonly file: string;
  /** A weight, or the range a variable face covers. */
  readonly weight: number | readonly [number, number];
  readonly style: FontStyle;
}

export interface BundledFontSpec {
  readonly family: string;
  /** The npm package the files come from, or the app folder ("/fonts/<id>") of upstream files. */
  readonly package: string;
  readonly subsets: readonly FontFileSet[];
  readonly faces: readonly FontFileSpec[];
}

const LATIN: readonly FontSubset[] = ["latin", "latin-ext"];
const LATIN_ONLY: readonly FontSubset[] = ["latin"];

/** A family with one variable weight axis, upright and, where it has one, italic. */
function variable(
  family: string,
  id: string,
  weights: readonly [number, number],
  italic: boolean,
): BundledFontSpec {
  const styles: readonly FontStyle[] = italic ? ["normal", "italic"] : ["normal"];
  return {
    family,
    package: `@fontsource-variable/${id}`,
    subsets: LATIN,
    faces: styles.map((style) => ({
      file: `${id}-{subset}-wght-${style}.woff2`,
      weight: weights,
      style,
    })),
  };
}

/** A family of static faces: each weight in each style. */
function fixed(
  family: string,
  id: string,
  weights: readonly number[],
  styles: readonly FontStyle[] = ["normal"],
  subsets: readonly FontSubset[] = LATIN,
): BundledFontSpec {
  return {
    family,
    package: `@fontsource/${id}`,
    subsets,
    faces: styles.flatMap((style) =>
      weights.map((weight) => ({ file: `${id}-{subset}-${weight}-${style}.woff2`, weight, style })),
    ),
  };
}

const BOTH: readonly FontStyle[] = ["normal", "italic"];

/** The folder of the upstream font files, relative to the app; the build resolves it from there. */
export const UPSTREAM_FONTS_DIR = "/fonts";

/**
 * A family shipped as its upstream's complete, unmodified files (fonts/<id>/), as the Reserved
 * Font Name of its license requires.
 */
function upstream(family: string, id: string, faces: readonly FontFileSpec[]): BundledFontSpec {
  return { family, package: `${UPSTREAM_FONTS_DIR}/${id}`, subsets: [COMPLETE], faces };
}

/** Four static faces: regular, italic, bold and bold italic. */
function fourStatic(regular: string, italic: string, bold: string, boldItalic: string) {
  return [
    { file: regular, weight: 400, style: "normal" },
    { file: italic, weight: 400, style: "italic" },
    { file: bold, weight: 700, style: "normal" },
    { file: boldItalic, weight: 700, style: "italic" },
  ] as const;
}

/**
 * The bundled families: sans serif, serif, monospace, display, handwriting, rounded, condensed and
 * decorative faces. The picker lists them by name. Noto Sans is the default (WEB-FONT-02).
 */
export const BUNDLED_FONT_SPECS: readonly BundledFontSpec[] = [
  fixed("Noto Sans", "noto-sans", [400, 700], BOTH),
  variable("Inter", "inter", [100, 900], true),
  variable("Roboto", "roboto", [100, 900], true),
  variable("Open Sans", "open-sans", [300, 800], true),
  variable("Montserrat", "montserrat", [100, 900], true),
  fixed("Noto Serif", "noto-serif", [400, 700], BOTH),
  variable("EB Garamond", "eb-garamond", [400, 800], true),
  fixed("Libre Baskerville", "libre-baskerville", [400, 700], BOTH),
  upstream("Lora", "lora", [
    { file: "Lora[wght].woff2", weight: [400, 700], style: "normal" },
    { file: "Lora-Italic[wght].woff2", weight: [400, 700], style: "italic" },
  ]),
  upstream(
    "Playfair Display",
    "playfair-display",
    fourStatic(
      "PlayfairDisplay-Regular.woff2",
      "PlayfairDisplay-Italic.woff2",
      "PlayfairDisplay-Bold.woff2",
      "PlayfairDisplay-BoldItalic.woff2",
    ),
  ),
  upstream(
    "Merriweather",
    "merriweather",
    fourStatic(
      "Merriweather-Regular.woff2",
      "Merriweather-Italic.woff2",
      "Merriweather-Bold.woff2",
      "Merriweather-BoldItalic.woff2",
    ),
  ),
  variable("Crimson Pro", "crimson-pro", [200, 900], true),
  variable("Roboto Slab", "roboto-slab", [100, 900], false),
  fixed("Noto Sans Mono", "noto-sans-mono", [400, 700]),
  variable("JetBrains Mono", "jetbrains-mono", [100, 800], true),
  fixed("Courier Prime", "courier-prime", [400, 700], BOTH),
  fixed("Bebas Neue", "bebas-neue", [400]),
  fixed("Anton", "anton", [400]),
  fixed("Archivo Black", "archivo-black", [400]),
  variable("Fraunces", "fraunces", [100, 900], true),
  fixed("Caveat", "caveat", [400, 700]),
  fixed("Pacifico", "pacifico", [400]),
  upstream("Lobster", "lobster", [{ file: "Lobster-Regular.otf", weight: 400, style: "normal" }]),
  fixed("Great Vibes", "great-vibes", [400]),
  fixed("Satisfy", "satisfy", [400], ["normal"], LATIN_ONLY),
  fixed("Indie Flower", "indie-flower", [400]),
  fixed("Permanent Marker", "permanent-marker", [400], ["normal"], LATIN_ONLY),
  variable("Nunito", "nunito", [200, 1000], true),
  variable("Fredoka", "fredoka", [300, 700], false),
  variable("Oswald", "oswald", [200, 700], false),
  variable("Roboto Condensed", "roboto-condensed", [100, 900], true),
  fixed("Bangers", "bangers", [400]),
  variable("Pixelify Sans", "pixelify-sans", [400, 700], false),
  fixed("Special Elite", "special-elite", [400]),
];

/**
 * The characters each subset covers, as CSS `unicode-range` values. They are Google Fonts' subset
 * ranges, which every Fontsource package uses, so a face is fetched only for text that needs it.
 */
export const SUBSET_RANGES: Readonly<Record<FontSubset, string>> = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext":
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
};

/**
 * The path of one face's file, as the build imports it: a package path for a subset, or a path
 * under the app folder ("/fonts/...") for an upstream file.
 */
export function fontFilePath(
  spec: BundledFontSpec,
  face: FontFileSpec,
  subset: FontFileSet,
): string {
  if (subset === COMPLETE) return `${spec.package}/${face.file}`;
  return `${spec.package}/files/${face.file.replace("{subset}", subset)}`;
}

/** Whether a font file path is one of the app's upstream files rather than a package's. */
export function isUpstreamFontPath(path: string): boolean {
  return path.startsWith(`${UPSTREAM_FONTS_DIR}/`);
}

/** Every file the bundled families use. */
export function bundledFontFiles(specs: readonly BundledFontSpec[] = BUNDLED_FONT_SPECS): string[] {
  return specs.flatMap((spec) =>
    spec.faces.flatMap((face) => spec.subsets.map((subset) => fontFilePath(spec, face, subset))),
  );
}
