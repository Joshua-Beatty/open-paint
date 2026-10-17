import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import type {
  BitDepthChoice,
  FormatTargets,
  PaletteAlgorithm,
  PngPipelineOptions,
} from "./png-pipeline";
import { REMOVE_METADATA_PROPERTY } from "./save-options";

/**
 * The save options of the flat formats that write Auto-detect, 32, 24, 8, 4 and 1-bit output (BMP and
 * TIFF, FMT-OPT-BMP-01 and FMT-OPT-TIF-01). The palette options are enabled only for the indexed depths.
 * "Remove metadata" is last, as for every flat format.
 */
export const INDEXED_SAVE_SCHEMA: PropertySchema = definePropertySchema({
  properties: [
    {
      kind: "choice",
      key: "bitDepth",
      label: "fileOption.bitDepth",
      defaultValue: 0,
      options: [
        { value: 0, label: "fileOption.bitDepth.auto" },
        { value: 32, label: "fileOption.bitDepth.bits32" },
        { value: 24, label: "fileOption.bitDepth.bits24" },
        { value: 8, label: "fileOption.bitDepth.bits8" },
        { value: 4, label: "fileOption.bitDepth.bits4" },
        { value: 1, label: "fileOption.bitDepth.bits1" },
      ],
      control: { controlType: "radioButtons" },
    },
    {
      kind: "choice",
      key: "quantization",
      label: "fileOption.quantization",
      defaultValue: "octree",
      options: [
        { value: "medianCut", label: "fileOption.quantization.medianCut" },
        { value: "octree", label: "fileOption.quantization.octree" },
      ],
    },
    {
      kind: "int32",
      key: "dithering",
      label: "fileOption.dithering",
      defaultValue: 7,
      min: 0,
      max: 8,
    },
    REMOVE_METADATA_PROPERTY,
  ],
  rules: [
    {
      kind: "readOnlyWhenValue",
      target: "quantization",
      source: "bitDepth",
      values: [8, 4, 1],
      inverted: true,
    },
    {
      kind: "readOnlyWhenValue",
      target: "dithering",
      source: "bitDepth",
      values: [8, 4, 1],
      inverted: true,
    },
  ],
});

/** The typed save options of an indexed-capable flat format, read from a save token. */
export interface IndexedSaveOptions {
  readonly bitDepth: BitDepthChoice;
  readonly quantization: PaletteAlgorithm;
  readonly dithering: number;
  readonly removeMetadata: boolean;
}

/** Reads a save token through the schema, so missing or invalid values fall back to the defaults. */
export function indexedSaveOptions(token: PropertyValues): IndexedSaveOptions {
  const values = resolveValues(INDEXED_SAVE_SCHEMA, token);
  return {
    bitDepth: numberOf(values.bitDepth) as BitDepthChoice,
    quantization: values.quantization === "medianCut" ? "medianCut" : "octree",
    dithering: numberOf(values.dithering),
    removeMetadata: values.removeMetadata === true,
  };
}

/** The pipeline options of a save. These formats have no transparency threshold (FMT-OPT-BMP-01). */
export function indexedPipelineOptions(
  options: IndexedSaveOptions,
  targets: FormatTargets,
): PngPipelineOptions {
  return {
    bitDepth: options.bitDepth,
    quantization: options.quantization,
    dithering: options.dithering,
    transparencyThreshold: 0,
    targets,
  };
}

/** Whether a save with this token gives back the same pixels (FMT-REG-06): Auto-detect and 32-bit. */
export function indexedIsLossless(token: PropertyValues): boolean {
  const { bitDepth } = indexedSaveOptions(token);
  return bitDepth === 0 || bitDepth === 32;
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
