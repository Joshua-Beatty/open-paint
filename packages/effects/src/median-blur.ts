import { median_blur_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { distortedSurface, surfaceBytes } from "./distortion";
import type { EffectBinding } from "./framework/binding";

export const MEDIAN_BLUR_ID = "median-blur";

/** Parameters of Median Blur (FX-BLUR-MEDIAN-02). */
export interface MedianBlurParams {
  /** Radius of the circular neighborhood in pixels, 0-100. Zero disables the blur. */
  readonly radius: number;
  /** The percentile of the neighborhood, 0-100. 50 is the median. */
  readonly percentile: number;
  /** Bits of precision of the percentile search, 1-9. */
  readonly quality: number;
}

/** The Median Blur schema (FX-BLUR-MEDIAN-02), in the spec's order. */
export function medianBlurSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "radius",
        label: "property.radius",
        defaultValue: 10,
        min: 0,
        max: 100,
      },
      {
        kind: "int32",
        key: "percentile",
        label: "property.percentile",
        defaultValue: 50,
        min: 0,
        max: 100,
      },
      {
        kind: "int32",
        key: "quality",
        label: "property.quality",
        defaultValue: 8,
        min: 1,
        max: 9,
      },
    ],
  });
}

export function medianBlurDescriptor(): EffectDescriptor {
  return {
    id: MEDIAN_BLUR_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.medianBlur",
    icon: "icon.medianBlur",
    category: "effect",
    submenu: "blurs",
    configurable: true,
    kind: "gpuImage",
    schema: medianBlurSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Median Blur's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function medianBlurParams(values: PropertyValues): MedianBlurParams {
  const resolved = resolveValues(medianBlurSchema(), values);
  return {
    radius: numberValue(resolved, "radius"),
    percentile: numberValue(resolved, "percentile"),
    quality: numberValue(resolved, "quality"),
  };
}

/** The Rust reference of Median Blur (FX-BLUR-MEDIAN-03): returns the blurred `input`. */
export function medianBlurCpu(input: Surface, params: MedianBlurParams): Surface {
  const out = median_blur_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.radius,
    params.percentile,
    params.quality,
  );
  return distortedSurface(input, out);
}

/** The host binding of Median Blur: its descriptor, parameter reader and CPU reference. */
export function medianBlurBinding(): EffectBinding<MedianBlurParams> {
  return {
    descriptor: medianBlurDescriptor(),
    params: medianBlurParams,
    cpu: medianBlurCpu,
  };
}
