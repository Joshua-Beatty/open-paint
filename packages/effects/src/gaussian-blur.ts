import { gaussian_blur_rgba8, gaussian_downsample_factor, gaussian_kernel } from "@openpaint/cpu";
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

export const GAUSSIAN_BLUR_ID = "gaussian-blur";

/** Parameters of Gaussian Blur (FX-BLUR-GAUSS-02). */
export interface GaussianBlurParams {
  /** Radius in pixels; σ = radius / 3. 0 disables the blur. */
  readonly radius: number;
  /** Gamma Boost; the gamma exponent is e = 1 + gammaBoost. */
  readonly gammaBoost: number;
  /** Quality level 1 (Speed) to 4 (High Quality). */
  readonly quality: number;
}

/**
 * The Gaussian Blur schema. The Quality default follows the Default Quality Level factory value
 * (FX-A-00-03): 3 when the factory level is 1, otherwise 4.
 */
export function gaussianBlurSchema(factoryQualityLevel: 1 | 2): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "radius",
        label: "property.radius",
        defaultValue: 2,
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
      {
        kind: "int32",
        key: "quality",
        label: "property.quality",
        defaultValue: factoryQualityLevel === 1 ? 3 : 4,
        min: 1,
        max: 4,
      },
    ],
  });
}

export function gaussianBlurDescriptor(factoryQualityLevel: 1 | 2): EffectDescriptor {
  return {
    id: GAUSSIAN_BLUR_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.gaussianBlur",
    icon: "icon.gaussianBlur",
    category: "effect",
    submenu: "blurs",
    configurable: true,
    kind: "gpuImage",
    schema: gaussianBlurSchema(factoryQualityLevel),
    options: { gpu: { workingSpace: "linear" } },
  };
}

/** The host binding of Gaussian Blur: its descriptor, parameter reader and CPU reference. */
export function gaussianBlurBinding(factoryQualityLevel: 1 | 2): EffectBinding<GaussianBlurParams> {
  return {
    descriptor: gaussianBlurDescriptor(factoryQualityLevel),
    params: (values) => gaussianBlurParams(values, factoryQualityLevel),
    cpu: gaussianBlurCpu,
  };
}

/** Reads a parameter set for Gaussian Blur, clamped to the schema's ranges. */
export function gaussianBlurParams(
  values: PropertyValues,
  factoryQualityLevel: 1 | 2 = 2,
): GaussianBlurParams {
  const resolved = resolveValues(gaussianBlurSchema(factoryQualityLevel), values);
  return {
    radius: numberValue(resolved, "radius"),
    gammaBoost: numberValue(resolved, "gammaBoost"),
    quality: numberValue(resolved, "quality"),
  };
}

/**
 * What both backends compute from the parameters: the downsample factor, the blur kernel and the
 * gamma exponent. The values come from the Rust reference, so the WGSL path uses the same numbers.
 * Undefined means the radius is 0 and the image passes through unchanged.
 */
export interface GaussianBlurPlan {
  /** Downsample factor before blurring (1 = full resolution). */
  readonly factor: number;
  /** Normalized weights for offsets -R..=R at the (possibly downsampled) resolution. */
  readonly kernel: Float32Array;
  /** Gamma exponent e = 1 + gammaBoost, as f32. */
  readonly exponent: number;
  /** True when samples outside the image read the nearest edge pixel (Glow), not a mirror. */
  readonly clamp: boolean;
}

/**
 * The border a separable blur reads outside the image: "mirror" is the Gaussian's hard border
 * (FX-BLUR-GAUSS-03), and "clamp" is the edge replication of Glow (FX-PHOTO-GLOW-01).
 */
export type GaussianBorder = "mirror" | "clamp";

/** Requires the Rust/WASM kernels to be initialized (`initCpu` in `@openpaint/engine`). */
export function planGaussianBlur(
  params: GaussianBlurParams,
  border: GaussianBorder = "mirror",
): GaussianBlurPlan | undefined {
  const radius = Math.fround(params.radius);
  if (radius === 0) return undefined;
  const sigma = Math.fround(radius / 3);
  const factor = gaussian_downsample_factor(params.quality, sigma);
  return {
    factor,
    kernel: gaussian_kernel(Math.fround(sigma / factor)),
    exponent: Math.fround(1 + Math.fround(params.gammaBoost)),
    clamp: border === "clamp",
  };
}

/** The Rust reference: returns the blurred `input` as a new surface. */
export function gaussianBlurCpu(input: Surface, params: GaussianBlurParams): Surface {
  const bytes = new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength);
  const out = gaussian_blur_rgba8(
    bytes,
    input.width,
    input.height,
    params.radius,
    params.gammaBoost,
    params.quality,
  );
  return new Surface(input.width, input.height, new Uint8ClampedArray(out));
}
