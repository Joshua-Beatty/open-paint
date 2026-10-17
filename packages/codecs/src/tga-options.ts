import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import type { BitDepthChoice, FormatTargets, PngPipelineOptions } from "./png-pipeline";
import { REMOVE_METADATA_PROPERTY } from "./save-options";

/** The depths TGA writes (FMT-OPT-TGA-01): true color, 24 or 32 bits. */
export const TGA_TARGETS: FormatTargets = { depths: [32, 24], alphaPalette: false };

/**
 * The TGA save options (FMT-OPT-TGA-01): Bit Depth, Compress (RLE) on by default, and "Remove
 * metadata" last. "Convert to sRGB" is [LATER] and is not shown.
 */
export const TGA_SAVE_SCHEMA: PropertySchema = definePropertySchema({
  properties: [
    {
      kind: "choice",
      key: "bitDepth",
      label: "fileOption.bitDepth",
      defaultValue: 0,
      options: [
        { value: 0, label: "fileOption.bitDepth.auto" },
        { value: 24, label: "fileOption.bitDepth.bits24" },
        { value: 32, label: "fileOption.bitDepth.bits32" },
      ],
      control: { controlType: "radioButtons" },
    },
    {
      kind: "boolean",
      key: "rle",
      label: "fileOption.compressRle",
      defaultValue: true,
    },
    REMOVE_METADATA_PROPERTY,
  ],
});

/** The typed TGA save options, read from a save token. */
export interface TgaSaveOptions {
  readonly bitDepth: BitDepthChoice;
  readonly rle: boolean;
  readonly removeMetadata: boolean;
}

/** Reads a save token through the schema, so missing or invalid values fall back to the defaults. */
export function tgaSaveOptions(token: PropertyValues): TgaSaveOptions {
  const values = resolveValues(TGA_SAVE_SCHEMA, token);
  return {
    bitDepth: numberOf(values.bitDepth) as BitDepthChoice,
    rle: values.rle !== false,
    removeMetadata: values.removeMetadata === true,
  };
}

/** The pipeline options of a TGA save. TGA has no palette and no transparency threshold. */
export function tgaPipelineOptions(options: TgaSaveOptions): PngPipelineOptions {
  return {
    bitDepth: options.bitDepth,
    quantization: "octree",
    dithering: 0,
    transparencyThreshold: 0,
    targets: TGA_TARGETS,
  };
}

/** Whether a save with this token gives back the same pixels (FMT-REG-06): Auto-detect and 32-bit. */
export function tgaIsLossless(token: PropertyValues): boolean {
  const { bitDepth } = tgaSaveOptions(token);
  return bitDepth === 0 || bitDepth === 32;
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
