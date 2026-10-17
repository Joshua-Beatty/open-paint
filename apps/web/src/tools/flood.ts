import { runCodecJob } from "@openpaint/codecs";
import { bytesOf, type Surface } from "@openpaint/document";
import type { PixelPoint } from "./select-geometry";

/** The tolerance of a fresh flood tool, as the settings store it (TL-OPT-FLOOD: 50 %). */
const DEFAULT_TOLERANCE = 0.5;

/** A tolerance from the settings, as a fraction in [0, 1]. Other values give the default. */
export function toleranceOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TOLERANCE;
  return Math.min(1, Math.max(0, value));
}

/** One flood from a seed (TL-ALG-TOL): the tolerance, the alpha mode and the flood mode. */
export interface FloodOptions {
  readonly seed: PixelPoint;
  /** The tolerance, from 0 to 1. */
  readonly tolerance: number;
  /** Compares straight channels instead of premultiplied ones. */
  readonly straight: boolean;
  /** Selects every matching pixel, not only the region joined to the seed. */
  readonly global: boolean;
}

/**
 * The stencil of a flood over `pixels`: one byte per pixel, 255 inside the region. It runs in the
 * WASM worker pool, so the UI thread stays free (WEB-GPU-06).
 */
export function floodMask(pixels: Surface, options: FloodOptions): Promise<Uint8Array> {
  return runCodecJob("magicWandMask", {
    pixels: bytesOf(pixels),
    width: pixels.width,
    height: pixels.height,
    seedX: options.seed.x,
    seedY: options.seed.y,
    tolerance: options.tolerance,
    straight: options.straight,
    global: options.global,
  });
}
