import { sketch_blur_rgba8, sketch_offsets, sketch_plan } from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import type { EffectBinding } from "./framework/binding";

export const SKETCH_BLUR_ID = "sketch-blur";

/** Parameters of Sketch Blur (FX-BLUR-SKETCH-02). */
export interface SketchBlurParams {
  /** Radius of the sparse scan in pixels, 0-100. */
  readonly radius: number;
  /** The percentile estimated for each channel, 0-100. */
  readonly percentile: number;
  /** Number of estimator iterations, 1-20. */
  readonly smoothness: number;
}

/** The Sketch Blur schema (FX-BLUR-SKETCH-02), in the spec's order. */
export function sketchBlurSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "radius",
        label: "property.radius",
        defaultValue: 25,
        min: 0,
        max: 100,
      },
      {
        kind: "int32",
        key: "percentile",
        label: "property.percentile",
        defaultValue: 50,
        min: 0,
        max: 100,
      },
      {
        kind: "int32",
        key: "smoothness",
        label: "property.smoothness",
        defaultValue: 3,
        min: 1,
        max: 20,
      },
    ],
  });
}

export function sketchBlurDescriptor(): EffectDescriptor {
  return {
    id: SKETCH_BLUR_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.sketchBlur",
    icon: "icon.sketchBlur",
    category: "effect",
    submenu: "blurs",
    configurable: true,
    kind: "gpuImage",
    schema: sketchBlurSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Sketch Blur's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function sketchBlurParams(values: PropertyValues): SketchBlurParams {
  const resolved = resolveValues(sketchBlurSchema(), values);
  return {
    radius: numberValue(resolved, "radius"),
    percentile: numberValue(resolved, "percentile"),
    smoothness: numberValue(resolved, "smoothness"),
  };
}

/**
 * What both backends compute from the parameters (FX-BLUR-SKETCH-03): the scan offsets and the P²
 * constants, as integers in the estimator's fixed-point units. The values come from the Rust reference,
 * so the WGSL path reads the same numbers. `markers` holds the five initial positions and then the five
 * increments, and `rank` is the sample that seeds the first iteration. Requires the Rust/WASM kernels to
 * be initialized.
 */
export interface SketchBlurPlan {
  readonly offsets: Int32Array;
  readonly markers: readonly number[];
  readonly rank: number;
}

export function sketchBlurPlan(params: SketchBlurParams): SketchBlurPlan {
  const constants = sketch_plan(params.percentile);
  return {
    offsets: sketch_offsets(Math.fround(params.radius), params.smoothness),
    markers: Array.from(constants.slice(0, 10)),
    rank: constants[10] ?? 0,
  };
}

/** The Rust reference of Sketch Blur (FX-BLUR-SKETCH-03): returns the blurred `input` as a new surface. */
export function sketchBlurCpu(input: Surface, params: SketchBlurParams): Surface {
  const bytes = new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength);
  const out = sketch_blur_rgba8(
    bytes,
    input.width,
    input.height,
    params.radius,
    params.percentile,
    params.smoothness,
  );
  return new Surface(input.width, input.height, new Uint8ClampedArray(out));
}

/** The host binding of Sketch Blur: its descriptor, parameter reader and CPU reference. */
export function sketchBlurBinding(): EffectBinding<SketchBlurParams> {
  return {
    descriptor: sketchBlurDescriptor(),
    params: sketchBlurParams,
    cpu: sketchBlurCpu,
  };
}
