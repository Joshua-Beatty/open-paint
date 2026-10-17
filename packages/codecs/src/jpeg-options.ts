import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import type { JpegSampling } from "./jpeg-encoder";
import { REMOVE_METADATA_PROPERTY } from "./save-options";

/**
 * The JPEG save options (FMT-OPT-JPG-01). The schema drives the Save Configuration panel, and
 * "Remove metadata" is its last item, as for every flat format (FMT-OPT-ALL-01).
 */
export const JPEG_SAVE_SCHEMA: PropertySchema = definePropertySchema({
  properties: [
    {
      kind: "int32",
      key: "quality",
      label: "fileOption.jpegQuality",
      defaultValue: 95,
      min: 0,
      max: 100,
    },
    {
      kind: "choice",
      key: "chromaSubsampling",
      label: "fileOption.chromaSubsampling",
      defaultValue: "420",
      options: [
        { value: "444", label: "fileOption.chromaSubsampling.ratio444" },
        { value: "440", label: "fileOption.chromaSubsampling.ratio440" },
        { value: "422", label: "fileOption.chromaSubsampling.ratio422" },
        { value: "420", label: "fileOption.chromaSubsampling.ratio420" },
      ],
    },
    REMOVE_METADATA_PROPERTY,
  ],
});

/** The typed JPEG save options, read from a save token. */
export interface JpegSaveOptions {
  readonly quality: number;
  readonly chromaSubsampling: JpegSampling;
  readonly removeMetadata: boolean;
}

const SAMPLINGS: readonly JpegSampling[] = ["444", "440", "422", "420"];

/** Reads a save token through the schema, so missing or invalid values fall back to the defaults. */
export function jpegSaveOptions(token: PropertyValues): JpegSaveOptions {
  const values = resolveValues(JPEG_SAVE_SCHEMA, token);
  const quality = typeof values.quality === "number" ? values.quality : 95;
  const sampling = SAMPLINGS.find((choice) => choice === values.chromaSubsampling) ?? "420";
  return {
    quality: Math.min(100, Math.max(0, Math.round(quality))),
    chromaSubsampling: sampling,
    removeMetadata: values.removeMetadata === true,
  };
}
