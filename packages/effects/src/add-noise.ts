import { add_noise_rgba8, add_noise_table } from "@openpaint/cpu";
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
import { addNoiseSeed, seedProperty } from "./rng";

export const ADD_NOISE_ID = "add-noise";

/** Parameters of Add Noise (FX-NOISE-ADD-02). */
export interface AddNoiseParams {
  /** Noise strength, 0-100. The amplitude is `intensity² / 4` (FX-NOISE-ADD-03). */
  readonly intensity: number;
  /** Chroma of the noise, 0-400. 100 is unchanged, 0 is gray. */
  readonly colorSaturation: number;
  /** Share of the pixels that receive noise, 0-100 (percent). */
  readonly coverage: number;
  /** The user's Seed, 0-255 (FX-A-00-05). */
  readonly userSeed: number;
  /** The effect instance's seed (FX-A-00-05). */
  readonly instanceSeed: number;
}

/** The Add Noise schema (FX-NOISE-ADD-02), in the spec's order. */
export function addNoiseSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "intensity",
        label: "property.intensity",
        defaultValue: 64,
        min: 0,
        max: 100,
      },
      {
        kind: "int32",
        key: "colorSaturation",
        label: "property.colorSaturation",
        defaultValue: 100,
        min: 0,
        max: 400,
      },
      {
        kind: "double",
        key: "coverage",
        label: "property.coverage",
        defaultValue: 100,
        min: 0,
        max: 100,
      },
      seedProperty(),
    ],
  });
}

export function addNoiseDescriptor(): EffectDescriptor {
  return {
    id: ADD_NOISE_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.addNoise",
    icon: "icon.addNoise",
    category: "effect",
    submenu: "noise",
    configurable: true,
    kind: "gpuImage",
    schema: addNoiseSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Add Noise's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function addNoiseParams(values: PropertyValues, instanceSeed = 0): AddNoiseParams {
  const resolved = resolveValues(addNoiseSchema(), values);
  return {
    intensity: numberValue(resolved, "intensity"),
    colorSaturation: numberValue(resolved, "colorSaturation"),
    coverage: numberValue(resolved, "coverage"),
    userSeed: numberValue(resolved, "seed"),
    instanceSeed,
  };
}

/** The Add Noise deviate table (FX-NOISE-ADD-03), shared by the Rust reference and the WGSL twin. */
export function addNoiseTable(): Int32Array {
  return add_noise_table();
}

/**
 * The Rust reference of Add Noise (FX-NOISE-ADD-03): returns the noisy `input` as a new surface. The seed
 * is `userSeed XOR instanceSeed` (FX-A-00-05).
 */
export function addNoiseCpu(input: Surface, params: AddNoiseParams): Surface {
  const out = add_noise_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.intensity,
    params.colorSaturation,
    params.coverage,
    addNoiseSeed(params.userSeed, params.instanceSeed),
  );
  return distortedSurface(input, out);
}

/** The host binding of Add Noise: its descriptor, parameter reader and CPU reference. */
export function addNoiseBinding(): EffectBinding<AddNoiseParams> {
  return {
    descriptor: addNoiseDescriptor(),
    params: (values, _document, instanceSeed) => addNoiseParams(values, instanceSeed),
    cpu: addNoiseCpu,
  };
}
