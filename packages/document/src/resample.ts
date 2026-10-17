import { resample_rgba8 } from "@openpaint/cpu";
import { Surface } from "./surface";

/**
 * The resampling choices of DOC-IMG-02. The index of each name is its WASM filter id in
 * `crates/opaint-cpu/src/resample.rs`, so keep the two lists in the same order.
 */
export const RESAMPLE_FILTERS = [
  "nearest",
  "bilinear",
  "bilinearLowQuality",
  "bicubic",
  "bicubicSmooth",
  "adaptive",
  "lanczos3",
  "superSampling",
  "fant",
] as const;

export type ResampleFilter = (typeof RESAMPLE_FILTERS)[number];

export interface ResampleOptions {
  readonly filter: ResampleFilter;
  /** Resample in linear light (DOC-IMG-02 "Use gamma correction"). */
  readonly linearLight: boolean;
}

/** Resamples a surface, possibly off the main thread (DOC-IMG-02). `source` is left unchanged. */
export type ResampleRunner = (
  source: Surface,
  width: number,
  height: number,
  options: ResampleOptions,
) => Promise<Surface>;

/**
 * Returns `source` resampled to `width` x `height` (straight alpha). `source` is left unchanged.
 * Sizes must be positive integers.
 */
export function resampleSurface(
  source: Surface,
  width: number,
  height: number,
  options: ResampleOptions,
): Surface {
  for (const size of [width, height]) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`Invalid resample size ${width}x${height}.`);
    }
  }
  const pixels = resample_rgba8(
    new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength),
    source.width,
    source.height,
    width,
    height,
    RESAMPLE_FILTERS.indexOf(options.filter),
    options.linearLight,
  );
  return new Surface(width, height, new Uint8ClampedArray(pixels));
}
