import { reduce_noise_rgba8 } from "@openpaint/cpu";
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

export const REDUCE_NOISE_ID = "reduce-noise";

/** Parameters of Reduce Noise (FX-NOISE-REDUCE-02). */
export interface ReduceNoiseParams {
  /** Radius of the circular neighborhood in pixels, 0-50. Zero passes the image through. */
  readonly radius: number;
  /** Strength of the reduction, 0-1 (FX-NOISE-REDUCE-03). */
  readonly strength: number;
}

/** The Reduce Noise schema (FX-NOISE-REDUCE-02), in the spec's order. */
export function reduceNoiseSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "radius",
        label: "property.radius",
        defaultValue: 10,
        min: 0,
        max: 50,
      },
      {
        kind: "double",
        key: "strength",
        label: "property.strength",
        defaultValue: 0.4,
        min: 0,
        max: 1,
        control: { upDownIncrement: 0.01, sliderSmallChange: 0.01, sliderLargeChange: 0.1 },
      },
    ],
  });
}

export function reduceNoiseDescriptor(): EffectDescriptor {
  return {
    id: REDUCE_NOISE_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.reduceNoise",
    icon: "icon.reduceNoise",
    category: "effect",
    submenu: "noise",
    configurable: true,
    kind: "gpuImage",
    schema: reduceNoiseSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Reduce Noise's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function reduceNoiseParams(values: PropertyValues): ReduceNoiseParams {
  const resolved = resolveValues(reduceNoiseSchema(), values);
  return {
    radius: numberValue(resolved, "radius"),
    strength: numberValue(resolved, "strength"),
  };
}

/** The Rust reference of Reduce Noise (FX-NOISE-REDUCE-03): returns the filtered `input`. */
export function reduceNoiseCpu(input: Surface, params: ReduceNoiseParams): Surface {
  const out = reduce_noise_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.radius,
    params.strength,
  );
  return distortedSurface(input, out);
}

/** The host binding of Reduce Noise: its descriptor, parameter reader and CPU reference. */
export function reduceNoiseBinding(): EffectBinding<ReduceNoiseParams> {
  return {
    descriptor: reduceNoiseDescriptor(),
    params: reduceNoiseParams,
    cpu: reduceNoiseCpu,
  };
}
