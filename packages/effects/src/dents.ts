import { dents_plan, dents_rgba8 } from "@openpaint/cpu";
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
import { dentsSeed, seedProperty } from "./rng";

export const DENTS_ID = "dents";

/** Parameters of Dents (FX-DIST-DENTS-02). */
export interface DentsParams {
  /** Noise feature size, 0 to 200. */
  readonly scale: number;
  /** Displacement strength, 0 to 200. */
  readonly refraction: number;
  /** Octaves and roughness, 0 to 100. */
  readonly detail: number;
  /** Direction swing, 0 to 100. */
  readonly turbulence: number;
  /** Rotation of the noise field in degrees, -180 to 180. */
  readonly angle: number;
  /** Supersampling Quality 1-8 (q² samples). */
  readonly quality: number;
  /** The user's Seed, 0-255 (FX-A-00-05). */
  readonly userSeed: number;
  /** The effect instance's seed (FX-A-00-05). */
  readonly instanceSeed: number;
}

/**
 * The Dents schema (FX-DIST-DENTS-02). The Quality default is the Default Quality Level value
 * (FX-A-00-03 case 1).
 */
export function dentsSchema(defaultQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "scale",
        label: "property.scale",
        defaultValue: 25,
        min: 0,
        max: 200,
        control: { useExponentialScale: true },
      },
      {
        kind: "double",
        key: "refraction",
        label: "property.refraction",
        defaultValue: 50,
        min: 0,
        max: 200,
        control: { useExponentialScale: true },
      },
      {
        kind: "double",
        key: "detail",
        label: "property.detail",
        defaultValue: 10,
        min: 0,
        max: 100,
      },
      {
        kind: "double",
        key: "turbulence",
        label: "property.turbulence",
        defaultValue: 10,
        min: 0,
        max: 100,
        control: { useExponentialScale: true },
      },
      {
        kind: "double",
        key: "angle",
        label: "property.angle",
        defaultValue: 0,
        min: -180,
        max: 180,
        control: { controlType: "anglePicker", rangeWraps: true, sliderLargeChange: 36 },
      },
      distortionQualityProperty(defaultQuality),
      seedProperty(),
    ],
  });
}

export function dentsDescriptor(defaultQuality: number): EffectDescriptor {
  return {
    id: DENTS_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.dents",
    icon: "icon.dents",
    category: "effect",
    submenu: "distort",
    configurable: true,
    kind: "gpuImage",
    schema: dentsSchema(defaultQuality),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Dents' parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function dentsParams(
  values: PropertyValues,
  defaultQuality: number,
  instanceSeed = 0,
): DentsParams {
  const resolved = resolveValues(dentsSchema(defaultQuality), values);
  return {
    scale: numberValue(resolved, "scale"),
    refraction: numberValue(resolved, "refraction"),
    detail: numberValue(resolved, "detail"),
    turbulence: numberValue(resolved, "turbulence"),
    angle: numberValue(resolved, "angle"),
    quality: numberValue(resolved, "quality"),
    userSeed: numberValue(resolved, "seed"),
    instanceSeed,
  };
}

/**
 * The plan of Dents for the sample map, over the region of `width` × `height`. Requires the WASM
 * kernels to be initialized.
 */
export function dentsPlan(params: DentsParams, width: number, height: number): Float32Array {
  return dents_plan(
    width,
    height,
    Float32Array.of(
      params.scale,
      params.refraction,
      params.detail,
      params.turbulence,
      params.angle,
    ),
    dentsSeed(params.userSeed, params.instanceSeed),
  );
}

/**
 * The Rust reference of Dents (FX-DIST-DENTS-03): returns the distorted `input` as a new surface.
 * The edge mode is Reflect, which the kernel applies.
 */
export function dentsCpu(input: Surface, params: DentsParams): Surface {
  const out = dents_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.quality,
    dentsPlan(params, input.width, input.height),
  );
  return distortedSurface(input, out);
}

/**
 * The host binding of Dents: its descriptor, parameter reader and CPU reference. The instance seed
 * is the session's (FX-A-00-05).
 */
export function dentsBinding(defaultQuality: number): EffectBinding<DentsParams> {
  return {
    descriptor: dentsDescriptor(defaultQuality),
    params: (values, _document, instanceSeed) => dentsParams(values, defaultQuality, instanceSeed),
    cpu: dentsCpu,
  };
}
