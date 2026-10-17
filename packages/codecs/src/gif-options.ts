import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import type { FormatTargets, PaletteAlgorithm, PngPipelineOptions } from "./png-pipeline";
import { REMOVE_METADATA_PROPERTY } from "./save-options";

/** GIF writes one 8-bit palette, with the 1-bit alpha entry when a pixel is not opaque (FMT-OPT-GIF-01). */
export const GIF_TARGETS: FormatTargets = { depths: [8], alphaPalette: true };

/**
 * The GIF save options (FMT-OPT-GIF-01). The palette is always 8-bit, so no option picks a bit depth.
 * "Remove metadata" is last, as for every flat format.
 */
export const GIF_SAVE_SCHEMA: PropertySchema = definePropertySchema({
  properties: [
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
  rules: [],
});

/** The typed GIF save options, read from a save token. */
export interface GifSaveOptions {
  readonly transparencyThreshold: number;
  readonly quantization: PaletteAlgorithm;
  readonly dithering: number;
  readonly removeMetadata: boolean;
}

/** Reads a save token through the schema, so missing or invalid values fall back to the defaults. */
export function gifSaveOptions(token: PropertyValues): GifSaveOptions {
  const values = resolveValues(GIF_SAVE_SCHEMA, token);
  return {
    transparencyThreshold: numberOf(values.transparencyThreshold),
    quantization: values.quantization === "medianCut" ? "medianCut" : "octree",
    dithering: numberOf(values.dithering),
    removeMetadata: values.removeMetadata === true,
  };
}

/** The pipeline options of a GIF save: an 8-bit palette, with the transparency threshold (FMT-QNT-03). */
export function gifPipelineOptions(options: GifSaveOptions): PngPipelineOptions {
  return {
    bitDepth: 8,
    quantization: options.quantization,
    dithering: options.dithering,
    transparencyThreshold: options.transparencyThreshold,
    targets: GIF_TARGETS,
  };
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
