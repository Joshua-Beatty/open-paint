import { vignette_plan, vignette_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
  type Vector2,
} from "@openpaint/properties";
import { distortedSurface, SOURCE_UNDERLAY_KEY, surfaceBytes, vector2Value } from "./distortion";
import type { EffectBinding } from "./framework/binding";

export const VIGNETTE_ID = "vignette";

/** Parameters of Vignette (FX-PHOTO-VIGNETTE-01). */
export interface VignetteParams {
  /** Center, -1 to 1 on each axis, where (0, 0) is the middle of the region. */
  readonly center: Vector2;
  /** Radius, 0.1 to 4, scaled by half the larger side of the region. */
  readonly radius: number;
  /** Strength, 0 to 1. Zero leaves the image unchanged. */
  readonly strength: number;
}

/**
 * The Vignette schema (FX-PHOTO-VIGNETTE-01), in UI order: Center, Radius, Strength. The Center pad
 * has the source underlay, clipped to the selection bounds.
 */
export function vignetteSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "vector2",
        key: "center",
        label: "property.center",
        defaultValue: { x: 0, y: 0 },
        min: { x: -1, y: -1 },
        max: { x: 1, y: 1 },
        control: {
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
          upDownIncrement: 0.01,
          staticImageUnderlay: SOURCE_UNDERLAY_KEY,
        },
      },
      {
        kind: "double",
        key: "radius",
        label: "property.radius",
        defaultValue: 0.5,
        min: 0.1,
        max: 4,
        control: {
          decimalPlaces: 2,
          useExponentialScale: true,
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
          upDownIncrement: 0.01,
        },
      },
      {
        kind: "double",
        key: "strength",
        label: "property.strength",
        defaultValue: 1,
        min: 0,
        max: 1,
        control: {
          decimalPlaces: 2,
          useExponentialScale: true,
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
          upDownIncrement: 0.01,
        },
      },
    ],
  });
}

export function vignetteDescriptor(): EffectDescriptor {
  return {
    id: VIGNETTE_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.vignette",
    icon: "icon.vignette",
    category: "effect",
    submenu: "photo",
    configurable: true,
    kind: "gpuImage",
    schema: vignetteSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Vignette's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function vignetteParams(values: PropertyValues): VignetteParams {
  const resolved = resolveValues(vignetteSchema(), values);
  return {
    center: vector2Value(resolved, "center"),
    radius: numberValue(resolved, "radius"),
    strength: numberValue(resolved, "strength"),
  };
}

/**
 * The center in pixels and the falloff of a region (`[cx, cy, k]`, from the Rust `vignette_plan`).
 * Requires the Rust/WASM kernels to be initialized (`initCpu` in `@openpaint/engine`).
 */
export function planVignette(params: VignetteParams, width: number, height: number): Float32Array {
  return vignette_plan(width, height, params.center.x, params.center.y, params.radius);
}

/** The Rust reference of Vignette: returns the darkened `input` as a new surface. */
export function vignetteCpu(input: Surface, params: VignetteParams): Surface {
  const out = vignette_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.center.x,
    params.center.y,
    params.radius,
    params.strength,
  );
  return distortedSurface(input, out);
}

/** The host binding of Vignette: its descriptor, parameter reader and CPU reference. */
export function vignetteBinding(): EffectBinding<VignetteParams> {
  return {
    descriptor: vignetteDescriptor(),
    params: vignetteParams,
    cpu: vignetteCpu,
  };
}
