import { intersectRects, isEmptyRect, rect } from "./geometry";
import type { Surface } from "./surface";

/** Pixels placed by coverage, and the coverage in their own pixels. Undefined covers them all. */
export interface FloatingContent {
  readonly pixels: Surface;
  readonly coverage?: Uint8Array;
}

/**
 * A coverage mask's rows as runs of full and of partial coverage, left to right. Uncovered pixels
 * keep the destination, so they have no run. `rows[y]` to `rows[y + 1]` index the runs of row `y`
 * in `runs`, three numbers each: the first pixel, the pixel past the last, and 1 for full coverage
 * or 0 for partial.
 */
export interface CoverageRuns {
  readonly rows: Uint32Array;
  readonly runs: Int32Array;
}

/** The runs of a `width` x `height` coverage mask. Without a mask, every pixel is fully covered. */
export function coverageRuns(
  width: number,
  height: number,
  coverage?: ArrayLike<number>,
): CoverageRuns {
  const rows = new Uint32Array(height + 1);
  if (coverage === undefined) {
    if (width === 0) return { rows, runs: new Int32Array(0) };
    const runs = new Int32Array(height * 3);
    for (let y = 0; y <= height; y++) rows[y] = y;
    for (let y = 0; y < height; y++) runs.set([0, width, 1], y * 3);
    return { rows, runs };
  }
  let runs = new Int32Array(Math.max(16, height * 3));
  let count = 0;
  const push = (from: number, to: number, full: number) => {
    if (count + 3 > runs.length) {
      const grown = new Int32Array(runs.length * 2);
      grown.set(runs);
      runs = grown;
    }
    runs[count++] = from;
    runs[count++] = to;
    runs[count++] = full;
  };
  for (let y = 0; y < height; y++) {
    rows[y] = count / 3;
    const row = y * width;
    let start = 0;
    let kind = -1;
    for (let x = 0; x <= width; x++) {
      const c = x < width ? (coverage[row + x] ?? 0) : 0;
      const next = c === 0 ? -1 : c === 255 ? 1 : 0;
      if (next === kind) continue;
      if (kind !== -1) push(start, x, kind);
      start = x;
      kind = next;
    }
  }
  rows[height] = count / 3;
  return { rows, runs: runs.subarray(0, count) };
}

/** One RGBA8 pixel per element. */
function pixelWords(surface: Surface): Uint32Array {
  const { buffer, byteOffset, byteLength } = surface.data;
  if (byteOffset % 4 !== 0) throw new RangeError("The surface is not word-aligned.");
  return new Uint32Array(buffer, byteOffset, byteLength / 4);
}

/**
 * Places `src` on `dst` with its top-left at (`dx`, `dy`), in place: inside the coverage the
 * destination becomes the source, transparency included, and partial coverage blends as
 * `lerp(dst, src, coverage / 255)` per straight RGBA channel, rounded half up, as the selection
 * clip does (`clipToCoverage`). `coverage` is in `src`'s pixels; without it the whole source is
 * covered. Fully covered runs are copied whole and uncovered pixels are skipped, so the cost is a
 * copy of the covered part plus the blend of its partly covered edge. Pass `runs` when the same
 * coverage is placed more than once.
 */
export function placeByCoverage(
  dst: Surface,
  src: Surface,
  dx: number,
  dy: number,
  coverage?: ArrayLike<number>,
  runs: CoverageRuns = coverageRuns(src.width, src.height, coverage),
): void {
  const area = intersectRects(rect(dx, dy, src.width, src.height), dst.bounds);
  if (isEmptyRect(area)) return;
  const out = pixelWords(dst);
  const from = pixelWords(src);
  const outBytes = dst.data;
  const fromBytes = src.data;
  const left = area.x - dx;
  const right = left + area.width;
  for (let y = 0; y < area.height; y++) {
    const sy = area.y - dy + y;
    const srcRow = sy * src.width;
    const shift = (area.y + y) * dst.width + dx - srcRow;
    const last = runs.rows[sy + 1] ?? 0;
    for (let r = runs.rows[sy] ?? 0; r < last; r++) {
      const start = Math.max(runs.runs[r * 3] ?? 0, left);
      const end = Math.min(runs.runs[r * 3 + 1] ?? 0, right);
      if (start >= end) continue;
      if (runs.runs[r * 3 + 2] === 1) {
        out.set(from.subarray(srcRow + start, srcRow + end), srcRow + start + shift);
        continue;
      }
      for (let s = srcRow + start; s < srcRow + end; s++) {
        const c = coverage?.[s] ?? 255;
        const keep = 255 - c;
        const o = (s + shift) * 4;
        const i = s * 4;
        for (let k = 0; k < 4; k++) {
          outBytes[o + k] = Math.floor(
            ((outBytes[o + k] as number) * keep + (fromBytes[i + k] as number) * c + 127) / 255,
          );
        }
      }
    }
  }
}
