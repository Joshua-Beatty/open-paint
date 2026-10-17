import { surface_blur_rgba8, surface_slope } from "@openpaint/cpu";
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

export const SURFACE_BLUR_ID = "surface-blur";

/** Parameters of Surface Blur (FX-BLUR-SURFACE-02). */
export interface SurfaceBlurParams {
  /** Radius of the circular kernel in pixels, 1-50. */
  readonly radius: number;
  /** The edge threshold, 1-100, used as a fraction of 1 (FX-BLUR-SURFACE-03). */
  readonly threshold: number;
}

/** The Surface Blur schema (FX-BLUR-SURFACE-02), in the spec's order. */
export function surfaceBlurSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "radius",
        label: "property.radius",
        defaultValue: 6,
        min: 1,
        max: 50,
      },
      {
        kind: "int32",
        key: "threshold",
        label: "property.threshold",
        defaultValue: 15,
        min: 1,
        max: 100,
      },
    ],
  });
}

export function surfaceBlurDescriptor(): EffectDescriptor {
  return {
    id: SURFACE_BLUR_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.surfaceBlur",
    icon: "icon.surfaceBlur",
    category: "effect",
    submenu: "blurs",
    configurable: true,
    kind: "gpuImage",
    schema: surfaceBlurSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Surface Blur's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function surfaceBlurParams(values: PropertyValues): SurfaceBlurParams {
  const resolved = resolveValues(surfaceBlurSchema(), values);
  return {
    radius: numberValue(resolved, "radius"),
    threshold: numberValue(resolved, "threshold"),
  };
}

/**
 * The weight slope `k = 1 / (0.96 · T)` of Surface Blur (FX-BLUR-SURFACE-03). The GPU takes it from
 * the same Rust function, so both backends use one value. Requires the WASM kernels to be initialized.
 */
export function surfaceBlurSlope(params: SurfaceBlurParams): number {
  return surface_slope(params.threshold);
}

/** The Rust reference of Surface Blur (FX-BLUR-SURFACE-03): returns the blurred `input`. */
export function surfaceBlurCpu(input: Surface, params: SurfaceBlurParams): Surface {
  const out = surface_blur_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.radius,
    params.threshold,
  );
  return distortedSurface(input, out);
}

/** The host binding of Surface Blur: its descriptor, parameter reader and CPU reference. */
export function surfaceBlurBinding(): EffectBinding<SurfaceBlurParams> {
  return {
    descriptor: surfaceBlurDescriptor(),
    params: surfaceBlurParams,
    cpu: surfaceBlurCpu,
  };
}
