import {
  turbulence_gradients,
  turbulence_lattice,
  turbulence_plan,
  turbulence_rgba8,
} from "@openpaint/cpu";
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
import type { EffectBinding, EffectRegionOrigin } from "./framework/binding";
import { mixModeProperty } from "./mix-modes";
import { renderSeed, seedProperty } from "./rng";

export const TURBULENCE_ID = "turbulence";

/** The Noise drop-down choices (FX-RENDER-TURB-01), in the spec's order. */
export const TURBULENCE_NOISE = ["fractalSum", "turbulence"] as const;

export type TurbulenceNoise = (typeof TURBULENCE_NOISE)[number];

/** Parameters of Turbulence (FX-RENDER-TURB-01). */
export interface TurbulenceParams {
  /** Octaves, 1-15. */
  readonly octaves: number;
  /** Period in pixels, 0.1-1024. The base frequency is 1 / Period on both axes. */
  readonly period: number;
  /** Tile size in pixels, 1-4096. */
  readonly tile: number;
  /** Fractal sum (true) or Turbulence (false). */
  readonly fractal: boolean;
  /** The effective seed, 0-255: the user's Seed mixed with the instance seed (FX-A-00-05). */
  readonly seed: number;
  /** The blend mode code (FX-SHARED-MIXMODE). */
  readonly mode: number;
  /** The region's top-left corner in document pixels. Undefined reads as (0, 0). */
  readonly origin: EffectRegionOrigin | undefined;
}

/** The Turbulence schema (FX-RENDER-TURB-01), in the spec's order. */
export function turbulenceSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "octaves",
        label: "property.octaves",
        defaultValue: 4,
        min: 1,
        max: 15,
      },
      {
        kind: "double",
        key: "period",
        label: "property.period",
        defaultValue: 100,
        min: 0.1,
        max: 1024,
        control: { decimalPlaces: 2, useExponentialScale: true },
      },
      {
        kind: "int32",
        key: "tile",
        label: "property.size",
        defaultValue: 4096,
        min: 1,
        max: 4096,
      },
      {
        kind: "choice",
        key: "noise",
        label: "property.noCaption",
        defaultValue: "turbulence",
        options: [
          { value: "fractalSum", label: "noise.fractalSum" },
          { value: "turbulence", label: "noise.turbulence" },
        ],
        control: { description: "property.noise" },
      },
      { ...seedProperty(), defaultValue: 1 },
      mixModeProperty(),
    ],
  });
}

export function turbulenceDescriptor(): EffectDescriptor {
  return {
    id: TURBULENCE_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.turbulence",
    icon: "icon.turbulence",
    category: "effect",
    submenu: "render",
    configurable: true,
    kind: "gpuImage",
    schema: turbulenceSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Turbulence's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function turbulenceParams(
  values: PropertyValues,
  _document?: unknown,
  instanceSeed = 0,
  regionOrigin?: EffectRegionOrigin,
): TurbulenceParams {
  const resolved = resolveValues(turbulenceSchema(), values);
  return {
    octaves: numberValue(resolved, "octaves"),
    period: numberValue(resolved, "period"),
    tile: numberValue(resolved, "tile"),
    fractal: resolved.noise === "fractalSum",
    seed: renderSeed(numberValue(resolved, "seed"), instanceSeed),
    mode: numberValue(resolved, "blendMode"),
    origin: regionOrigin,
  };
}

/**
 * The flat parameter array of `turbulence_rgba8` (see `TurbulenceParams::from_plan` in Rust): origin x
 * and y, octaves, period, tile size, fractal flag, seed, then the mode.
 */
export function turbulencePlan(params: TurbulenceParams): Float32Array {
  return Float32Array.of(
    params.origin?.x ?? 0,
    params.origin?.y ?? 0,
    params.octaves,
    params.period,
    params.tile,
    params.fractal ? 1 : 0,
    params.seed,
    params.mode,
  );
}

/**
 * The base frequencies and stitch values of a tile, `[freq_x, freq_y, width, wrap_x, height, wrap_y]`,
 * which the WGSL twin reads (FX-RENDER-TURB-01).
 */
export function turbulenceStitch(period: number, tile: number): Float32Array {
  return turbulence_plan(period, tile);
}

/** The lattice and gradient tables of a seed, which the WGSL twin reads (FX-RENDER-TURB-01). */
export function turbulenceTables(seed: number): {
  readonly lattice: Uint32Array;
  readonly gradients: Float32Array;
} {
  return { lattice: turbulence_lattice(seed), gradients: turbulence_gradients(seed) };
}

/** The Rust reference of Turbulence (FX-RENDER-TURB-01): returns the composited `input` as a new surface. */
export function turbulenceCpu(input: Surface, params: TurbulenceParams): Surface {
  const out = turbulence_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    turbulencePlan(params),
  );
  return distortedSurface(input, out);
}

/** The host binding of Turbulence: its descriptor, parameter reader and CPU reference. */
export function turbulenceBinding(): EffectBinding<TurbulenceParams> {
  return {
    descriptor: turbulenceDescriptor(),
    params: turbulenceParams,
    cpu: turbulenceCpu,
  };
}
