import { brightness_contrast_plan, soften_portrait_rgba8 } from "@openpaint/cpu";
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

export const SOFTEN_PORTRAIT_ID = "soften-portrait";

/** The Gaussian radius is Softness × 3 × 1.25, so σ = radius / 3 (FX-PHOTO-SOFTEN-01). */
const SOFTEN_RADIUS_FACTOR = 3 * 1.25;
/** The spec gives no quality for the Gaussian, so it uses Glow's high-quality mode. */
const SOFTEN_QUALITY = 4;

/** Parameters of Soften Portrait (FX-PHOTO-SOFTEN-01). */
export interface SoftenPortraitParams {
  /** Softness, 0-10. Sets the Gaussian radius. */
  readonly softness: number;
  /** Lighting, -20 to 20 (used as the spec's value / 100). */
  readonly lighting: number;
  /** Warmth, 0-20 (used as the spec's value / 100). */
  readonly warmth: number;
}

/** The Soften Portrait schema (FX-PHOTO-SOFTEN-01). */
export function softenPortraitSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "softness",
        label: "property.softness",
        defaultValue: 5,
        min: 0,
        max: 10,
        control: { decimalPlaces: 1 },
      },
      {
        kind: "int32",
        key: "lighting",
        label: "property.lighting",
        defaultValue: 0,
        min: -20,
        max: 20,
      },
      {
        kind: "int32",
        key: "warmth",
        label: "property.warmth",
        defaultValue: 10,
        min: 0,
        max: 20,
      },
    ],
  });
}

export function softenPortraitDescriptor(): EffectDescriptor {
  return {
    id: SOFTEN_PORTRAIT_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.softenPortrait",
    icon: "icon.softenPortrait",
    category: "effect",
    submenu: "photo",
    configurable: true,
    kind: "gpuImage",
    schema: softenPortraitSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Soften Portrait's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function softenPortraitParams(values: PropertyValues): SoftenPortraitParams {
  const resolved = resolveValues(softenPortraitSchema(), values);
  return {
    softness: numberValue(resolved, "softness"),
    lighting: numberValue(resolved, "lighting"),
    warmth: numberValue(resolved, "warmth"),
  };
}

/**
 * The numbers both backends compute from the parameters: the Gaussian radius and quality, the
 * Brightness / Contrast plan of the source branch (shift, multiplier, divisor), and the integer
 * Warmth, which the WGSL twin reads and divides by 100 itself.
 */
export interface SoftenPortraitPlan {
  readonly blurRadius: number;
  readonly blurQuality: number;
  readonly plan: Float32Array;
  readonly warmth: number;
}

/** Requires the Rust/WASM kernels to be initialized (`initCpu` in `@openpaint/engine`). */
export function planSoftenPortrait(params: SoftenPortraitParams): SoftenPortraitPlan {
  return {
    blurRadius: Math.fround(Math.fround(params.softness) * SOFTEN_RADIUS_FACTOR),
    blurQuality: SOFTEN_QUALITY,
    plan: brightness_contrast_plan(params.lighting, -params.lighting / 2),
    warmth: params.warmth,
  };
}

/** The Rust reference of Soften Portrait: returns the softened `input` as a new surface. */
export function softenPortraitCpu(input: Surface, params: SoftenPortraitParams): Surface {
  const out = soften_portrait_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.softness,
    params.lighting,
    params.warmth,
  );
  return distortedSurface(input, out);
}

/** The host binding of Soften Portrait: its descriptor, parameter reader and CPU reference. */
export function softenPortraitBinding(): EffectBinding<SoftenPortraitParams> {
  return {
    descriptor: softenPortraitDescriptor(),
    params: softenPortraitParams,
    cpu: softenPortraitCpu,
  };
}
