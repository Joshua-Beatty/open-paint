import { type Rect, rect } from "../geometry";
import { Surface } from "../surface";
import { TILE_BYTES, TILE_SIZE, type TileCoord, type TiledPixelStore } from "../tiled-store";

/** Per tile: tile x, tile y (u32 each) and a present flag (u8). Present tiles add a full tile. */
const TILE_HEADER_BYTES = 9;

/**
 * Captures the tiles of `store` that overlap `area`, or any rectangle of a list (default: the whole
 * store), as a tile patch:
 * each tile is recorded as its full pixels or as "transparent" (unallocated). Restoring the patch
 * with `restoreTiles` reproduces those tiles exactly (DOC-HIS-02, ARC-05-08).
 */
export function captureTiles(
  store: TiledPixelStore,
  area: Rect | readonly Rect[] = store.bounds,
): Uint8Array {
  const tiles = tilesIn(store, area).map(({ tx, ty }) => ({
    tx,
    ty,
    surface: store.getTile(tx, ty),
  }));
  const total = tiles.reduce(
    (sum, tile) => sum + TILE_HEADER_BYTES + (tile.surface ? TILE_BYTES : 0),
    4,
  );
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, tiles.length, true);
  let at = 4;
  for (const { tx, ty, surface } of tiles) {
    view.setUint32(at, tx, true);
    view.setUint32(at + 4, ty, true);
    view.setUint8(at + 8, surface ? 1 : 0);
    at += TILE_HEADER_BYTES;
    if (surface) {
      out.set(surface.data, at);
      at += TILE_BYTES;
    }
  }
  return out;
}

/**
 * A layer's earlier tiles, whole: the tile's pixels as they were, or null for a tile that was
 * transparent (unallocated). Outside the changed area they must equal the store's tiles now.
 */
export type EarlierTiles = (tx: number, ty: number) => Surface | null;

function captureEarlierTiles(store: TiledPixelStore, area: Rect, before: EarlierTiles): Uint8Array {
  const tiles = store.tilesInRect(area).map(({ tx, ty }) => ({ tx, ty, surface: before(tx, ty) }));
  const total = tiles.reduce(
    (sum, tile) => sum + TILE_HEADER_BYTES + (tile.surface ? TILE_BYTES : 0),
    4,
  );
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, tiles.length, true);
  let at = 4;
  for (const { tx, ty, surface } of tiles) {
    view.setUint32(at, tx, true);
    view.setUint32(at + 4, ty, true);
    view.setUint8(at + 8, surface ? 1 : 0);
    at += TILE_HEADER_BYTES;
    if (surface) {
      if (surface.width !== TILE_SIZE || surface.height !== TILE_SIZE) {
        throw new RangeError("An earlier tile must be a whole tile.");
      }
      out.set(surface.data, at);
      at += TILE_BYTES;
    }
  }
  return out;
}

/**
 * The tile patch `captureTiles(store, area)` would have given before `area` was overwritten, when
 * `before` holds `area`'s earlier pixels and nothing outside `area` has changed since: each tile is
 * the store's tile with `before` copied over its part of `area`. A tile is recorded as present when
 * the store has it or `before` covers it, so its pixels are exact either way.
 */
export function captureTilesBefore(
  store: TiledPixelStore,
  area: Rect,
  before: Surface | EarlierTiles,
): Uint8Array {
  if (!(before instanceof Surface)) return captureEarlierTiles(store, area, before);
  if (before.width !== area.width || before.height !== area.height) {
    throw new RangeError("The earlier pixels must cover the area exactly.");
  }
  const tiles = store.tilesInRect(area);
  const out = new Uint8Array(4 + tiles.length * (TILE_HEADER_BYTES + TILE_BYTES));
  const view = new DataView(out.buffer);
  view.setUint32(0, tiles.length, true);
  let at = 4;
  const rowBytes = TILE_SIZE * 4;
  for (const { tx, ty } of tiles) {
    view.setUint32(at, tx, true);
    view.setUint32(at + 4, ty, true);
    view.setUint8(at + 8, 1);
    at += TILE_HEADER_BYTES;
    const surface = store.getTile(tx, ty);
    if (surface) out.set(surface.data, at);
    const x0 = Math.max(area.x, tx * TILE_SIZE);
    const y0 = Math.max(area.y, ty * TILE_SIZE);
    const x1 = Math.min(area.x + area.width, (tx + 1) * TILE_SIZE);
    const y1 = Math.min(area.y + area.height, (ty + 1) * TILE_SIZE);
    const bytes = (x1 - x0) * 4;
    for (let y = y0; y < y1; y++) {
      const from = ((y - area.y) * before.width + (x0 - area.x)) * 4;
      const to = at + (y - ty * TILE_SIZE) * rowBytes + (x0 - tx * TILE_SIZE) * 4;
      out.set(before.data.subarray(from, from + bytes), to);
    }
    at += TILE_BYTES;
  }
  return out;
}

/** The tiles that overlap a rectangle or any of a list of them, each once, in row-major order. */
function tilesIn(store: TiledPixelStore, area: Rect | readonly Rect[]): TileCoord[] {
  if (!Array.isArray(area)) return store.tilesInRect(area as Rect);
  const keys = new Set<number>();
  for (const part of area as readonly Rect[]) {
    for (const { tx, ty } of store.tilesInRect(part)) keys.add(ty * store.tilesX + tx);
  }
  return [...keys]
    .sort((a, b) => a - b)
    .map((key) => ({ tx: key % store.tilesX, ty: Math.floor(key / store.tilesX) }));
}

/** One tile of a tile patch: its whole pixels, or null for a transparent (unallocated) tile. */
export interface PatchTile {
  readonly tx: number;
  readonly ty: number;
  readonly surface: Surface | null;
}

/** The tiles of a tile patch from `captureTiles`, in the patch's order. */
export function readTiles(patch: Uint8Array): PatchTile[] {
  const view = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
  if (patch.length < 4) throw new RangeError("Tile patch is truncated.");
  const count = view.getUint32(0, true);
  const tiles: PatchTile[] = [];
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + TILE_HEADER_BYTES > patch.length) throw new RangeError("Tile patch is truncated.");
    const tx = view.getUint32(at, true);
    const ty = view.getUint32(at + 4, true);
    const present = view.getUint8(at + 8) === 1;
    at += TILE_HEADER_BYTES;
    let surface: Surface | null = null;
    if (present) {
      if (at + TILE_BYTES > patch.length) throw new RangeError("Tile patch is truncated.");
      surface = new Surface(TILE_SIZE, TILE_SIZE);
      surface.data.set(patch.subarray(at, at + TILE_BYTES));
      at += TILE_BYTES;
    }
    tiles.push({ tx, ty, surface });
  }
  return tiles;
}

/**
 * Writes a tile patch from `captureTiles` back into `store`. Recorded tiles are replaced whole, and
 * transparent ones are cleared, so the result is exact for every tile the patch covers.
 */
export function restoreTiles(store: TiledPixelStore, patch: Uint8Array): void {
  const view = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
  if (patch.length < 4) throw new RangeError("Tile patch is truncated.");
  const count = view.getUint32(0, true);
  let at = 4;
  for (let i = 0; i < count; i++) {
    if (at + TILE_HEADER_BYTES > patch.length) throw new RangeError("Tile patch is truncated.");
    const tx = view.getUint32(at, true);
    const ty = view.getUint32(at + 4, true);
    const present = view.getUint8(at + 8) === 1;
    at += TILE_HEADER_BYTES;
    const bounds = store.tileBounds(tx, ty);
    if (bounds.width === 0 || bounds.height === 0) {
      throw new RangeError(`Tile ${tx},${ty} lies outside the store.`);
    }
    if (present) {
      if (at + TILE_BYTES > patch.length) throw new RangeError("Tile patch is truncated.");
      const surface = new Surface(TILE_SIZE, TILE_SIZE);
      surface.data.set(patch.subarray(at, at + TILE_BYTES));
      at += TILE_BYTES;
      store.writeRegion(surface, bounds.x, bounds.y, rect(0, 0, bounds.width, bounds.height));
    } else {
      store.clear(bounds);
    }
  }
  if (at !== patch.length) throw new RangeError("Tile patch has trailing data.");
}
