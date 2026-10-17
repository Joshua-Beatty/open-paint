import { type Rect, rectFromEdges, type Size, TILE_SIZE } from "@openpaint/document";
import type { Sampling } from "../display-tiles";
import { resolveView, type ViewState } from "../view";

/** Composite tiles are 256 pixels across at their mip level, like layer tiles. */
export const COMPOSITE_TILE_SIZE = TILE_SIZE;
/** The deepest mip level of a layer tile: 256 px down to 1 px. */
export const MAX_MIP_LEVEL = 8;

/** ARC-03-04: the mip level a zoom samples, log2(1 / zoom) floored, within the tile's chain. */
export function compositeLevel(zoom: number): number {
  return Math.min(MAX_MIP_LEVEL, Math.max(0, Math.floor(Math.log2(1 / zoom))));
}

/** ARC-03-05: nearest neighbor at level 0 and zoom >= 100 %, linear otherwise. */
export function compositeSampling(level: number, zoom: number): Sampling {
  return level === 0 && zoom >= 1 ? "nearest" : "bilinear";
}

/** Document pixels covered by one composite tile edge at `level`. */
export function compositeEdge(level: number): number {
  return COMPOSITE_TILE_SIZE * 2 ** level;
}

export function compositeKey(level: number, cx: number, cy: number): string {
  return `${level}/${cx}/${cy}`;
}

/** One composite tile on screen: where it sits in the composite grid and in device pixels. */
export interface CompositeDraw {
  readonly key: string;
  readonly level: number;
  readonly cx: number;
  readonly cy: number;
  readonly dst: Rect;
  /**
   * The share of the tile, across and down, that the image covers and `dst` shows: 1 except in
   * the tiles at the image's right and bottom edges, whose `dst` ends at the canvas edge.
   */
  readonly cover: { readonly x: number; readonly y: number };
}

/** The visible part of the image for one frame. */
export interface CompositePlan {
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
  /** The image's on-screen rectangle in device pixels. */
  readonly canvas: Rect;
  readonly level: number;
  readonly sampling: Sampling;
  readonly draws: readonly CompositeDraw[];
}

/**
 * Plans the composite tiles that cover the viewport at the view's mip level. Tile rectangles use
 * the same rounding as the v1 frame planner, so neighbours share edges and no seams open, and the
 * image's edge tiles end at the canvas edge, so the image covers the checkerboard exactly.
 */
export function planComposite(view: ViewState, doc: Size, viewport: Size): CompositePlan {
  const { zoom, originX, originY } = resolveView(view, doc, viewport);
  const canvas = rectFromEdges(
    originX,
    originY,
    Math.round(originX + doc.width * zoom),
    Math.round(originY + doc.height * zoom),
  );
  const level = compositeLevel(zoom);
  const edge = compositeEdge(level);
  const draws: CompositeDraw[] = [];
  const x0 = Math.max(0, -originX / zoom);
  const x1 = Math.min(doc.width, (viewport.width - originX) / zoom);
  const y0 = Math.max(0, -originY / zoom);
  const y1 = Math.min(doc.height, (viewport.height - originY) / zoom);
  if (x1 > x0 && y1 > y0) {
    const cx1 = Math.min(Math.ceil(doc.width / edge), Math.ceil(x1 / edge)) - 1;
    const cy1 = Math.min(Math.ceil(doc.height / edge), Math.ceil(y1 / edge)) - 1;
    for (let cy = Math.floor(y0 / edge); cy <= cy1; cy++) {
      for (let cx = Math.floor(x0 / edge); cx <= cx1; cx++) {
        const dst = rectFromEdges(
          Math.round(originX + cx * edge * zoom),
          Math.round(originY + cy * edge * zoom),
          Math.min(canvas.x + canvas.width, Math.round(originX + (cx + 1) * edge * zoom)),
          Math.min(canvas.y + canvas.height, Math.round(originY + (cy + 1) * edge * zoom)),
        );
        if (dst.width <= 0 || dst.height <= 0) continue;
        const cover = {
          x: Math.min(1, (doc.width - cx * edge) / edge),
          y: Math.min(1, (doc.height - cy * edge) / edge),
        };
        draws.push({ key: compositeKey(level, cx, cy), level, cx, cy, dst, cover });
      }
    }
  }
  return {
    width: viewport.width,
    height: viewport.height,
    zoom,
    canvas,
    level,
    sampling: compositeSampling(level, zoom),
    draws,
  };
}

interface Entry {
  readonly slot: number;
  /** A layer tile under it changed since it was blended. */
  dirty: boolean;
  /** The frame that last drew it, for eviction. */
  used: number;
}

/** A draw that needs blending this frame, and the slot its result goes to. */
export interface CompositeWork {
  readonly draw: CompositeDraw;
  readonly slot: number;
}

/**
 * The cache of blended composite tiles. Each tile holds a slot of the
 * compositor's texture array. A tile is blended again only when a layer tile under it changes
 * (`invalidateTile`) or the stack changes (`invalidateAll`). A new mip level uses its own keys,
 * so zooming within a level and panning over cached tiles only re-present.
 */
export class CompositeCache {
  readonly #entries = new Map<string, Entry>();
  readonly #free: number[] = [];
  #slots = 0;
  #frame = 0;

  /** At least `minimum` tiles stay cached; beyond that, tiles not drawn recently are evicted. */
  constructor(readonly minimum = 64) {}

  /** Slots handed out so far; the compositor's texture array must hold this many. */
  get slotCount(): number {
    return this.#slots;
  }

  get size(): number {
    return this.#entries.size;
  }

  isDirty(key: string): boolean {
    return this.#entries.get(key)?.dirty ?? true;
  }

  /** Marks every cached tile over layer tile (`tx`, `ty`) for blending, at every level. */
  invalidateTile(tx: number, ty: number): void {
    for (let level = 0; level <= MAX_MIP_LEVEL; level++) {
      const entry = this.#entries.get(compositeKey(level, tx >> level, ty >> level));
      if (entry) entry.dirty = true;
    }
  }

  invalidateAll(): void {
    for (const entry of this.#entries.values()) entry.dirty = true;
  }

  /** Forgets every tile, as when the device or the document changes. */
  clear(): void {
    this.#entries.clear();
    this.#free.length = 0;
    this.#slots = 0;
  }

  /**
   * Gives every draw of a frame its slot and returns the ones to blend: new tiles and dirty ones.
   * The slots of `slots` line up with `draws`.
   */
  prepare(draws: readonly CompositeDraw[]): { slots: number[]; work: CompositeWork[] } {
    this.#frame += 1;
    const frame = this.#frame;
    const slots: number[] = [];
    const work: CompositeWork[] = [];
    for (const draw of draws) {
      const entry = this.#entries.get(draw.key);
      if (entry) entry.used = frame;
    }
    const limit = Math.max(this.minimum, draws.length * 2);
    for (const draw of draws) {
      let entry = this.#entries.get(draw.key);
      if (!entry) {
        entry = { slot: this.#slot(frame, limit), dirty: true, used: frame };
        this.#entries.set(draw.key, entry);
      }
      slots.push(entry.slot);
      if (entry.dirty) {
        entry.dirty = false;
        work.push({ draw, slot: entry.slot });
      }
    }
    return { slots, work };
  }

  /** A free slot, evicting the least recently drawn tile once the cache is at `limit`. */
  #slot(frame: number, limit: number): number {
    if (this.#entries.size >= limit) {
      let oldest: [string, Entry] | undefined;
      for (const item of this.#entries) {
        if (item[1].used === frame) continue;
        if (!oldest || item[1].used < oldest[1].used) oldest = item;
      }
      if (oldest) {
        this.#entries.delete(oldest[0]);
        this.#free.push(oldest[1].slot);
      }
    }
    return this.#free.pop() ?? this.#slots++;
  }
}
