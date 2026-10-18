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

/**
 * A brush stroke's values (two words per pixel, see `LiveBrushStroke`) for a region after it grew
 * from `previous`: the old values moved to their place in the new region, zero elsewhere.
 */
function grownValues(old: Uint32Array, previous: Rect, region: Rect): Uint32Array<ArrayBuffer> {
  const values = new Uint32Array(region.width * region.height * 2);
  if (!isEmptyRect(previous)) {
    for (let y = 0; y < previous.height; y++) {
      const at = ((previous.y - region.y + y) * region.width + previous.x - region.x) * 2;
      values.set(old.subarray(y * previous.width * 2, (y + 1) * previous.width * 2), at);
    }
  }
  return values;
}

/** The part `area` of a stroke's values (two words per pixel) over a region `width` wide. */
function cropValues(values: Uint32Array, width: number, area: Rect): Uint32Array {
  const out = new Uint32Array(area.width * area.height * 2);
  for (let y = 0; y < area.height; y++) {
    const from = ((area.y + y) * width + area.x) * 2;
    out.set(values.subarray(from, from + area.width * 2), y * area.width * 2);
  }
  return out;
}

/** Writes a crop of a stroke's values back to its place `area` in a region `width` wide. */
function placeValues(values: Uint32Array, width: number, area: Rect, crop: Uint32Array): void {
  for (let y = 0; y < area.height; y++) {
    const at = ((area.y + y) * width + area.x) * 2;
    values.set(crop.subarray(y * area.width * 2, (y + 1) * area.width * 2), at);
  }
}

/**
 * The brushes that stamp dabs: the Paintbrush and the Eraser stamp the brush color, and the Clone
 * Stamp stamps the source pixels (TL-BRUSH-CS-01). The stroke keeps its values (two words per
 * pixel, see `LiveBrushStroke`), and each pixel is painted from its original with the coverage
 * they give, so a soft stroke keeps the tip's falloff (TL-BRUSH-01).
 */
class DabPainter implements LivePainter {
  readonly #brush: LiveBrushStroke;
  readonly #clone: boolean;
  /** The values of the final dabs, two words per pixel of the region. */
  #values = new Uint32Array();
  #tail: Float32Array = new Float32Array();
  #tailStarts = false;
  tailArea = EMPTY_RECT;

  constructor(options: BrushOptions, clone: boolean) {
    this.#brush = new LiveBrushStroke(options);
    this.#clone = clone;
  }

  grow(previous: Rect, canvas: LiveCanvas): void {
    this.#values = grownValues(this.#values, previous, canvas.region);
  }

  push(points: readonly StrokePoint[], canvas: LiveCanvas): Rect {
    const dabs = this.#brush.push(pathOf(points));
    this.#stampFinal(dabs, this.#brush.starts, false, canvas);
    this.#tail = this.#brush.tail();
    this.#tailStarts = this.#brush.tailStarts;
    this.tailArea = dabBounds(this.#tail);
    return dabBounds(dabs);
  }

  drawTail(patch: Surface, area: Rect, canvas: LiveCanvas): void {
    if (this.#tail.length === 0) return;
    const local = localArea(area, canvas);
    if (isEmptyRect(local)) return;
    const original = cropSurface(canvas.original, local);
    const values = cropValues(this.#values, canvas.region.width, local);
    const x = local.x + canvas.region.x;
    const y = local.y + canvas.region.y;
    const tail = this.#tail;
    const starts = this.#tailStarts;
    if (!this.#clone) {
      this.#brush.stamp(patch, original, values, x, y, tail, starts, true);
      return;
    }
    const source = cropSurface(this.#sourceOf(canvas), local);
    this.#brush.stampClone(patch, original, source, values, x, y, tail, starts, true);
  }

  finish(canvas: LiveCanvas): Rect {
    const dabs = this.#brush.finish();
    this.#stampFinal(dabs, this.#brush.starts, true, canvas);
    this.#tail = new Float32Array();
    this.tailArea = EMPTY_RECT;
    return dabBounds(dabs);
  }

  free(): void {
    this.#brush.free();
  }

  /**
   * Adds final dabs to the stroke's values and repaints the working copy where the coverage
   * changed. Only the part of the buffers that the dabs reach goes through the kernel.
   */
  #stampFinal(dabs: Float32Array, starts: boolean, ends: boolean, canvas: LiveCanvas): void {
    if (dabs.length === 0) return;
    const { region, original, work } = canvas;
    const local = localArea(dabBounds(dabs), canvas);
    if (isEmptyRect(local)) return;
    const part = cropSurface(work, local);
    const before = cropSurface(original, local);
    const values = cropValues(this.#values, region.width, local);
    const x = local.x + region.x;
    const y = local.y + region.y;
    if (this.#clone) {
      const source = cropSurface(this.#sourceOf(canvas), local);
      this.#brush.stampClone(part, before, source, values, x, y, dabs, starts, ends);
    } else {
      this.#brush.stamp(part, before, values, x, y, dabs, starts, ends);
    }
    work.copyFrom(part, part.bounds, local.x, local.y);
    placeValues(this.#values, region.width, local, values);
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
  /** The values of the final dabs, two words per pixel of the region. */
  #values = new Uint32Array();
  #tail: Float32Array = new Float32Array();
  #tailStarts = false;
  tailArea = EMPTY_RECT;

  constructor(options: BrushOptions, recolor: RecolorOptions) {
    this.#brush = new LiveBrushStroke(options);
    this.#recolor = recolor;
  }

  grow(previous: Rect, canvas: LiveCanvas): void {
    this.#values = grownValues(this.#values, previous, canvas.region);
  }

  push(points: readonly StrokePoint[], canvas: LiveCanvas): Rect {
    const dabs = this.#brush.push(pathOf(points));
    const changed = this.#coverFinal(dabs, this.#brush.starts, false, canvas);
    this.#tail = this.#brush.tail();
    this.#tailStarts = this.#brush.tailStarts;
    this.tailArea = dabBounds(this.#tail);
    return changed;
  }

  drawTail(patch: Surface, area: Rect, canvas: LiveCanvas): void {
    const local = localArea(intersectRects(this.tailArea, area), canvas);
    if (isEmptyRect(local)) return;
    const { region } = canvas;
    const values = cropValues(this.#values, region.width, local);
    this.#brush.cover(
      values,
      local.width,
      local.height,
      local.x + region.x,
      local.y + region.y,
      this.#tail,
      this.#tailStarts,
      true,
    );
    const pixels = cropSurface(canvas.original, local);
    recolorCover(pixels, this.#brush.coverage(values), this.#recolor);
    patch.copyFrom(pixels, pixels.bounds, local.x + region.x - area.x, local.y + region.y - area.y);
  }

  finish(canvas: LiveCanvas): Rect {
    const dabs = this.#brush.finish();
    const changed = this.#coverFinal(dabs, this.#brush.starts, true, canvas);
    this.#tail = new Float32Array();
    this.tailArea = EMPTY_RECT;
    return changed;
  }

  free(): void {
    this.#brush.free();
  }

  /** Adds final dabs to the stroke's values and recolors the working copy where they fall. */
  #coverFinal(dabs: Float32Array, starts: boolean, ends: boolean, canvas: LiveCanvas): Rect {
    const { region } = canvas;
    const { width, height, x, y } = region;
    this.#brush.cover(this.#values, width, height, x, y, dabs, starts, ends);
    const changed = dabBounds(dabs);
    const local = localArea(changed, canvas);
    if (isEmptyRect(local)) return changed;
    const pixels = cropSurface(canvas.original, local);
    const coverage = this.#brush.coverage(cropValues(this.#values, region.width, local));
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
