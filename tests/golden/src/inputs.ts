import type { RgbaImage } from "@openpaint/codecs";
import {
  ADJUSTMENT_INPUT_SIZE,
  BLEND_SIZE,
  BLUR_INPUT_SIZE,
  QUANTIZE_INPUT_SIZE,
  RESAMPLE_INPUT_SIZE,
  TILED_INPUT_SIZE,
} from "./cases";

/** Pixels written first, so every run exercises the alpha and channel extremes. */
const EDGE_PIXELS: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0],
  [255, 255, 255, 255],
  [0, 0, 0, 255],
  [255, 255, 255, 1],
  [128, 127, 1, 255],
  [255, 0, 128, 128],
  [1, 254, 127, 1],
  [200, 30, 255, 64],
  [255, 255, 255, 0],
  [64, 192, 96, 254],
];

/**
 * Deterministic blend inputs. The destination and source are stored as PNGs, so this only runs
 * when the goldens are regenerated. Fully transparent pixels get zero color: a transparent
 * destination pixel carries no color, and the GPU path cannot preserve a stray value.
 */
export function makeBlendInputs(): { dst: RgbaImage; src: RgbaImage } {
  return { dst: makeImage(1), src: makeImage(2) };
}

/** The Gaussian Blur input, with the same edge pixels and transparency rule as the blend inputs. */
export function makeBlurInput(): RgbaImage {
  return makeImage(3, BLUR_INPUT_SIZE.width, BLUR_INPUT_SIZE.height);
}

/**
 * The tiled-dispatch input. It is larger than one 128 px tile on both axes, so a GPU run covers
 * several tiles, including partial ones. It is generated, not stored, so the browser builds it too.
 */
export function makeTiledInput(): RgbaImage {
  return makeImage(6, TILED_INPUT_SIZE.width, TILED_INPUT_SIZE.height);
}

/** The adjustment input, with the same edge pixels and transparency rule. */
export function makeAdjustmentInput(): RgbaImage {
  return makeImage(5, ADJUSTMENT_INPUT_SIZE.width, ADJUSTMENT_INPUT_SIZE.height);
}

/** The resampling input, with the same edge pixels and transparency rule. */
export function makeResampleInput(): RgbaImage {
  return makeImage(4, RESAMPLE_INPUT_SIZE.width, RESAMPLE_INPUT_SIZE.height);
}

/**
 * The palette quantization input: a smooth two-axis gradient with a little noise and a transparent
 * corner. Alpha is 0 (transparent, zero color) or 255, which is what the PNG pipeline gives the
 * quantizer.
 */
export function makeQuantizeInput(): RgbaImage {
  const { width, height } = QUANTIZE_INPUT_SIZE;
  const data = new Uint8Array(width * height * 4);
  let state = 5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      if (x + y < 5) continue;
      const noise = (state >>> 28) - 8;
      data.set(
        [
          clampByte(Math.round((x * 255) / (width - 1)) + noise),
          clampByte(Math.round((y * 255) / (height - 1)) + noise),
          clampByte(Math.round(((x + y) * 255) / (width + height - 2)) - noise),
          255,
        ],
        (y * width + x) * 4,
      );
    }
  }
  return { width, height, data };
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, value));
}

function makeImage(seed: number, width = BLEND_SIZE, height = BLEND_SIZE): RgbaImage {
  const count = width * height;
  const data = new Uint8Array(count * 4);
  let state = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  for (const [i, pixel] of EDGE_PIXELS.entries()) data.set(pixel, i * 4);
  for (let i = 0; i < count; i++) {
    if (data[i * 4 + 3] === 0) data.fill(0, i * 4, i * 4 + 3);
  }
  return { width, height, data };
}
