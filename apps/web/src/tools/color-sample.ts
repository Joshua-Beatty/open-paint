import {
  type ColorRgba8,
  intersectRects,
  type Rect,
  rect,
  type Surface,
} from "@openpaint/document";

/** The sampling sizes of TL-OPT-PICKER, by their stored choice. */
const SAMPLE_SIZES: ReadonlyMap<unknown, number> = new Map([
  ["PointSample", 1],
  ["Average3x3", 3],
  ["Average5x5", 5],
  ["Average11x11", 11],
  ["Average31x31", 31],
  ["Average51x51", 51],
]);

/** The side of the square a sampling choice averages, 1 for a single pixel (TL-PICK-01). */
export function sampleSizeOf(choice: unknown): number {
  return SAMPLE_SIZES.get(choice) ?? 1;
}

/**
 * The pixels a sample at (x, y) averages: the `size` square centered on the pixel under the point,
 * clipped to `bounds` (TL-PICK-01). Empty when the square misses the image.
 */
export function sampleArea(x: number, y: number, size: number, bounds: Rect): Rect {
  const reach = Math.floor(size / 2);
  return intersectRects(rect(Math.floor(x) - reach, Math.floor(y) - reach, size, size), bounds);
}

function channel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/**
 * The average color of a region (TL-PICK-01). The premultiplied colors are averaged over the
 * region's pixels, then un-premultiplied by the average alpha, so clear pixels do not pull the
 * color toward black. A region with no visible pixel is clear black.
 */
export function averageColor(pixels: Surface): ColorRgba8 {
  const { data } = pixels;
  const count = data.length / 4;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [pr = 0, pg = 0, pb = 0, pa = 0] = data.subarray(i, i + 4);
    const alpha = pa / 255;
    r += (pr / 255) * alpha;
    g += (pg / 255) * alpha;
    b += (pb / 255) * alpha;
    a += alpha;
  }
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: channel((r / a) * 255),
    g: channel((g / a) * 255),
    b: channel((b / a) * 255),
    a: channel((a / count) * 255),
  };
}
