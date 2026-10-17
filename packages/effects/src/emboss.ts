import { emboss_kernel, emboss_rgba8 } from "@openpaint/cpu";
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

export const EMBOSS_ID = "emboss";

/** Parameters of Emboss (FX-STYL-EMBOSS-01). */
export interface EmbossParams {
  /** Angle, 0-360 degrees. 0 puts the highlights on the right and the shadows on the left. */
  readonly angle: number;
}

/** The Emboss schema (FX-STYL-EMBOSS-01): one angle chooser. */
export function embossSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "angle",
        label: "property.angle",
        defaultValue: 0,
        min: 0,
        max: 360,
        control: { controlType: "anglePicker" },
      },
    ],
  });
}

export function embossDescriptor(): EffectDescriptor {
  return {
    id: EMBOSS_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.emboss",
    icon: "icon.emboss",
    category: "effect",
    submenu: "stylize",
    configurable: true,
    kind: "gpuImage",
    schema: embossSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Emboss's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function embossParams(values: PropertyValues): EmbossParams {
  const resolved = resolveValues(embossSchema(), values);
  return { angle: numberValue(resolved, "angle") };
}

/** The kernel both backends convolve with, from the Rust `emboss_kernel`. */
export interface EmbossPlan {
  readonly weights: Float32Array;
}

/** Requires the Rust/WASM kernels to be initialized (`initCpu` in `@openpaint/engine`). */
export function planEmboss(params: EmbossParams): EmbossPlan {
  return { weights: emboss_kernel(params.angle) };
}

/** The Rust reference of Emboss: returns the gray relief as a new surface. */
export function embossCpu(input: Surface, params: EmbossParams): Surface {
  const out = emboss_rgba8(surfaceBytes(input), input.width, input.height, params.angle);
  return distortedSurface(input, out);
}

/** The host binding of Emboss: its descriptor, parameter reader and CPU reference. */
export function embossBinding(): EffectBinding<EmbossParams> {
  return {
    descriptor: embossDescriptor(),
    params: embossParams,
    cpu: embossCpu,
  };
}
