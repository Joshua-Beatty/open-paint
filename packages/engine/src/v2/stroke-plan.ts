import { TILE_SIZE } from "@openpaint/document";
import { type TermOptions, termBox, termsOf } from "../brush-segments";

/** The parts of one batch that touch one layer tile, and the part of the tile they can change. */
export interface TileStamp {
  readonly tx: number;
  readonly ty: number;
  /** Tile-local pixel bounds, `x0 <= x < x1`. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The parts as flat `kind, a, b` triples (see `termsOf`), in stamping order. */
  readonly terms: number[];
}

/** How a batch's dabs make parts: `termsOf`'s options and the tip's antialiasing. */
export interface StampOptions extends TermOptions {
  readonly antialias: boolean;
}

/**
 * Groups the parts of a batch of dabs (flat `x, y, diameter` triples, in stamping order, see
 * `termsOf`) by the 256 px tiles they can change. Each tile is stamped by one dispatch that
 * applies its parts per pixel, which gives the same result as applying them one by one. Tiles come
 * in the order the stroke first reaches them.
 */
export function planStamps(
  dabs: ArrayLike<number>,
  width: number,
  height: number,
  options: StampOptions,
): TileStamp[] {
  const tiles = new Map<number, TileStamp>();
  const across = Math.ceil(width / TILE_SIZE);
  for (const term of termsOf(dabs, options)) {
    const box = termBox(dabs, term, options.antialias, options.square, width, height);
    if (!box) continue;
    const tx1 = Math.floor((box.x1 - 1) / TILE_SIZE);
    const ty1 = Math.floor((box.y1 - 1) / TILE_SIZE);
    for (let ty = Math.floor(box.y0 / TILE_SIZE); ty <= ty1; ty++) {
      for (let tx = Math.floor(box.x0 / TILE_SIZE); tx <= tx1; tx++) {
        const ox = tx * TILE_SIZE;
        const oy = ty * TILE_SIZE;
        const x0 = Math.max(box.x0, ox) - ox;
        const y0 = Math.max(box.y0, oy) - oy;
        const x1 = Math.min(box.x1, ox + TILE_SIZE) - ox;
        const y1 = Math.min(box.y1, oy + TILE_SIZE) - oy;
        const key = ty * across + tx;
        const tile = tiles.get(key);
        if (tile) {
          tile.x0 = Math.min(tile.x0, x0);
          tile.y0 = Math.min(tile.y0, y0);
          tile.x1 = Math.max(tile.x1, x1);
          tile.y1 = Math.max(tile.y1, y1);
          tile.terms.push(term.kind, term.a, term.b);
        } else {
          tiles.set(key, { tx, ty, x0, y0, x1, y1, terms: [term.kind, term.a, term.b] });
        }
      }
    }
  }
  return [...tiles.values()];
}
