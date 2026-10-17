import { brightness_contrast_plan, glow_rgba8 } from "@openpaint/cpu";
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

export const GLOW_ID = "glow";

/** The Gaussian radius is the Radius times this factor (FX-PHOTO-GLOW-01). */
export const GLOW_RADIUS_FACTOR = 1.25;
/** Glow runs its Gaussian in high-quality mode (FX-PHOTO-GLOW-01). */
export const GLOW_QUALITY = 4;

/** Parameters of Glow (FX-PHOTO-GLOW-01). */
export interface GlowParams {
  /** Radius, 1-20. */
  readonly radius: number;
  /** Brightness, -100 to 100 (used as the spec's value / 100). */
  readonly brightness: number;
  /** Contrast, -100 to 100 (used as the spec's value / 100). */
  readonly contrast: number;
}

/** The Glow schema (FX-PHOTO-GLOW-01). */
export function glowSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "radius",
        label: "property.radius",
        defaultValue: 6,
        min: 1,
        max: 20,
        control: { decimalPlaces: 1 },
      },
      {
        kind: "int32",
        key: "brightness",
        label: "property.brightness",
        defaultValue: 10,
        min: -100,
        max: 100,
      },
      {
        kind: "int32",
        key: "contrast",
        label: "property.contrast",
        defaultValue: 10,
        min: -100,
        max: 100,
      },
    ],
  });
}

export function glowDescriptor(): EffectDescriptor {
  return {
    id: GLOW_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.glow",
    icon: "icon.glow",
    category: "effect",
    submenu: "photo",
    configurable: true,
    kind: "gpuImage",
    schema: glowSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Glow's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function glowParams(values: PropertyValues): GlowParams {
  const resolved = resolveValues(glowSchema(), values);
  return {
    radius: numberValue(resolved, "radius"),
    brightness: numberValue(resolved, "brightness"),
    contrast: numberValue(resolved, "contrast"),
  };
}

/**
 * The numbers both backends compute from the parameters: the Gaussian radius and quality, and the
 * Brightness / Contrast plan (shift, multiplier, divisor) that the WGSL twin reads.
 */
export interface GlowPlan {
  readonly blurRadius: number;
  readonly blurQuality: number;
  readonly plan: Float32Array;
}

/** Requires the Rust/WASM kernels to be initialized (`initCpu` in `@openpaint/engine`). */
export function planGlow(params: GlowParams): GlowPlan {
  return {
    blurRadius: Math.fround(Math.fround(params.radius) * GLOW_RADIUS_FACTOR),
    blurQuality: GLOW_QUALITY,
    plan: brightness_contrast_plan(params.brightness, params.contrast),
  };
}

/** The Rust reference of Glow: returns the glowed `input` as a new surface. */
export function glowCpu(input: Surface, params: GlowParams): Surface {
  const out = glow_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.radius,
    params.brightness,
    params.contrast,
  );
  return distortedSurface(input, out);
}

/** The host binding of Glow: its descriptor, parameter reader and CPU reference. */
export function glowBinding(): EffectBinding<GlowParams> {
  return {
    descriptor: glowDescriptor(),
    params: glowParams,
    cpu: glowCpu,
  };
}
