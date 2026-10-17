import type { PropertySchema, PropertyValues } from "@openpaint/properties";
import {
  INDEXED_SAVE_SCHEMA,
  type IndexedSaveOptions,
  indexedIsLossless,
  indexedPipelineOptions,
  indexedSaveOptions,
} from "./indexed-save-options";
import type { FormatTargets, PngPipelineOptions } from "./png-pipeline";

/** The depths BMP writes (FMT-OPT-BMP-01): no 2-bit, and no alpha palette. */
export const BMP_TARGETS: FormatTargets = { depths: [32, 24, 8, 4, 1], alphaPalette: false };

/** The BMP save options (FMT-OPT-BMP-01), the shared indexed-format schema. */
export const BMP_SAVE_SCHEMA: PropertySchema = INDEXED_SAVE_SCHEMA;

/** The typed BMP save options, read from a save token. */
export type BmpSaveOptions = IndexedSaveOptions;

/** Reads a BMP save token through the schema, so missing or invalid values fall back to the defaults. */
export function bmpSaveOptions(token: PropertyValues): BmpSaveOptions {
  return indexedSaveOptions(token);
}

/** The pipeline options of a BMP save. BMP has no transparency threshold (FMT-OPT-BMP-01). */
export function bmpPipelineOptions(options: BmpSaveOptions): PngPipelineOptions {
  return indexedPipelineOptions(options, BMP_TARGETS);
}

/** Whether a save with this token gives back the same pixels (FMT-REG-06): Auto-detect and 32-bit. */
export function bmpIsLossless(token: PropertyValues): boolean {
  return indexedIsLossless(token);
}
