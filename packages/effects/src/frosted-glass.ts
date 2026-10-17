import { frost_rgba8 } from "@openpaint/cpu";
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
import { frostMapRandoms, frostSeed, seedProperty } from "./rng";

export const FROSTED_GLASS_ID = "frostedGlass";

/**
 * The sample counts of Smoothness 1-8 (FX-DIST-FROST-03): Fibonacci numbers, one sample map each. No
 * RGSS offsets are used.
 */
export const FROST_SAMPLE_COUNTS = [1, 2, 3, 5, 8, 13, 21, 34] as const;

/** Parameters of Frosted Glass (FX-DIST-FROST-02). */
export interface FrostedGlassParams {
  /** Largest scatter radius in pixels, 0 to 500. */
  readonly maximumRadius: number;
  /** Smallest scatter radius in pixels, 0 to 500, never above the maximum. */
  readonly minimumRadius: number;
  /** Radius-distribution exponent, 0.01 to 3. Below 1 favors the maximum, above 1 the minimum. */
  readonly diffusion: number;
  /** Sample count through the Fibonacci table, 1 to 8. */
  readonly smoothness: number;
  /** The user's Seed, 0-255 (FX-A-00-05). */
  readonly userSeed: number;
  /** The effect instance's seed (FX-A-00-05). */
  readonly instanceSeed: number;
}

/**
 * The Frosted Glass schema (FX-DIST-FROST-02). The two radii are soft-linked, so moving one past the
 * other pushes the other (min ≤ max).
 */
export function frostedGlassSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "maximumRadius",
        label: "property.maximumRadius",
        defaultValue: 3,
        min: 0,
        max: 500,
        control: { useExponentialScale: true },
      },
      {
        kind: "double",
        key: "minimumRadius",
        label: "property.minimumRadius",
        defaultValue: 0,
        min: 0,
        max: 500,
        control: { useExponentialScale: true },
      },
      {
        kind: "double",
        key: "diffusion",
        label: "property.diffusion",
        defaultValue: 1,
        min: 0.01,
        max: 3,
        control: { sliderSmallChange: 0.05, sliderLargeChange: 0.2, upDownIncrement: 0.01 },
      },
      {
        kind: "int32",
        key: "smoothness",
        label: "property.smoothness",
        defaultValue: 2,
        min: 1,
        max: 8,
      },
      seedProperty(),
    ],
    rules: [{ kind: "softMinMax", lower: "minimumRadius", upper: "maximumRadius" }],
  });
}

export function frostedGlassDescriptor(): EffectDescriptor {
  return {
    id: FROSTED_GLASS_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.frostedGlass",
    icon: "icon.frostedGlass",
    category: "effect",
    submenu: "distort",
    configurable: true,
    kind: "gpuImage",
    schema: frostedGlassSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Frosted Glass's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function frostedGlassParams(values: PropertyValues, instanceSeed = 0): FrostedGlassParams {
  const resolved = resolveValues(frostedGlassSchema(), values);
  return {
    maximumRadius: numberValue(resolved, "maximumRadius"),
    minimumRadius: numberValue(resolved, "minimumRadius"),
    diffusion: numberValue(resolved, "diffusion"),
    smoothness: numberValue(resolved, "smoothness"),
    userSeed: numberValue(resolved, "seed"),
    instanceSeed,
  };
}

/** The plan of Frosted Glass for the kernel: `[min, max, diffusion]`. */
export function frostedGlassPlan(params: FrostedGlassParams): Float32Array {
  return Float32Array.of(params.minimumRadius, params.maximumRadius, params.diffusion);
}

/**
 * The effective seed of each sample map (FX-A-00-05, FX-DIST-FROST-03): `userSeed XOR (instanceSeed
 * XOR random[i])`, with one random value per map from the instance. Requires the WASM kernels to be
 * initialized.
 */
export function frostedGlassSeeds(params: FrostedGlassParams): Uint32Array {
  const count = FROST_SAMPLE_COUNTS[params.smoothness - 1];
  if (count === undefined) {
    throw new RangeError(`Smoothness must be 1-${FROST_SAMPLE_COUNTS.length}.`);
  }
  const randoms = frostMapRandoms(params.instanceSeed, count);
  return Uint32Array.from(randoms, (random) =>
    frostSeed(params.userSeed, params.instanceSeed, random),
  );
}

/**
 * The Rust reference of Frosted Glass (FX-DIST-FROST-03): returns the scattered `input` as a new
 * surface. The edge mode is Reflect, which the kernel applies.
 */
export function frostedGlassCpu(input: Surface, params: FrostedGlassParams): Surface {
  const out = frost_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    frostedGlassPlan(params),
    frostedGlassSeeds(params),
  );
  return distortedSurface(input, out);
}

/**
 * The host binding of Frosted Glass: its descriptor, parameter reader and CPU reference. The
 * instance seed is the session's (FX-A-00-05).
 */
export function frostedGlassBinding(): EffectBinding<FrostedGlassParams> {
  return {
    descriptor: frostedGlassDescriptor(),
    params: (values, _document, instanceSeed) => frostedGlassParams(values, instanceSeed),
    cpu: frostedGlassCpu,
  };
}
