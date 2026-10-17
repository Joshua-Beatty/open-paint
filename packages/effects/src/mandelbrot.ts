import { mandelbrot_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { distortedSurface, distortionQualityProperty, surfaceBytes } from "./distortion";
import {
  type FractalParams,
  fractalAngleProperty,
  fractalFactorProperty,
  fractalParamsOf,
  fractalPlan,
  fractalZoomProperty,
} from "./fractal";
import type { EffectBinding, EffectDocumentSize, EffectRegionOrigin } from "./framework/binding";
import { MIX_MODE_OVERWRITE, mixModeProperty } from "./mix-modes";

export const MANDELBROT_ID = "mandelbrot";

/** Parameters of Mandelbrot (FX-RENDER-MANDEL-01). */
export interface MandelbrotParams extends FractalParams {
  /** Invert Colors: the RGB of the fractal is inverted before blending. Alpha is kept. */
  readonly invert: boolean;
}

/**
 * The Mandelbrot schema (FX-RENDER-MANDEL-01), in the spec's order. The Quality default is the
 * Default Quality Level value (FX-FW-QUALITY-01).
 */
export function mandelbrotSchema(defaultQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      fractalFactorProperty(1),
      fractalZoomProperty(10, 0, 100),
      fractalAngleProperty(),
      distortionQualityProperty(defaultQuality),
      {
        kind: "boolean",
        key: "invert",
        label: "property.noCaption",
        defaultValue: false,
        control: { description: "property.invertColors" },
      },
      mixModeProperty(MIX_MODE_OVERWRITE),
    ],
  });
}

export function mandelbrotDescriptor(defaultQuality: number): EffectDescriptor {
  return {
    id: MANDELBROT_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.mandelbrot",
    icon: "icon.mandelbrot",
    category: "effect",
    submenu: "render",
    configurable: true,
    kind: "gpuImage",
    schema: mandelbrotSchema(defaultQuality),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Mandelbrot's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function mandelbrotParams(
  values: PropertyValues,
  defaultQuality: number,
  document?: EffectDocumentSize,
  regionOrigin?: EffectRegionOrigin,
): MandelbrotParams {
  const resolved = resolveValues(mandelbrotSchema(defaultQuality), values);
  return {
    ...fractalParamsOf(resolved, document, regionOrigin),
    invert: resolved.invert === true,
  };
}

/**
 * The flat parameter array of `mandelbrot_rgba8`: the Julia values (`fractalPlan`), then Invert
 * Colors as 0 or 1.
 */
export function mandelbrotPlan(params: MandelbrotParams, input: Surface): Float32Array {
  return Float32Array.of(...fractalPlan(params, input), params.invert ? 1 : 0);
}

/** The Rust reference of Mandelbrot (FX-RENDER-MANDEL-01): returns the composited `input` as a new surface. */
export function mandelbrotCpu(input: Surface, params: MandelbrotParams): Surface {
  const out = mandelbrot_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    mandelbrotPlan(params, input),
  );
  return distortedSurface(input, out);
}

/** The host binding of Mandelbrot: its descriptor, parameter reader and CPU reference. */
export function mandelbrotBinding(defaultQuality: number): EffectBinding<MandelbrotParams> {
  return {
    descriptor: mandelbrotDescriptor(defaultQuality),
    params: (values, document, _instanceSeed, regionOrigin) =>
      mandelbrotParams(values, defaultQuality, document, regionOrigin),
    cpu: mandelbrotCpu,
  };
}
