import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { REMOVE_METADATA_PROPERTY } from "./save-options";

/** The AVIF chroma subsampling choices (FMT-OPT-AVIF-01), by their option value. */
export type AvifSampling = "420" | "422" | "444";

/** The AVIF encoder presets (FMT-OPT-AVIF-01), by their option value. */
export type AvifPreset = "fast" | "medium" | "slow" | "verySlow";

/** The rav1e speed for each preset: 1 is the slowest and smallest, 10 the fastest. */
const SPEEDS: Record<AvifPreset, number> = { fast: 8, medium: 6, slow: 4, verySlow: 2 };

/** The chroma id the WASM encoder takes: 0 is 4:2:0, 1 is 4:2:2 and 2 is 4:4:4. */
const CHROMA_IDS: Record<AvifSampling, number> = { "420": 0, "422": 1, "444": 2 };

/**
 * The AVIF save options (FMT-OPT-AVIF-01). Quality, Lossless Alpha Compression, Chroma Subsampling
 * and Premultiplied Alpha are disabled when Lossless is on, as the spec requires. "Remove metadata"
 * is last.
 */
export const AVIF_SAVE_SCHEMA: PropertySchema = definePropertySchema({
  properties: [
    {
      kind: "int32",
      key: "quality",
      label: "fileOption.avifQuality",
      defaultValue: 85,
      min: 0,
      max: 100,
    },
    {
      kind: "boolean",
      key: "lossless",
      label: "fileOption.lossless",
      defaultValue: false,
    },
    {
      kind: "boolean",
      key: "losslessAlpha",
      label: "fileOption.avifLosslessAlpha",
      defaultValue: true,
    },
    {
      kind: "choice",
      key: "preset",
      label: "fileOption.avifEncoderPreset",
      defaultValue: "fast",
      options: [
        { value: "fast", label: "fileOption.avifEncoderPreset.fast" },
        { value: "medium", label: "fileOption.avifEncoderPreset.medium" },
        { value: "slow", label: "fileOption.avifEncoderPreset.slow" },
        { value: "verySlow", label: "fileOption.avifEncoderPreset.verySlow" },
      ],
    },
    {
      kind: "choice",
      key: "chromaSubsampling",
      label: "fileOption.chromaSubsampling",
      defaultValue: "422",
      options: [
        { value: "420", label: "fileOption.chromaSubsampling.ratio420" },
        { value: "422", label: "fileOption.chromaSubsampling.ratio422" },
        { value: "444", label: "fileOption.chromaSubsampling.ratio444" },
      ],
    },
    {
      kind: "boolean",
      key: "preserveTileSize",
      label: "fileOption.avifPreserveTileSize",
      defaultValue: true,
    },
    {
      kind: "boolean",
      key: "premultipliedAlpha",
      label: "fileOption.avifPremultipliedAlpha",
      defaultValue: false,
    },
    REMOVE_METADATA_PROPERTY,
  ],
  rules: [
    { kind: "readOnlyWhenValue", target: "quality", source: "lossless", values: [true] },
    { kind: "readOnlyWhenValue", target: "losslessAlpha", source: "lossless", values: [true] },
    {
      kind: "readOnlyWhenValue",
      target: "chromaSubsampling",
      source: "lossless",
      values: [true],
    },
    {
      kind: "readOnlyWhenValue",
      target: "premultipliedAlpha",
      source: "lossless",
      values: [true],
    },
  ],
});

/** The typed AVIF save options, read from a save token. */
export interface AvifSaveOptions {
  /** 1 to 100 (the encoder's range), used when the image is not lossless. */
  readonly quality: number;
  readonly lossless: boolean;
  readonly losslessAlpha: boolean;
  readonly speed: number;
  readonly chroma: number;
  readonly premultipliedAlpha: boolean;
  readonly removeMetadata: boolean;
}

const PRESETS: readonly AvifPreset[] = ["fast", "medium", "slow", "verySlow"];
const SAMPLINGS: readonly AvifSampling[] = ["420", "422", "444"];

/** Reads a save token through the schema, so missing or invalid values fall back to the defaults. */
export function avifSaveOptions(token: PropertyValues): AvifSaveOptions {
  const values = resolveValues(AVIF_SAVE_SCHEMA, token);
  const quality = typeof values.quality === "number" ? values.quality : 85;
  const preset = PRESETS.find((choice) => choice === values.preset) ?? "fast";
  const sampling = SAMPLINGS.find((choice) => choice === values.chromaSubsampling) ?? "422";
  return {
    quality: Math.min(100, Math.max(1, Math.round(quality))),
    lossless: values.lossless === true,
    losslessAlpha: values.lossless === true || values.losslessAlpha !== false,
    speed: SPEEDS[preset],
    chroma: CHROMA_IDS[sampling],
    premultipliedAlpha: values.premultipliedAlpha === true,
    removeMetadata: values.removeMetadata === true,
  };
}

/** AVIF is lossless only when the Lossless option is on (FMT-REG-06). */
export function avifIsLossless(token: PropertyValues): boolean {
  return avifSaveOptions(token).lossless;
}
