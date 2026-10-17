import { box_blur_rgba8, box_kernel } from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import type { EffectBinding } from "./framework/binding";
import type { GaussianBlurPlan } from "./gaussian-blur";

export const SQUARE_BLUR_ID = "square-blur";

/** Parameters of Square Blur (FX-BLUR-SQUARE-02). */
export interface SquareBlurParams {
  /** Radius of the box in pixels, 0-300. Fractional radii are allowed. 0 disables the blur. */
  readonly radius: number;
  /** Gamma Boost; the gamma exponent is e = 1 + gammaBoost. */
  readonly gammaBoost: number;
}

/** The Square Blur schema (FX-BLUR-SQUARE-02), in the spec's order. */
export function squareBlurSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "radius",
        label: "property.radius",
        defaultValue: 6,
        min: 0,
        max: 300,
        control: { decimalPlaces: 1, useExponentialScale: true },
      },
      {
        kind: "double",
        key: "gammaBoost",
        label: "property.gammaBoost",
        defaultValue: 0,
        min: -0.99,
        max: 2,
        control: { decimalPlaces: 2, useExponentialScale: true },
      },
    ],
  });
}

export function squareBlurDescriptor(): EffectDescriptor {
  return {
    id: SQUARE_BLUR_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.squareBlur",
    icon: "icon.squareBlur",
    category: "effect",
    submenu: "blurs",
    configurable: true,
    kind: "gpuImage",
    schema: squareBlurSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Square Blur's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function squareBlurParams(values: PropertyValues): SquareBlurParams {
  const resolved = resolveValues(squareBlurSchema(), values);
  return {
    radius: numberValue(resolved, "radius"),
    gammaBoost: numberValue(resolved, "gammaBoost"),
  };
}

/**
 * What both backends compute from the parameters: the box weights and the gamma exponent (FX-BLUR-SQUARE-03).
 * The weights come from the Rust reference, so the WGSL path uses the same numbers. The box runs at full
 * resolution, so the factor is 1. Undefined means the radius is 0 and the image passes through unchanged.
 * Requires the Rust/WASM kernels to be initialized.
 */
export function planSquareBlur(params: SquareBlurParams): GaussianBlurPlan | undefined {
  const radius = Math.fround(params.radius);
  if (radius === 0) return undefined;
  return {
    factor: 1,
    kernel: box_kernel(radius),
    exponent: Math.fround(1 + Math.fround(params.gammaBoost)),
    clamp: false,
  };
}

/** The Rust reference of Square Blur (FX-BLUR-SQUARE-03): returns the blurred `input` as a new surface. */
export function squareBlurCpu(input: Surface, params: SquareBlurParams): Surface {
  const bytes = new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength);
  const out = box_blur_rgba8(bytes, input.width, input.height, params.radius, params.gammaBoost);
  return new Surface(input.width, input.height, new Uint8ClampedArray(out));
}

/** The host binding of Square Blur: its descriptor, parameter reader and CPU reference. */
export function squareBlurBinding(): EffectBinding<SquareBlurParams> {
  return {
    descriptor: squareBlurDescriptor(),
    params: squareBlurParams,
    cpu: squareBlurCpu,
  };
}
