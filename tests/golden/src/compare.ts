import type { RgbaImage } from "@openpaint/codecs";

/** Rust/WASM kernels are the reference, so they must match the stored output exactly. */
export const CPU_TOLERANCE = 0;

/** WGSL results must match the reference within ±1 per 8-bit channel (WEB-GPU-03). */
export const GPU_TOLERANCE = 1;

export interface ImageDiff {
  /** Largest absolute difference of any channel of any pixel. */
  readonly maxDifference: number;
  /** Channel values that differ at all. */
  readonly differingChannels: number;
}

export function diffImages(actual: RgbaImage, expected: RgbaImage): ImageDiff {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new RangeError(
      `Image is ${actual.width}x${actual.height}; the reference is ${expected.width}x${expected.height}.`,
    );
  }
  let maxDifference = 0;
  let differingChannels = 0;
  for (let i = 0; i < actual.data.length; i++) {
    const difference = Math.abs((actual.data[i] ?? 0) - (expected.data[i] ?? 0));
    if (difference > 0) differingChannels++;
    maxDifference = Math.max(maxDifference, difference);
  }
  return { maxDifference, differingChannels };
}
