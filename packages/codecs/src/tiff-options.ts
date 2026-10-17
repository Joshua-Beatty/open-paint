import type { PropertySchema, PropertyValues } from "@openpaint/properties";
import {
  INDEXED_SAVE_SCHEMA,
  type IndexedSaveOptions,
  indexedIsLossless,
  indexedPipelineOptions,
  indexedSaveOptions,
} from "./indexed-save-options";
import type { FormatTargets, PngPipelineOptions } from "./png-pipeline";

/**
 * The depths TIFF writes (FMT-OPT-TIF-01): RGBA, RGB and the 8, 4 and 1-bit palettes. No 2-bit depth,
 * and no alpha palette, so a partly transparent pixel is composited over white.
 */
export const TIFF_TARGETS: FormatTargets = { depths: [32, 24, 8, 4, 1], alphaPalette: false };

/** The TIFF save options (FMT-OPT-TIF-01), the shared indexed-format schema. */
export const TIFF_SAVE_SCHEMA: PropertySchema = INDEXED_SAVE_SCHEMA;

/** The typed TIFF save options, read from a save token. */
export type TiffSaveOptions = IndexedSaveOptions;

/** Reads a TIFF save token through the schema, so missing or invalid values fall back to the defaults. */
export function tiffSaveOptions(token: PropertyValues): TiffSaveOptions {
  return indexedSaveOptions(token);
}

/** The pipeline options of a TIFF save. TIFF has no transparency threshold (FMT-OPT-TIF-01). */
export function tiffPipelineOptions(options: TiffSaveOptions): PngPipelineOptions {
  return indexedPipelineOptions(options, TIFF_TARGETS);
}

/** Whether a save with this token gives back the same pixels (FMT-REG-06): Auto-detect and 32-bit. */
export function tiffIsLossless(token: PropertyValues): boolean {
  return indexedIsLossless(token);
}
