import { bokeh_blur_rgba8, bokeh_half_width, bokeh_plan } from "@openpaint/cpu";
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

export const BOKEH_BLUR_ID = "bokeh-blur";

/** Radii below this pass through unchanged, since a disc that small holds only the center pixel. */
export const BOKEH_MIN_RADIUS = 1;

/** Parameters of Bokeh Blur (FX-BLUR-BOKEH-02). */
export interface BokehBlurParams {
  /** Disc radius in pixels, 0-300. Radii below 1 pass through. */
  readonly radius: number;
  /** Gamma Boost; the gamma exponent is e = 1 + gammaBoost. */
  readonly gammaBoost: number;
  /** Quality 1-10: the number of complex terms that approximate the disc. */
  readonly quality: number;
}

/** The Bokeh Blur schema (FX-BLUR-BOKEH-02), in the spec's order. */
export function bokehBlurSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "radius",
        label: "property.radius",
        defaultValue: 25,
        min: 0,
        max: 300,
        control: { decimalPlaces: 1, useExponentialScale: true },
      },
      {
        kind: "double",
        key: "gammaBoost",
        label: "property.gammaBoost",
        defaultValue: 0,
        min: -0.99,
        max: 2,
        control: { decimalPlaces: 2, useExponentialScale: true },
      },
      {
        kind: "int32",
        key: "quality",
        label: "property.quality",
        defaultValue: 3,
        min: 1,
        max: 10,
      },
    ],
  });
}

export function bokehBlurDescriptor(): EffectDescriptor {
  return {
    id: BOKEH_BLUR_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.bokehBlur",
    icon: "icon.bokehBlur",
    category: "effect",
    submenu: "blurs",
    configurable: true,
    kind: "gpuImage",
    schema: bokehBlurSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Bokeh Blur's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function bokehBlurParams(values: PropertyValues): BokehBlurParams {
  const resolved = resolveValues(bokehBlurSchema(), values);
  return {
    radius: numberValue(resolved, "radius"),
    gammaBoost: numberValue(resolved, "gammaBoost"),
    quality: numberValue(resolved, "quality"),
  };
}

/**
 * What both backends compute from the parameters (FX-BLUR-BOKEH-03): the tap half-width, the vertical and
 * horizontal weights of each complex term, and the gamma exponent. The weights come from the Rust reference,
 * so the WGSL path uses the same numbers. Undefined means the radius is below 1 and the image passes through.
 * Requires the Rust/WASM kernels to be initialized.
 */
export interface BokehBlurPlan {
  /** Taps run over `-halfWidth..=halfWidth`. */
  readonly halfWidth: number;
  /** The number of complex terms, which is the Quality. */
  readonly terms: number;
  /** Vertical weights as `re, im` pairs: `terms` runs of `2 · halfWidth + 1` taps. */
  readonly vertical: Float32Array;
  /** Horizontal weights in the same layout, with each term's coefficient and the normalization. */
  readonly horizontal: Float32Array;
  /** Gamma exponent e = 1 + gammaBoost, as f32. */
  readonly exponent: number;
}

export function planBokehBlur(params: BokehBlurParams): BokehBlurPlan | undefined {
  const radius = Math.fround(params.radius);
  if (radius < BOKEH_MIN_RADIUS) return undefined;
  const values = bokeh_plan(radius, params.quality);
  const half = values.length / 2;
  return {
    halfWidth: bokeh_half_width(radius),
    terms: params.quality,
    vertical: values.slice(0, half),
    horizontal: values.slice(half),
    exponent: Math.fround(1 + Math.fround(params.gammaBoost)),
  };
}

/** The Rust reference of Bokeh Blur (FX-BLUR-BOKEH): returns the blurred `input` as a new surface. */
export function bokehBlurCpu(input: Surface, params: BokehBlurParams): Surface {
  const bytes = new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength);
  const out = bokeh_blur_rgba8(
    bytes,
    input.width,
    input.height,
    params.radius,
    params.gammaBoost,
    params.quality,
  );
  return new Surface(input.width, input.height, new Uint8ClampedArray(out));
}

/** The host binding of Bokeh Blur: its descriptor, parameter reader and CPU reference. */
export function bokehBlurBinding(): EffectBinding<BokehBlurParams> {
  return {
    descriptor: bokehBlurDescriptor(),
    params: bokehBlurParams,
    cpu: bokehBlurCpu,
  };
}
