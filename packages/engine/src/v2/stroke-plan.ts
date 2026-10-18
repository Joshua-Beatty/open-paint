import { TILE_SIZE } from "@openpaint/document";
import { segmentsOf } from "../brush-segments";

/** The segments of one batch that touch one layer tile, and the part of the tile they can change. */
export interface TileStamp {
  readonly tx: number;
  readonly ty: number;
  /** Tile-local pixel bounds, `x0 <= x < x1`. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The segments as flat pairs of indices into the batch's dabs, in stamping order. */
  readonly segments: number[];
}

/**
 * The pixel box a dab can cover, clipped to the image, as the Rust reference bounds it
 * (`sweep_coverage`): floor of the left edge to ceil of the right edge, where the edges are `pad`
 * past the radius (half a pixel for an antialiased tip). Undefined when empty.
 */
export function dabBox(
  x: number,
  y: number,
  diameter: number,
  width: number,
  height: number,
  pad = 0,
): { x0: number; y0: number; x1: number; y1: number } | undefined {
  return segmentBox([x, y, diameter], [x, y, diameter], width, height, pad);
}

/** The pixel box of the tip swept between two dabs (`x, y, diameter`), as `dabBox`. */
function segmentBox(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  width: number,
  height: number,
  pad: number,
): { x0: number; y0: number; x1: number; y1: number } | undefined {
  const ra = a[2] * 0.5 + pad;
  const rb = b[2] * 0.5 + pad;
  const x0 = Math.max(0, Math.floor(Math.min(a[0] - ra, b[0] - rb)));
  const y0 = Math.max(0, Math.floor(Math.min(a[1] - ra, b[1] - rb)));
  const x1 = Math.min(width, Math.ceil(Math.max(a[0] + ra, b[0] + rb)));
  const y1 = Math.min(height, Math.ceil(Math.max(a[1] + ra, b[1] + rb)));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : undefined;
}

/**
 * Groups the segments of a batch of dabs (flat `x, y, diameter` triples, in stamping order) by the
 * 256 px tiles they touch. Joined dabs make a polyline of segments; otherwise each dab is its own
 * segment (see `segmentsOf`). Each tile is stamped by one dispatch that takes, per pixel, the
 * largest coverage of its segments, which gives the same result as stamping them one by one.
 * Tiles come in the order the stroke first reaches them.
 */
export function planStamps(
  dabs: ArrayLike<number>,
  width: number,
  height: number,
  joined = false,
  pad = 0,
): TileStamp[] {
  const tiles = new Map<number, TileStamp>();
  const across = Math.ceil(width / TILE_SIZE);
  const dab = (i: number): [number, number, number] => [
    dabs[i * 3] ?? 0,
    dabs[i * 3 + 1] ?? 0,
    dabs[i * 3 + 2] ?? 0,
  ];
  for (const [ia, ib] of segmentsOf(Math.floor(dabs.length / 3), joined)) {
    const box = segmentBox(dab(ia), dab(ib), width, height, pad);
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
          tile.segments.push(ia, ib);
        } else {
          tiles.set(key, { tx, ty, x0, y0, x1, y1, segments: [ia, ib] });
        }
      }
    }
  }
  return [...tiles.values()];
}
