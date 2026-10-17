import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { REMOVE_METADATA_PROPERTY } from "./save-options";

/** The WebP encoder presets (FMT-OPT-WEBP-01), by their option value. */
export type WebpPreset = "default" | "picture" | "photo" | "drawing" | "icon" | "text";

const PRESETS: readonly WebpPreset[] = ["default", "picture", "photo", "drawing", "icon", "text"];

/**
 * The WebP save options (FMT-OPT-WEBP-01): Preset (default Photo), Quality (default 95, disabled
 * when Lossless is on), Lossless, and "Remove metadata" last.
 */
export const WEBP_SAVE_SCHEMA: PropertySchema = definePropertySchema({
  properties: [
    {
      kind: "choice",
      key: "preset",
      label: "fileOption.webpPreset",
      defaultValue: "photo",
      options: [
        { value: "default", label: "fileOption.webpPreset.default" },
        { value: "picture", label: "fileOption.webpPreset.picture" },
        { value: "photo", label: "fileOption.webpPreset.photo" },
        { value: "drawing", label: "fileOption.webpPreset.drawing" },
        { value: "icon", label: "fileOption.webpPreset.icon" },
        { value: "text", label: "fileOption.webpPreset.text" },
      ],
    },
    {
      kind: "int32",
      key: "quality",
      label: "fileOption.webpQuality",
      defaultValue: 95,
      min: 0,
      max: 100,
    },
    {
      kind: "boolean",
      key: "lossless",
      label: "fileOption.lossless",
      defaultValue: false,
    },
    REMOVE_METADATA_PROPERTY,
  ],
  rules: [
    {
      kind: "readOnlyWhenValue",
      target: "quality",
      source: "lossless",
      values: [true],
    },
  ],
});

/** The typed WebP save options, read from a save token. */
export interface WebpSaveOptions {
  readonly preset: WebpPreset;
  readonly quality: number;
  readonly lossless: boolean;
  readonly removeMetadata: boolean;
}

/** Reads a save token through the schema, so missing or invalid values fall back to the defaults. */
export function webpSaveOptions(token: PropertyValues): WebpSaveOptions {
  const values = resolveValues(WEBP_SAVE_SCHEMA, token);
  const quality = typeof values.quality === "number" ? values.quality : 95;
  const preset = PRESETS.find((choice) => choice === values.preset) ?? "photo";
  return {
    preset,
    quality: Math.min(100, Math.max(0, Math.round(quality))),
    lossless: values.lossless === true,
    removeMetadata: values.removeMetadata === true,
  };
}

/** WebP is lossless only when the Lossless option is on (FMT-REG-06). */
export function webpIsLossless(token: PropertyValues): boolean {
  return webpSaveOptions(token).lossless;
}
