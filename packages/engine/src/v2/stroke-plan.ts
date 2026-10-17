import { TILE_SIZE } from "@openpaint/document";

/** The dabs of one batch that touch one layer tile, and the part of the tile they can change. */
export interface TileStamp {
  readonly tx: number;
  readonly ty: number;
  /** Tile-local pixel bounds, `x0 <= x < x1`. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Indices into the batch's dabs, in stamping order. */
  readonly dabs: number[];
}

/**
 * The pixel box a dab can cover, clipped to the image, as the Rust reference bounds it
 * (`dab_coverage`): floor of the left edge to ceil of the right edge. Undefined when empty.
 */
export function dabBox(
  x: number,
  y: number,
  diameter: number,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } | undefined {
  const radius = diameter * 0.5;
  const x0 = Math.max(0, Math.floor(x - radius));
  const y0 = Math.max(0, Math.floor(y - radius));
  const x1 = Math.min(width, Math.ceil(x + radius));
  const y1 = Math.min(height, Math.ceil(y + radius));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : undefined;
}

/**
 * Groups a batch of dabs (flat `x, y, diameter` triples, in stamping order) by the 256 px tiles
 * they touch. Each tile is stamped by one dispatch that applies its dabs
 * in order per pixel, which gives the same result as stamping the dabs one by one. Tiles come in
 * the order the stroke first reaches them.
 */
export function planStamps(dabs: ArrayLike<number>, width: number, height: number): TileStamp[] {
  const tiles = new Map<number, TileStamp>();
  const across = Math.ceil(width / TILE_SIZE);
  for (let i = 0; i + 2 < dabs.length; i += 3) {
    const box = dabBox(dabs[i] ?? 0, dabs[i + 1] ?? 0, dabs[i + 2] ?? 0, width, height);
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
          tile.dabs.push(i / 3);
        } else {
          tiles.set(key, { tx, ty, x0, y0, x1, y1, dabs: [i / 3] });
        }
      }
    }
  }
  return [...tiles.values()];
}
