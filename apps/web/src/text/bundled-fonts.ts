import fontFiles from "virtual:bundled-font-files";
import {
  BUNDLED_FONT_SPECS,
  type BundledFontSpec,
  COMPLETE,
  type FontStyle,
  fontFilePath,
  SUBSET_RANGES,
} from "./font-manifest";

/** One bundled face of one subset: its weight (or variable range), style and self-hosted file. */
export interface BundledFace {
  readonly weight: number | readonly [number, number];
  readonly style: FontStyle;
  readonly url: string;
  /** The characters the file covers, so the browser fetches it only for text that needs it. */
  readonly unicodeRange?: string;
}

/** A bundled family and its faces. Missing styles are synthesized by the browser. */
export interface BundledFamily {
  readonly family: string;
  readonly faces: readonly BundledFace[];
}

/** The families of the manifest, with each file's URL from the build, in `bundledFontFiles` order. */
export function bundledFamilies(
  specs: readonly BundledFontSpec[],
  urls: readonly string[],
): BundledFamily[] {
  let next = 0;
  const families = specs.map((spec) => ({
    family: spec.family,
    faces: spec.faces.flatMap((face) =>
      spec.subsets.map((subset) => {
        const url = urls[next++];
        if (url === undefined) {
          throw new Error(`The font file ${fontFilePath(spec, face, subset)} is not bundled.`);
        }
        const entry = { weight: face.weight, style: face.style, url };
        return subset === COMPLETE ? entry : { ...entry, unicodeRange: SUBSET_RANGES[subset] };
      }),
    ),
  }));
  if (next !== urls.length) throw new Error("The bundled font files do not match the manifest.");
  return families;
}

/**
 * The bundled families (WEB-FONT-01): sans, serif, mono, display, handwriting, rounded, condensed
 * and decorative, under the SIL Open Font License or the Apache License 2.0 (see the open-source
 * licenses in Settings). Their Latin and Latin Extended subsets are bundled, or the complete
 * upstream files of a family whose license reserves its name.
 */
export const BUNDLED_FAMILIES: readonly BundledFamily[] = bundledFamilies(
  BUNDLED_FONT_SPECS,
  fontFiles,
);

/** The bundled sans family: the default font (WEB-FONT-02). */
export const DEFAULT_FONT_FAMILY = "Noto Sans";

/** Every bundled font file, for the background download that makes all fonts work offline. */
export function bundledFontUrls(): string[] {
  return BUNDLED_FAMILIES.flatMap((family) => family.faces.map((face) => face.url));
}
