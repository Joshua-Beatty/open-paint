import { crystal_plan, crystalize_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { distortedSurface, distortionQualityProperty, surfaceBytes } from "./distortion";
import type { EffectBinding } from "./framework/binding";
import { crystalizeSeed, seedProperty } from "./rng";

export const CRYSTALIZE_ID = "crystalize";

/** Crystalize caps its Quality at 5 (FX-DIST-CRYSTAL-02). */
export const CRYSTALIZE_MAX_QUALITY = 5;

/** Parameters of Crystalize (FX-DIST-CRYSTAL-02). */
export interface CrystalizeParams {
  /** Cell Size in pixels, 2 to 250. */
  readonly cellSize: number;
  /** Supersampling Quality 1-5 (q² samples). */
  readonly quality: number;
  /** The user's Seed, 0-255 (FX-A-00-05). */
  readonly userSeed: number;
  /** The effect instance's seed (FX-A-00-05). */
  readonly instanceSeed: number;
}

/**
 * The Crystalize schema (FX-DIST-CRYSTAL-02). The Quality default is the Default Quality Level value
 * (FX-A-00-03 case 1), capped at 5.
 */
export function crystalizeSchema(defaultQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "cellSize",
        label: "property.cellSize",
        defaultValue: 8,
        min: 2,
        max: 250,
      },
      distortionQualityProperty(defaultQuality, CRYSTALIZE_MAX_QUALITY),
      seedProperty(),
    ],
  });
}

export function crystalizeDescriptor(defaultQuality: number): EffectDescriptor {
  return {
    id: CRYSTALIZE_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.crystalize",
    icon: "icon.crystalize",
    category: "effect",
    submenu: "distort",
    configurable: true,
    kind: "gpuImage",
    schema: crystalizeSchema(defaultQuality),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Crystalize's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function crystalizeParams(
  values: PropertyValues,
  defaultQuality: number,
  instanceSeed = 0,
): CrystalizeParams {
  const resolved = resolveValues(crystalizeSchema(defaultQuality), values);
  return {
    cellSize: numberValue(resolved, "cellSize"),
    quality: numberValue(resolved, "quality"),
    userSeed: numberValue(resolved, "seed"),
    instanceSeed,
  };
}

/**
 * The plan of Crystalize for the sample map: `[cell, s0, s1, s2, s3]` from the effective seed
 * (FX-A-00-05). Requires the WASM kernels to be initialized.
 */
export function crystalizePlan(params: CrystalizeParams): Float32Array {
  return crystal_plan(params.cellSize, crystalizeSeed(params.userSeed, params.instanceSeed));
}

/**
 * The Rust reference of Crystalize (FX-DIST-CRYSTAL-03): returns the distorted `input` as a new
 * surface. The edge mode is Clamp, which the kernel applies.
 */
export function crystalizeCpu(input: Surface, params: CrystalizeParams): Surface {
  const out = crystalize_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.quality,
    crystalizePlan(params),
  );
  return distortedSurface(input, out);
}

/**
 * The host binding of Crystalize: its descriptor, parameter reader and CPU reference. The instance
 * seed is the session's (FX-A-00-05).
 */
export function crystalizeBinding(defaultQuality: number): EffectBinding<CrystalizeParams> {
  return {
    descriptor: crystalizeDescriptor(defaultQuality),
    params: (values, _document, instanceSeed) =>
      crystalizeParams(values, defaultQuality, instanceSeed),
    cpu: crystalizeCpu,
  };
}
