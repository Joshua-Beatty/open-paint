import { relief_kernel, relief_rgba8 } from "@openpaint/cpu";
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

export const RELIEF_ID = "relief";

/** Parameters of Relief (FX-STYL-RELIEF-01). */
export interface ReliefParams {
  /** Angle, -180 to 180 degrees. */
  readonly angle: number;
}

/** The Relief schema (FX-STYL-RELIEF-01): one angle chooser. */
export function reliefSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "angle",
        label: "property.angle",
        defaultValue: 45,
        min: -180,
        max: 180,
        control: { controlType: "anglePicker" },
      },
    ],
  });
}

export function reliefDescriptor(): EffectDescriptor {
  return {
    id: RELIEF_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.relief",
    icon: "icon.relief",
    category: "effect",
    submenu: "stylize",
    configurable: true,
    kind: "gpuImage",
    schema: reliefSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Relief's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function reliefParams(values: PropertyValues): ReliefParams {
  const resolved = resolveValues(reliefSchema(), values);
  return { angle: numberValue(resolved, "angle") };
}

/** The kernel both backends convolve with, from the Rust `relief_kernel`. */
export interface ReliefPlan {
  readonly weights: Float32Array;
}

/** Requires the Rust/WASM kernels to be initialized (`initCpu` in `@openpaint/engine`). */
export function planRelief(params: ReliefParams): ReliefPlan {
  return { weights: relief_kernel(params.angle) };
}

/** The Rust reference of Relief: returns the relief-lit image as a new surface. */
export function reliefCpu(input: Surface, params: ReliefParams): Surface {
  const out = relief_rgba8(surfaceBytes(input), input.width, input.height, params.angle);
  return distortedSurface(input, out);
}

/** The host binding of Relief: its descriptor, parameter reader and CPU reference. */
export function reliefBinding(): EffectBinding<ReliefParams> {
  return {
    descriptor: reliefDescriptor(),
    params: reliefParams,
    cpu: reliefCpu,
  };
}
