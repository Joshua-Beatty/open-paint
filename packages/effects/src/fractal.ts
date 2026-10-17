import type { Surface } from "@openpaint/document";
import { type DoubleProperty, numberValue, type PropertyValues } from "@openpaint/properties";
import type { EffectDocumentSize, EffectRegionOrigin } from "./framework/binding";

/** The smallest Zoom the engines take; a smaller Zoom is clamped to it (FX-RENDER-JULIA-01). */
export const FRACTAL_MIN_ZOOM = 0.0001;

/** Parameters shared by Julia and Mandelbrot (FX-RENDER-JULIA-01, FX-RENDER-MANDEL-01). */
export interface FractalParams {
  /** Factor, 1-10: the scale of the iteration count. */
  readonly factor: number;
  /** Zoom, clamped to at least `FRACTAL_MIN_ZOOM`. */
  readonly zoom: number;
  /** Angle in degrees, -180 to 180. */
  readonly angle: number;
  /** Supersampling Quality 1-8 (q² samples, FX-SHARED-QUALITY). */
  readonly quality: number;
  /** The blend mode code (FX-SHARED-MIXMODE). */
  readonly mode: number;
  /** The region's top-left corner in document pixels. Undefined reads as (0, 0). */
  readonly origin: EffectRegionOrigin | undefined;
  /** The document size. Undefined reads as the input's own size. */
  readonly document: EffectDocumentSize | undefined;
}

/** The Factor slider, which the two fractals share and default differently. */
export function fractalFactorProperty(defaultValue: number): DoubleProperty {
  return {
    kind: "double",
    key: "factor",
    label: "property.factor",
    defaultValue,
    min: 1,
    max: 10,
    control: {
      decimalPlaces: 2,
      upDownIncrement: 0.1,
      sliderSmallChange: 0.5,
      sliderLargeChange: 2,
    },
  };
}

/** The Zoom slider. The two fractals differ in range and default. */
export function fractalZoomProperty(
  defaultValue: number,
  min: number,
  max: number,
): DoubleProperty {
  return {
    kind: "double",
    key: "zoom",
    label: "property.zoom",
    defaultValue,
    min,
    max,
    control: { decimalPlaces: 2 },
  };
}

/** The Angle chooser, in degrees (FX-RENDER-JULIA-01). */
export function fractalAngleProperty(): DoubleProperty {
  return {
    kind: "double",
    key: "angle",
    label: "property.angle",
    defaultValue: 0,
    min: -180,
    max: 180,
    control: { controlType: "anglePicker" },
  };
}

/** Reads the parameters every fractal shares from resolved property values. */
export function fractalParamsOf(
  resolved: PropertyValues,
  document: EffectDocumentSize | undefined,
  regionOrigin: EffectRegionOrigin | undefined,
): FractalParams {
  return {
    factor: numberValue(resolved, "factor"),
    zoom: Math.max(numberValue(resolved, "zoom"), FRACTAL_MIN_ZOOM),
    angle: numberValue(resolved, "angle"),
    quality: numberValue(resolved, "quality"),
    mode: numberValue(resolved, "blendMode"),
    origin: regionOrigin,
    document,
  };
}

/** The document size and origin a fractal runs with: the input's own size when none is given. */
export function fractalFrame(
  params: FractalParams,
  input: Surface,
): { readonly document: EffectDocumentSize; readonly origin: EffectRegionOrigin } {
  return {
    document: params.document ?? { width: input.width, height: input.height },
    origin: params.origin ?? { x: 0, y: 0 },
  };
}

/**
 * The flat parameter array of `julia_rgba8` (see `FractalParams::from_plan` in Rust): origin x and y,
 * document width and height, Factor, the cosine and sine of the Angle, the reciprocal of the height,
 * the aspect, the reciprocal of Zoom, Quality and the blend mode.
 *
 * The host does every division here, and both backends multiply by the results. A WGSL division is
 * only accurate to 2.5 ulp, and an orbit amplifies one ulp into a different escape count (FX-RENDER-JULIA-01).
 * `Float32Array` rounds each double to the nearest f32, as the Rust reference's f32 division does.
 */
export function fractalPlan(params: FractalParams, input: Surface): Float32Array {
  const { document, origin } = fractalFrame(params, input);
  const radians = (params.angle * Math.PI) / 180;
  return Float32Array.of(
    origin.x,
    origin.y,
    document.width,
    document.height,
    params.factor,
    Math.cos(radians),
    Math.sin(radians),
    1 / document.height,
    document.height / document.width,
    1 / Math.max(params.zoom, FRACTAL_MIN_ZOOM),
    params.quality,
    params.mode,
  );
}
