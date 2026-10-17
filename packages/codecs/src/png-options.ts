import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import type { BitDepthChoice, PaletteAlgorithm, PngPipelineOptions } from "./png-pipeline";
import { REMOVE_METADATA_PROPERTY } from "./save-options";

/**
 * The PNG save options (FMT-OPT-PNG-01). Quantization and dithering are enabled only for the indexed
 * depths, and the transparency threshold only for 8-bit. The schema drives the Save Configuration
 * panel, so the rules are the whole enable logic.
 */
export const PNG_SAVE_SCHEMA: PropertySchema = definePropertySchema({
  properties: [
    {
      kind: "choice",
      key: "bitDepth",
      label: "fileOption.pngBitDepth",
      defaultValue: 0,
      options: [
        { value: 0, label: "fileOption.bitDepth.auto" },
        { value: 32, label: "fileOption.bitDepth.bits32" },
        { value: 24, label: "fileOption.bitDepth.bits24" },
        { value: 8, label: "fileOption.bitDepth.bits8" },
        { value: 4, label: "fileOption.bitDepth.bits4" },
        { value: 2, label: "fileOption.bitDepth.bits2" },
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
    {
      kind: "int32",
      key: "transparencyThreshold",
      label: "fileOption.transparencyThreshold",
      defaultValue: 128,
      min: 0,
      max: 255,
      control: { description: "fileOption.transparencyThreshold.description" },
    },
    {
      kind: "boolean",
      key: "interlaced",
      label: "fileOption.interlaced",
      defaultValue: false,
    },
    REMOVE_METADATA_PROPERTY,
  ],
  rules: [
    {
      kind: "readOnlyWhenValue",
      target: "quantization",
      source: "bitDepth",
      values: [8, 4, 2, 1],
      inverted: true,
    },
    {
      kind: "readOnlyWhenValue",
      target: "dithering",
      source: "bitDepth",
      values: [8, 4, 2, 1],
      inverted: true,
    },
    {
      kind: "readOnlyWhenValue",
      target: "transparencyThreshold",
      source: "bitDepth",
      values: [8],
      inverted: true,
    },
  ],
});

/** The typed PNG save options, read from a save token. */
export interface PngSaveOptions {
  readonly bitDepth: BitDepthChoice;
  readonly quantization: PaletteAlgorithm;
  readonly dithering: number;
  readonly transparencyThreshold: number;
  readonly interlaced: boolean;
  readonly removeMetadata: boolean;
}

/** Reads a save token through the schema, so missing or invalid values fall back to the defaults. */
export function pngSaveOptions(token: PropertyValues): PngSaveOptions {
  const values = resolveValues(PNG_SAVE_SCHEMA, token);
  return {
    bitDepth: numberOf(values.bitDepth) as BitDepthChoice,
    quantization: values.quantization === "medianCut" ? "medianCut" : "octree",
    dithering: numberOf(values.dithering),
    transparencyThreshold: numberOf(values.transparencyThreshold),
    interlaced: values.interlaced === true,
    removeMetadata: values.removeMetadata === true,
  };
}

/** The pipeline options of a save: the depth, palette and threshold choices. */
export function pngPipelineOptions(options: PngSaveOptions): PngPipelineOptions {
  return {
    bitDepth: options.bitDepth,
    quantization: options.quantization,
    dithering: options.dithering,
    transparencyThreshold: options.transparencyThreshold,
  };
}

/** Whether a save with this token gives back the same pixels (FMT-REG-06): Auto-detect and 32-bit. */
export function pngIsLossless(token: PropertyValues): boolean {
  const { bitDepth } = pngSaveOptions(token);
  return bitDepth === 0 || bitDepth === 32;
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
