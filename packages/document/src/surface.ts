import { type ColorRgba8, packRgba8, TRANSPARENT } from "./color";
import { intersectRects, isEmptyRect, isIntegerRect, type Rect, rect } from "./geometry";
import { PIXEL_FORMATS } from "./pixel-format";

const BPP = PIXEL_FORMATS.rgba8.bytesPerPixel;

/** A `Uint8Array` view of a surface's bytes, the form the WASM kernels take. */
export function bytesOf(surface: Surface): Uint8Array {
  return new Uint8Array(surface.data.buffer, surface.data.byteOffset, surface.data.byteLength);
}

export function assertIntegerRect(r: Rect): void {
  if (!isIntegerRect(r)) throw new RangeError("Rectangle coordinates must be integers.");
}

/**
 * A contiguous RGBA8 straight-alpha bitmap (ARC-01-01). Rows are tightly packed, top to bottom,
 * bytes R, G, B, A per pixel, so `data` can back an `ImageData` or a `rgba8unorm` upload directly.
 * Use it for regions and tiles; whole layers live in a `TiledPixelStore` (ARC-05-04).
 */
export class Surface {
  readonly format = "rgba8";
  readonly data: Uint8ClampedArray<ArrayBuffer>;

  constructor(
    readonly width: number,
    readonly height: number,
    data?: Uint8ClampedArray<ArrayBuffer>,
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
      throw new RangeError(`Invalid surface size ${width}x${height}.`);
    }
    const length = width * height * BPP;
    if (data && data.length !== length) {
      throw new RangeError(`Surface data has ${data.length} bytes; expected ${length}.`);
    }
    this.data = data ?? new Uint8ClampedArray(length);
  }

  get bounds(): Rect {
    return rect(0, 0, this.width, this.height);
  }

  get byteLength(): number {
    return this.data.length;
  }

  /** Stride in bytes between rows. */
  get stride(): number {
    return this.width * BPP;
  }

  clone(): Surface {
    return new Surface(this.width, this.height, this.data.slice());
  }

  getPixel(x: number, y: number): ColorRgba8 {
    if (!this.#inside(x, y)) return TRANSPARENT;
    const i = (y * this.width + x) * BPP;
    const d = this.data;
    return { r: d[i] ?? 0, g: d[i + 1] ?? 0, b: d[i + 2] ?? 0, a: d[i + 3] ?? 0 };
  }

  /** Writes one pixel; coordinates outside the surface are ignored. */
  setPixel(x: number, y: number, c: ColorRgba8): void {
    if (!this.#inside(x, y)) return;
    this.data.set([c.r, c.g, c.b, c.a], (y * this.width + x) * BPP);
  }

  /** Fills `area` (clipped to the surface, default everything) with `c`. Returns the filled rect. */
  fill(c: ColorRgba8, area: Rect = this.bounds): Rect {
    assertIntegerRect(area);
    const r = intersectRects(area, this.bounds);
    if (isEmptyRect(r)) return r;
    const row = new Uint8ClampedArray(r.width * BPP);
    new Uint32Array(row.buffer).fill(packRgba8(c));
    for (let y = r.y; y < r.y + r.height; y++) {
      this.data.set(row, (y * this.width + r.x) * BPP);
    }
    return r;
  }

  /**
   * Copies `srcRect` of `src` so its top-left lands at (`dx`, `dy`), clipped to both surfaces.
   * `src` may be this surface; overlapping copies behave as if the source was copied first.
   * Returns the destination rectangle actually written.
   */
  copyFrom(src: Surface, srcRect: Rect, dx: number, dy: number): Rect {
    assertIntegerRect(srcRect);
    assertIntegerRect(rect(dx, dy, 0, 0));
    const s = intersectRects(srcRect, src.bounds);
    const ox = dx - srcRect.x;
    const oy = dy - srcRect.y;
    const d = intersectRects(rect(s.x + ox, s.y + oy, s.width, s.height), this.bounds);
    if (isEmptyRect(d)) return d;
    const sx = d.x - ox;
    const sy = d.y - oy;
    const rowBytes = d.width * BPP;
    // Copying within one surface downwards must go bottom-up so rows are read before overwritten;
    // `set` already handles overlap inside a single row.
    const bottomUp = src === this && d.y > sy;
    for (let i = 0; i < d.height; i++) {
      const row = bottomUp ? d.height - 1 - i : i;
      const from = ((sy + row) * src.width + sx) * BPP;
      this.data.set(
        src.data.subarray(from, from + rowBytes),
        ((d.y + row) * this.width + d.x) * BPP,
      );
    }
    return d;
  }

  /** True when every byte is zero (fully transparent black). */
  isTransparent(): boolean {
    return this.data.every((v) => v === 0);
  }

  #inside(x: number, y: number): boolean {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < this.width &&
      y < this.height
    );
  }
}
