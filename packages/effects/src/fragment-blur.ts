import { fragment_blur_rgba8, fragment_offsets } from "@openpaint/cpu";
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

export const FRAGMENT_BLUR_ID = "fragment-blur";

/** Parameters of Fragment Blur (FX-BLUR-FRAG-02). */
export interface FragmentBlurParams {
  /** Number of copies superimposed on the image. */
  readonly count: number;
  /** Distance of each copy from the pixel, in pixels. */
  readonly distance: number;
  /** Direction of the first copy, in degrees. */
  readonly rotation: number;
}

/** The Fragment Blur schema, in the UI order of FX-BLUR-FRAG-02. */
export function fragmentBlurSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "count",
        label: "property.fragmentCount",
        defaultValue: 4,
        min: 2,
        max: 200,
      },
      {
        kind: "int32",
        key: "distance",
        label: "property.distance",
        defaultValue: 8,
        min: 0,
        max: 400,
      },
      {
        kind: "double",
        key: "rotation",
        label: "property.rotation",
        defaultValue: 0,
        min: 0,
        max: 360,
        control: { controlType: "anglePicker", rangeWraps: true, sliderLargeChange: 36 },
      },
    ],
  });
}

export function fragmentBlurDescriptor(): EffectDescriptor {
  return {
    id: FRAGMENT_BLUR_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.fragmentBlur",
    icon: "icon.fragmentBlur",
    category: "effect",
    submenu: "blurs",
    configurable: true,
    kind: "gpuImage",
    schema: fragmentBlurSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Fragment Blur's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function fragmentBlurParams(values: PropertyValues): FragmentBlurParams {
  const resolved = resolveValues(fragmentBlurSchema(), values);
  return {
    count: numberValue(resolved, "count"),
    distance: numberValue(resolved, "distance"),
    rotation: numberValue(resolved, "rotation"),
  };
}

/**
 * The fragment offsets both backends sample, as `dx, dy` pairs in pixels (FX-BLUR-FRAG-03). Requires
 * the WASM kernels to be initialized.
 */
export function fragmentBlurOffsets(params: FragmentBlurParams): Float32Array {
  return fragment_offsets(params.count, params.distance, params.rotation);
}

/** The Rust reference of Fragment Blur: returns the blurred `input` as a new surface. */
export function fragmentBlurCpu(input: Surface, params: FragmentBlurParams): Surface {
  const out = fragment_blur_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.count,
    params.distance,
    params.rotation,
  );
  return distortedSurface(input, out);
}

/** The host binding of Fragment Blur: its descriptor, parameter reader and CPU reference. */
export function fragmentBlurBinding(): EffectBinding<FragmentBlurParams> {
  return {
    descriptor: fragmentBlurDescriptor(),
    params: fragmentBlurParams,
    cpu: fragmentBlurCpu,
  };
}
