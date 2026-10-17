import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { REMOVE_METADATA_PROPERTY } from "./save-options";

/**
 * The JPEG XL save options (FMT-OPT-JXL-01): Quality (default 90, disabled when Lossless is on),
 * Lossless, Effort (default 7, 1 to 9) and "Remove metadata" last.
 */
export const JXL_SAVE_SCHEMA: PropertySchema = definePropertySchema({
  properties: [
    {
      kind: "int32",
      key: "quality",
      label: "fileOption.jxlQuality",
      defaultValue: 90,
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
      kind: "int32",
      key: "effort",
      label: "fileOption.jxlEffort",
      control: { description: "fileOption.jxlEffort.description" },
      defaultValue: 7,
      min: 1,
      max: 9,
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

/** The typed JPEG XL save options, read from a save token. */
export interface JxlSaveOptions {
  readonly quality: number;
  readonly lossless: boolean;
  readonly effort: number;
  readonly removeMetadata: boolean;
}

/** Reads a save token through the schema, so missing or invalid values fall back to the defaults. */
export function jxlSaveOptions(token: PropertyValues): JxlSaveOptions {
  const values = resolveValues(JXL_SAVE_SCHEMA, token);
  const quality = typeof values.quality === "number" ? values.quality : 90;
  const effort = typeof values.effort === "number" ? values.effort : 7;
  return {
    quality: Math.min(100, Math.max(0, Math.round(quality))),
    lossless: values.lossless === true,
    effort: Math.min(9, Math.max(1, Math.round(effort))),
    removeMetadata: values.removeMetadata === true,
  };
}
