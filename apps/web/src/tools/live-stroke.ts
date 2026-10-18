import {
  type ColorRgba8,
  EMPTY_RECT,
  intersectRects,
  isEmptyRect,
  type Rect,
  rectFromEdges,
  Surface,
  translateRect,
} from "@openpaint/document";
import {
  type BrushOptions,
  dabBounds,
  LiveBrushStroke,
  pencilCells,
  type RecolorOptions,
  recolorCover,
  STROKE_VALUE_WORDS,
  type StrokeBatch,
} from "@openpaint/engine";
import type { StrokePoint, StrokeSpec } from "./paint-stroke";

/**
 * The buffers of a live stroke, all the size of its region: the layer pixels before the stroke,
 * the working copy with every final part of the stroke painted, and for a Clone Stamp the source
 * pixels under the region.
 */
export interface LiveCanvas {
  readonly region: Rect;
  readonly original: Surface;
  readonly work: Surface;
  readonly source: Surface | undefined;
}

/**
 * Paints one stroke while its samples arrive (TL-BRUSH-01): each call paints only the part that
 * the new samples add, so a frame costs the same however long the stroke already is. Over the
 * whole stroke, the working copy equals the whole-stroke render of the tool. Areas are in image
 * pixels and may reach past the region.
 */
export interface LivePainter {
  /** Lays out any buffer of its own for the canvas after the region grew from `previous`. */
  grow(previous: Rect, canvas: LiveCanvas): void;
  /** Paints the final part of the new samples into the working copy. Returns the area it changed. */
  push(points: readonly StrokePoint[], canvas: LiveCanvas): Rect;
  /** Where the part that smoothing still holds back is drawn. Empty when nothing is held back. */
  readonly tailArea: Rect;
  /** Draws the held-back part onto `patch`, a copy of the working copy at `area`. */
  drawTail(patch: Surface, area: Rect, canvas: LiveCanvas): void;
  /** Ends the stroke and paints its remaining part into the working copy. Returns the area. */
  finish(canvas: LiveCanvas): Rect;
  free(): void;
}

/** The flat `x, y, pressure` path of stroke points, in image pixels. */
function pathOf(points: readonly StrokePoint[]): Float32Array {
  const path = new Float32Array(points.length * 3);
  points.forEach((point, index) => {
    path[index * 3] = point.x;
    path[index * 3 + 1] = point.y;
    path[index * 3 + 2] = point.pressure;
  });
  return path;
}

/** A copy of the part `area` of a surface. */
export function cropSurface(surface: Surface, area: Rect): Surface {
  const out = new Surface(area.width, area.height);
  out.copyFrom(surface, area, 0, 0);
  return out;
}

/** The part `area` of a one-byte-per-pixel mask that covers a region `width` pixels wide. */
export function cropCoverage(mask: Uint8Array, width: number, area: Rect): Uint8Array {
  const out = new Uint8Array(area.width * area.height);
  for (let y = 0; y < area.height; y++) {
    const from = (area.y + y) * width + area.x;
    out.set(mask.subarray(from, from + area.width), y * area.width);
  }
  return out;
}

/** `area` in the coordinates of the canvas buffers, clipped to them. */
function localArea(area: Rect, canvas: LiveCanvas): Rect {
  const { region } = canvas;
  return translateRect(intersectRects(area, region), -region.x, -region.y);
}

const WORDS = STROKE_VALUE_WORDS;

/** The edge of the square blocks a stroke's values are kept in. */
const VALUE_BLOCK = 256;

/**
 * A brush stroke's values (`STROKE_VALUE_WORDS` per pixel, see `LiveBrushStroke`) in blocks of
 * `VALUE_BLOCK` image pixels, made where the stroke reaches. Zero elsewhere. A growing region keeps
 * them as they are, so no growth copies them (L2).
 */
class StrokeValues {
  readonly #blocks = new Map<string, Uint32Array>();

  /** A copy of the values over `area` (image pixels), row by row. */
  crop(area: Rect): Uint32Array {
    const out = new Uint32Array(area.width * area.height * WORDS);
    this.#each(area, false, (block, from, at, run) => {
      out.set(block.subarray(from, from + run), at);
    });
    return out;
  }

  /** Writes a crop of the values back to its place `area`. */
  place(area: Rect, crop: Uint32Array): void {
    this.#each(area, true, (block, from, at, run) => {
      block.set(crop.subarray(at, at + run), from);
    });
  }

  /**
   * Calls `visit` for each row run of `area` within a block: the block, the run's first word in
   * it and in a crop of `area`, and its length in words. With `make`, missing blocks are made.
   */
  #each(
    area: Rect,
    make: boolean,
    visit: (block: Uint32Array, from: number, at: number, run: number) => void,
  ): void {
    const right = area.x + area.width;
    const bottom = area.y + area.height;
    for (let by = Math.floor(area.y / VALUE_BLOCK); by * VALUE_BLOCK < bottom; by++) {
      for (let bx = Math.floor(area.x / VALUE_BLOCK); bx * VALUE_BLOCK < right; bx++) {
        const key = `${bx},${by}`;
        let block = this.#blocks.get(key);
        if (block === undefined) {
          if (!make) continue;
          block = new Uint32Array(VALUE_BLOCK * VALUE_BLOCK * WORDS);
          this.#blocks.set(key, block);
        }
        const x0 = Math.max(area.x, bx * VALUE_BLOCK);
        const x1 = Math.min(right, (bx + 1) * VALUE_BLOCK);
        const y0 = Math.max(area.y, by * VALUE_BLOCK);
        const y1 = Math.min(bottom, (by + 1) * VALUE_BLOCK);
        const run = (x1 - x0) * WORDS;
        for (let y = y0; y < y1; y++) {
          const from = ((y - by * VALUE_BLOCK) * VALUE_BLOCK + x0 - bx * VALUE_BLOCK) * WORDS;
          const at = ((y - area.y) * area.width + x0 - area.x) * WORDS;
          visit(block, from, at, run);
        }
      }
    }
  }
}

/** `area` in image pixels, clipped to the canvas region. */
function imageArea(area: Rect, canvas: LiveCanvas): Rect {
  return intersectRects(area, canvas.region);
}
const NO_BATCH: StrokeBatch = {
  dabs: new Float32Array(),
  starts: false,
  ends: true,
  arc: 0,
  provisional: true,
};

/**
 * The brushes that stamp dabs: the Paintbrush and the Eraser stamp the brush color, and the Clone
 * Stamp stamps the source pixels (TL-BRUSH-CS-01). The stroke keeps its values (see `LiveBrushStroke`), and each pixel is painted from its original with the coverage
 * they give, so a soft stroke keeps the tip's falloff (TL-BRUSH-01).
 */
class DabPainter implements LivePainter {
  readonly #brush: LiveBrushStroke;
  readonly #clone: boolean;
  /** The values of the final dabs. */
  readonly #values = new StrokeValues();
  #tail = NO_BATCH;
  tailArea = EMPTY_RECT;

  constructor(options: BrushOptions, clone: boolean) {
    this.#brush = new LiveBrushStroke(options);
    this.#clone = clone;
  }

  grow(): void {}

  push(points: readonly StrokePoint[], canvas: LiveCanvas): Rect {
    const batch = this.#brush.push(pathOf(points));
    this.#stampFinal(batch, canvas);
    this.#tail = this.#brush.tail();
    this.tailArea = dabBounds(this.#tail.dabs);
    return dabBounds(batch.dabs);
  }

  drawTail(patch: Surface, area: Rect, canvas: LiveCanvas): void {
    if (this.#tail.dabs.length === 0) return;
    const local = localArea(area, canvas);
    if (isEmptyRect(local)) return;
    const original = cropSurface(canvas.original, local);
    const values = this.#values.crop(imageArea(area, canvas));
    const x = local.x + canvas.region.x;
    const y = local.y + canvas.region.y;
    const tail = this.#tail;
    if (!this.#clone) {
      this.#brush.stamp(patch, original, values, x, y, tail);
      return;
    }
    const source = cropSurface(this.#sourceOf(canvas), local);
    this.#brush.stampClone(patch, original, source, values, x, y, tail);
  }

  finish(canvas: LiveCanvas): Rect {
    const batch = this.#brush.finish();
    this.#stampFinal(batch, canvas);
    this.#tail = NO_BATCH;
    this.tailArea = EMPTY_RECT;
    return dabBounds(batch.dabs);
  }

  free(): void {
    this.#brush.free();
  }

  /**
   * Adds final dabs to the stroke's values and repaints the working copy where the coverage
   * changed. Only the part of the buffers that the dabs reach goes through the kernel.
   */
  #stampFinal(batch: StrokeBatch, canvas: LiveCanvas): void {
    if (batch.dabs.length === 0) return;
    const { region, original, work } = canvas;
    const local = localArea(dabBounds(batch.dabs), canvas);
    if (isEmptyRect(local)) return;
    const part = cropSurface(work, local);
    const before = cropSurface(original, local);
    const values = this.#values.crop(imageArea(dabBounds(batch.dabs), canvas));
    const x = local.x + region.x;
    const y = local.y + region.y;
    if (this.#clone) {
      const source = cropSurface(this.#sourceOf(canvas), local);
      this.#brush.stampClone(part, before, source, values, x, y, batch);
    } else {
      this.#brush.stamp(part, before, values, x, y, batch);
    }
    work.copyFrom(part, part.bounds, local.x, local.y);
    this.#values.place(imageArea(dabBounds(batch.dabs), canvas), values);
  }

  #sourceOf(canvas: LiveCanvas): Surface {
    if (canvas.source === undefined) throw new Error("A clone stroke needs its source pixels.");
    return canvas.source;
  }
}

/**
 * The Recolor brush (TL-BRUSH-RC-01). It masks with the stroke's coverage, so it keeps the
 * stroke's values as the dabs arrive and recolors the original pixels again where they changed.
 * Since a recolored pixel depends only on its original and its coverage, the result is the
 * whole-stroke recolor.
 */
class RecolorPainter implements LivePainter {
  readonly #brush: LiveBrushStroke;
  readonly #recolor: RecolorOptions;
  /** The values of the final dabs. */
  readonly #values = new StrokeValues();
  #tail = NO_BATCH;
  tailArea = EMPTY_RECT;

  constructor(options: BrushOptions, recolor: RecolorOptions) {
    this.#brush = new LiveBrushStroke(options);
    this.#recolor = recolor;
  }

  grow(): void {}

  push(points: readonly StrokePoint[], canvas: LiveCanvas): Rect {
    const changed = this.#coverFinal(this.#brush.push(pathOf(points)), canvas);
    this.#tail = this.#brush.tail();
    this.tailArea = dabBounds(this.#tail.dabs);
    return changed;
  }

  drawTail(patch: Surface, area: Rect, canvas: LiveCanvas): void {
    const local = localArea(intersectRects(this.tailArea, area), canvas);
    if (isEmptyRect(local)) return;
    const { region } = canvas;
    const values = this.#values.crop(translateRect(local, region.x, region.y));
    const x = local.x + region.x;
    const y = local.y + region.y;
    this.#brush.cover(values, local.width, local.height, x, y, this.#tail);
    const pixels = cropSurface(canvas.original, local);
    const coverage = this.#brush.coverage(values, local.width, local.height, x, y, this.#tail);
    recolorCover(pixels, coverage, this.#recolor);
    patch.copyFrom(pixels, pixels.bounds, local.x + region.x - area.x, local.y + region.y - area.y);
  }

  finish(canvas: LiveCanvas): Rect {
    const changed = this.#coverFinal(this.#brush.finish(), canvas);
    this.#tail = NO_BATCH;
    this.tailArea = EMPTY_RECT;
    return changed;
  }

  free(): void {
    this.#brush.free();
  }

  /** Adds final dabs to the stroke's values and recolors the working copy where they fall. */
  #coverFinal(batch: StrokeBatch, canvas: LiveCanvas): Rect {
    const { region } = canvas;
    const changed = dabBounds(batch.dabs);
    const local = localArea(changed, canvas);
    if (isEmptyRect(local)) return changed;
    const area = translateRect(local, region.x, region.y);
    const values = this.#values.crop(area);
    this.#brush.cover(values, area.width, area.height, area.x, area.y, batch);
    this.#values.place(area, values);
    const pixels = cropSurface(canvas.original, local);
    const coverage = this.#brush.coverage(values, area.width, area.height, area.x, area.y);
    recolorCover(pixels, coverage, this.#recolor);
    canvas.work.copyFrom(pixels, pixels.bounds, local.x, local.y);
    return changed;
  }
}

/**
 * The Pencil (TL-PENCIL-01). Each sample lands on the pixel that contains it, joined to the last
 * one by a line, so the new samples paint only the lines from the last pixel painted.
 */
class PencilPainter implements LivePainter {
  readonly #color: ColorRgba8;
  readonly #blend: number;
  /** The last pixel painted, as `[x, y]`, or undefined before the first. */
  #last: readonly [number, number] | undefined;
  readonly tailArea = EMPTY_RECT;

  constructor(color: ColorRgba8, blend: number) {
    this.#color = color;
    this.#blend = blend;
  }

  grow(): void {}

  push(points: readonly StrokePoint[], canvas: LiveCanvas): Rect {
    if (points.length === 0) return EMPTY_RECT;
    const last = this.#last;
    const joined = last !== undefined;
    const cells = new Int32Array((points.length + (joined ? 1 : 0)) * 2);
    let at = 0;
    if (last !== undefined) {
      cells[0] = last[0];
      cells[1] = last[1];
      at = 2;
    }
    // Single precision, as the whole-stroke render reads its path.
    for (const point of points) {
      cells[at++] = Math.floor(Math.fround(point.x));
      cells[at++] = Math.floor(Math.fround(point.y));
    }
    const { region } = canvas;
    pencilCells(canvas.work, region.x, region.y, cells, joined, this.#color, this.#blend);
    this.#last = [cells[cells.length - 2] ?? 0, cells[cells.length - 1] ?? 0];
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < cells.length; i += 2) {
      const x = cells[i] ?? 0;
      const y = cells[i + 1] ?? 0;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
    return rectFromEdges(left, top, right, bottom);
  }

  drawTail(): void {}

  finish(): Rect {
    return EMPTY_RECT;
  }

  free(): void {}
}

/** The live painter of a stroke. */
export function livePainterFor(spec: StrokeSpec): LivePainter {
  if (spec.kind === "pencil") return new PencilPainter(spec.color, spec.blend);
  if (spec.kind === "recolor") return new RecolorPainter(spec.options, spec.recolor);
  return new DabPainter(spec.options, spec.kind === "clone");
}
