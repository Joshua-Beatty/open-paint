import { type ColorRgba8, Surface } from "@openpaint/document";
import { GradientSettings, gradientRgba8 } from "./cpu";

/** The shape functions of TL-ALG-GRAD, in the order of the Rust `Shape` ids. */
export const GRADIENT_SHAPES = [
  "LinearClamped",
  "LinearReflected",
  "LinearDiamond",
  "Radial",
  "Conical",
  "Spiral",
  "SpiralCounterClockwise",
] as const;

export type GradientShape = (typeof GRADIENT_SHAPES)[number];

/** The repeat rules of TL-OPT-GRAD, in the order of the Rust `Repeat` ids. */
export const GRADIENT_REPEATS = ["NoRepeat", "RepeatWrapped", "RepeatReflected"] as const;

export type GradientRepeat = (typeof GRADIENT_REPEATS)[number];

/** A point in canvas pixels. */
export interface GradientPoint {
  readonly x: number;
  readonly y: number;
}

/** The options of one gradient fill (TL-GRAD-01, TL-ALG-GRAD). */
export interface GradientOptions {
  readonly shape: GradientShape;
  readonly repeat: GradientRepeat;
  readonly start: GradientPoint;
  readonly end: GradientPoint;
  /** The color at the start. In transparency mode only its alpha is used, as the start of the ramp. */
  readonly startColor: ColorRgba8;
  /** The color at the end. In transparency mode only its alpha is used, as the end of the ramp. */
  readonly endColor: ColorRgba8;
  /** Transparency mode: the gradient sets alpha, and the color of the layer is kept. */
  readonly alphaOnly: boolean;
  readonly antialias: boolean;
  /** A layer blend value 0 to 13, or 14 for Overwrite. */
  readonly blend: number;
  /** The dither seed. Keep it fixed for one drawing, so a re-render matches. */
  readonly seed?: number;
  /**
   * The canvas position of `input`'s top-left pixel (default 0, 0), so a part of the canvas renders
   * exactly as the same pixels of a whole-canvas render would, dither included.
   */
  readonly origin?: GradientPoint;
}

/**
 * Paints a gradient over a copy of `input` and returns the new surface. This is the Rust reference
 * of TL-ALG-GRAD. The result is not clipped to a selection; the caller does that.
 */
export function gradientCpu(input: Surface, options: GradientOptions): Surface {
  const data = new Uint8ClampedArray(input.data);
  const settings = new GradientSettings();
  try {
    settings.shape = GRADIENT_SHAPES.indexOf(options.shape);
    settings.repeat = GRADIENT_REPEATS.indexOf(options.repeat);
    settings.start_x = options.start.x;
    settings.start_y = options.start.y;
    settings.end_x = options.end.x;
    settings.end_y = options.end.y;
    settings.alpha_only = options.alphaOnly;
    settings.antialias = options.antialias;
    settings.blend = options.blend;
    settings.seed = options.seed ?? 0;
    settings.origin_x = options.origin?.x ?? 0;
    settings.origin_y = options.origin?.y ?? 0;
    const colors = new Uint8Array([
      options.startColor.r,
      options.startColor.g,
      options.startColor.b,
      options.startColor.a,
      options.endColor.r,
      options.endColor.g,
      options.endColor.b,
      options.endColor.a,
    ]);
    gradientRgba8(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      input.width,
      input.height,
      colors,
      settings,
    );
  } finally {
    settings.free();
  }
  return new Surface(input.width, input.height, data);
}
