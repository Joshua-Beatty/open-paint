import {
  intersectRects,
  isEmptyRect,
  type Rect,
  Surface,
  type TiledPixelStore,
} from "@openpaint/document";

export interface ApplyToRegionOptions {
  readonly store: TiledPixelStore;
  /** The render bounds; clipped to the layer. */
  readonly region: Rect;
  /**
   * Per-pixel selection coverage, 0-255, row-major over `region`. Undefined means the whole region
   * is affected (no selection).
   */
  readonly coverage?: ArrayLike<number>;
  /** Computes the effect on the region's pixels, returning a surface of the same size. */
  readonly run: (input: Surface) => Surface | Promise<Surface>;
}

/**
 * Applies an effect to one layer region (FX-FW-SEL-01): reads the region, runs the effect, mixes
 * the result with the original by coverage, and writes it back. Returns the rectangle written,
 * which is empty when the region lies outside the layer.
 */
export async function applyToRegion(options: ApplyToRegionOptions): Promise<Rect> {
  const { store, coverage, run } = options;
  const region = intersectRects(options.region, store.bounds);
  if (isEmptyRect(region)) return region;
  const original = store.readRegion(region);
  const effected = await run(original);
  if (effected.width !== region.width || effected.height !== region.height) {
    throw new RangeError(
      `Effect returned ${effected.width}x${effected.height}; the region is ${region.width}x${region.height}.`,
    );
  }
  const output = coverage ? clipToCoverage(original, effected, coverage) : effected;
  store.writeRegion(output, region.x, region.y);
  return region;
}

/**
 * `out = lerp(original, effected, coverage / 255)` per channel, rounded half up. Coverage 255 keeps
 * the effect and 0 keeps the original exactly.
 */
export function clipToCoverage(
  original: Surface,
  effected: Surface,
  coverage: ArrayLike<number>,
): Surface {
  return clipToCoverageArea(original, effected, coverage, original.bounds);
}

/**
 * `clipToCoverage` over `area` only (in the surfaces' pixels), as a surface of `area`'s size. A
 * render clips each tile just before writing it, so the work is sliced with the writes (L7, L10).
 * Fully covered and uncovered pixels are copied four bytes at a time; only edge pixels mix.
 */
export function clipToCoverageArea(
  original: Surface,
  effected: Surface,
  coverage: ArrayLike<number>,
  area: Rect,
): Surface {
  const width = original.width;
  if (coverage.length !== width * original.height) {
    throw new RangeError(
      `Coverage has ${coverage.length} pixels; expected ${width * original.height}.`,
    );
  }
  const out = new Surface(area.width, area.height);
  // Word access needs 4-byte aligned views; a surface over a shifted view is copied first.
  const o8 = ((original.data.byteOffset & 3) === 0 ? original : original.clone()).data;
  const e8 = ((effected.data.byteOffset & 3) === 0 ? effected : effected.clone()).data;
  const out8 = out.data;
  const o32 = new Uint32Array(o8.buffer, o8.byteOffset, o8.byteLength >> 2);
  const e32 = new Uint32Array(e8.buffer, e8.byteOffset, e8.byteLength >> 2);
  const out32 = new Uint32Array(out8.buffer, out8.byteOffset, out8.byteLength >> 2);
  for (let y = 0; y < area.height; y++) {
    const row = (area.y + y) * width + area.x;
    const target = y * area.width;
    for (let x = 0; x < area.width; x++) {
      const i = row + x;
      const c = coverage[i] ?? 0;
      const t = target + x;
      if (c === 0) out32[t] = o32[i] ?? 0;
      else if (c === 255) out32[t] = e32[i] ?? 0;
      else {
        for (let k = 0; k < 4; k++) {
          const o = o8[i * 4 + k] ?? 0;
          const e = e8[i * 4 + k] ?? 0;
          out8[t * 4 + k] = Math.floor((o * (255 - c) + e * c + 127) / 255);
        }
      }
    }
  }
  return out;
}
