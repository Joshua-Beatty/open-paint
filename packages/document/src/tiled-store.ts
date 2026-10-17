import { type ColorRgba8, TRANSPARENT } from "./color";
import {
  EMPTY_RECT,
  intersectRects,
  isEmptyRect,
  type Rect,
  rect,
  rectsEqual,
  translateRect,
  unionRects,
} from "./geometry";
import { isValidImageSize } from "./limits";
import { allocateWithBudget, MemoryAccountant } from "./memory";
import { type ColorProfileId, PIXEL_FORMATS, type PixelFormat } from "./pixel-format";
import { assertIntegerRect, Surface } from "./surface";

/** Edge length of a pixel-store tile (ARC-04-06, ARC-05-04). */
export const TILE_SIZE = 256;
export const TILE_BYTES = TILE_SIZE * TILE_SIZE * PIXEL_FORMATS.rgba8.bytesPerPixel;

/** The last tile version handed out, by any store (`TiledPixelStore.tileVersion`). */
let tileVersionCounter = 0;

export interface TileCoord {
  readonly tx: number;
  readonly ty: number;
}

/** A dirty tile and the store rectangle changed in it (`TiledPixelStore.takeDirtyRegions`). */
export interface DirtyRegion extends TileCoord {
  readonly area: Rect;
}

export interface TiledPixelStoreOptions {
  /** Shared per-document budget; each store gets its own default-budget accountant otherwise. */
  readonly accountant?: MemoryAccountant;
  readonly colorProfile?: ColorProfileId;
}

/**
 * Sparse tiled RGBA8 straight-alpha pixel storage for one layer-sized bitmap (ARC-05-04/08).
 * Tiles are allocated on first write as full `TILE_SIZE` squares; a missing tile reads as
 * transparent black. Every allocation is reserved against the memory accountant before any pixel
 * changes, so an out-of-memory failure leaves the store untouched (ARC-05-05/07). Writes mark the
 * touched tiles dirty for GPU upload and history.
 */
export class TiledPixelStore {
  readonly format: PixelFormat = "rgba8";
  readonly tileSize = TILE_SIZE;
  readonly colorProfile: ColorProfileId;
  readonly accountant: MemoryAccountant;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly #tiles = new Map<number, Surface>();
  /** The dirty tiles, each with the part of it changed since tracking was last reset. */
  readonly #dirty = new Map<number, Rect>();
  readonly #versions = new Map<number, number>();
  /** Tiles a fill covered whole and nothing has written since, with their color (L9). */
  readonly #uniform = new Map<number, ColorRgba8>();
  #version = 0;

  /** Bytes needed if every tile of a `width` x `height` store were allocated (WEB-MEM-03). */
  static estimateBytes(width: number, height: number): number {
    return Math.ceil(width / TILE_SIZE) * Math.ceil(height / TILE_SIZE) * TILE_BYTES;
  }

  constructor(
    readonly width: number,
    readonly height: number,
    options: TiledPixelStoreOptions = {},
  ) {
    if (!isValidImageSize(width, height)) {
      throw new RangeError(`Invalid image size ${width}x${height}.`);
    }
    this.accountant = options.accountant ?? new MemoryAccountant();
    this.colorProfile = options.colorProfile ?? "srgb";
    this.tilesX = Math.ceil(width / TILE_SIZE);
    this.tilesY = Math.ceil(height / TILE_SIZE);
  }

  get bounds(): Rect {
    return rect(0, 0, this.width, this.height);
  }

  get allocatedTileCount(): number {
    return this.#tiles.size;
  }

  get allocatedBytes(): number {
    return this.#tiles.size * TILE_BYTES;
  }

  /** The image-space rectangle covered by a tile, clipped to the store bounds. */
  tileBounds(tx: number, ty: number): Rect {
    return intersectRects(rect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE), this.bounds);
  }

  /** Tiles overlapping `area` (clipped to the store), in row-major order. */
  tilesInRect(area: Rect): TileCoord[] {
    const r = intersectRects(area, this.bounds);
    if (isEmptyRect(r)) return [];
    const coords: TileCoord[] = [];
    const ty1 = Math.floor((r.y + r.height - 1) / TILE_SIZE);
    const tx1 = Math.floor((r.x + r.width - 1) / TILE_SIZE);
    for (let ty = Math.floor(r.y / TILE_SIZE); ty <= ty1; ty++) {
      for (let tx = Math.floor(r.x / TILE_SIZE); tx <= tx1; tx++) coords.push({ tx, ty });
    }
    return coords;
  }

  /** Allocated tiles in row-major order. */
  allocatedTiles(): TileCoord[] {
    return [...this.#tiles.keys()].sort((a, b) => a - b).map((key) => this.#coord(key));
  }

  /**
   * The tile's backing surface, or undefined when the tile is unallocated (transparent).
   * Treat it as read-only; mutate through the store so dirty tracking stays correct.
   */
  getTile(tx: number, ty: number): Surface | undefined {
    return this.#tiles.get(this.#key(tx, ty));
  }

  getPixel(x: number, y: number): ColorRgba8 {
    const tile = this.#tiles.get(this.#key(Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE)));
    if (!tile || x < 0 || y < 0 || x >= this.width || y >= this.height) return TRANSPARENT;
    return tile.getPixel(x % TILE_SIZE, y % TILE_SIZE);
  }

  setPixel(x: number, y: number, c: ColorRgba8): void {
    this.fill(c, rect(x, y, 1, 1));
  }

  /** Copies `area` into a new surface; pixels outside the store read as transparent. */
  readRegion(area: Rect): Surface {
    assertIntegerRect(area);
    const out = new Surface(Math.max(0, area.width), Math.max(0, area.height));
    for (const { tx, ty } of this.tilesInRect(area)) {
      const tile = this.getTile(tx, ty);
      if (!tile) continue;
      const part = intersectRects(area, this.tileBounds(tx, ty));
      const origin = this.#origin(tx, ty);
      out.copyFrom(
        tile,
        translateRect(part, -origin.x, -origin.y),
        part.x - area.x,
        part.y - area.y,
      );
    }
    return out;
  }

  /**
   * Writes `srcRect` of `src` with its top-left at (`x`, `y`), clipped to the store. Returns the
   * store rectangle written. Throws `OutOfMemoryError` without changes if tiles cannot be allocated.
   */
  writeRegion(src: Surface, x: number, y: number, srcRect: Rect = src.bounds): Rect {
    assertIntegerRect(srcRect);
    assertIntegerRect(rect(x, y, 0, 0));
    const dx = x - srcRect.x;
    const dy = y - srcRect.y;
    const target = intersectRects(
      translateRect(intersectRects(srcRect, src.bounds), dx, dy),
      this.bounds,
    );
    const coords = this.tilesInRect(target);
    this.#allocate(coords);
    for (const { tx, ty } of coords) {
      const part = intersectRects(target, this.tileBounds(tx, ty));
      const origin = this.#origin(tx, ty);
      this.#uniform.delete(this.#key(tx, ty));
      this.#tile(tx, ty).copyFrom(
        src,
        translateRect(part, -dx, -dy),
        part.x - origin.x,
        part.y - origin.y,
      );
      this.#touch(this.#key(tx, ty), part);
    }
    return target;
  }

  /**
   * Fills `area` (clipped, default everything) with `c`. Filling a whole tile with transparent
   * frees it. Returns the store rectangle filled.
   */
  fill(c: ColorRgba8, area: Rect = this.bounds): Rect {
    assertIntegerRect(area);
    const target = intersectRects(area, this.bounds);
    const clearing = c.r === 0 && c.g === 0 && c.b === 0 && c.a === 0;
    const coords = this.tilesInRect(target);
    if (!clearing) this.#allocate(coords);
    for (const { tx, ty } of coords) {
      const key = this.#key(tx, ty);
      const tile = this.#tiles.get(key);
      if (!tile) continue;
      const tileRect = this.tileBounds(tx, ty);
      const part = intersectRects(target, tileRect);
      if (clearing && rectsEqual(part, tileRect)) {
        this.#free(key);
      } else {
        const origin = this.#origin(tx, ty);
        tile.fill(c, translateRect(part, -origin.x, -origin.y));
        const whole = part.width === TILE_SIZE && part.height === TILE_SIZE;
        if (whole) this.#uniform.set(key, c);
        else this.#uniform.delete(key);
      }
      this.#touch(key, part);
    }
    return target;
  }

  /** Makes `area` transparent, freeing fully covered tiles. */
  clear(area: Rect = this.bounds): Rect {
    return this.fill(TRANSPARENT, area);
  }

  /**
   * Copies `srcRect` of `src` (which may be this store; overlap is safe) so its top-left lands at
   * (`dx`, `dy`). Source pixels outside `src` copy as transparent. Returns the rectangle written.
   */
  copyRegion(src: TiledPixelStore, srcRect: Rect, dx: number, dy: number): Rect {
    return this.writeRegion(src.readRegion(srcRect), dx, dy);
  }

  get dirtyTileCount(): number {
    return this.#dirty.size;
  }

  isTileDirty(tx: number, ty: number): boolean {
    return this.#dirty.has(this.#key(tx, ty));
  }

  /** Dirty tiles in row-major order. */
  dirtyTiles(): TileCoord[] {
    return [...this.#dirty.keys()].sort((a, b) => a - b).map((key) => this.#coord(key));
  }

  /** Union of the dirty tiles' bounds, or an empty rectangle. */
  dirtyBounds(): Rect {
    let bounds = EMPTY_RECT;
    for (const key of this.#dirty.keys()) {
      const { tx, ty } = this.#coord(key);
      bounds = unionRects(bounds, this.tileBounds(tx, ty));
    }
    return bounds;
  }

  markDirty(area: Rect = this.bounds): void {
    for (const { tx, ty } of this.tilesInRect(area)) {
      this.#touch(this.#key(tx, ty), intersectRects(area, this.tileBounds(tx, ty)));
    }
  }

  /**
   * The color of a tile that a fill covered whole and nothing has written since, or undefined. A
   * sync sends such a tile as its color rather than its bytes (L9).
   */
  uniformColor(tx: number, ty: number): ColorRgba8 | undefined {
    return this.#uniform.get(this.#key(tx, ty));
  }

  /**
   * A number that changes whenever the tile is written, filled, freed or marked dirty, and is 0
   * for a tile never touched. Versions are unique across all stores, so a cache can tell whether a
   * tile changed since it last read it without consuming the dirty set (which the engine sync owns).
   */
  tileVersion(tx: number, ty: number): number {
    return this.#versions.get(this.#key(tx, ty)) ?? 0;
  }

  /**
   * The latest tile version of the store: it changes whenever any tile does, and is 0 for a store
   * never written. Two stores never share a version above 0.
   */
  get version(): number {
    return this.#version;
  }

  /**
   * Returns the dirty tiles, each with the store rectangle changed in it since tracking was last
   * reset, and resets tracking. A tile allocated or freed since then counts as changed whole, so a
   * copy that receives only the changed rectangles stays equal to this store (L9).
   */
  takeDirtyRegions(): DirtyRegion[] {
    const regions = [...this.#dirty]
      .sort(([a], [b]) => a - b)
      .map(([key, area]) => ({ ...this.#coord(key), area }));
    this.#dirty.clear();
    return regions;
  }

  /** Returns the dirty tiles and resets tracking, e.g. after uploading them. */
  takeDirtyTiles(): TileCoord[] {
    const tiles = this.dirtyTiles();
    this.#dirty.clear();
    return tiles;
  }

  clearDirty(): void {
    this.#dirty.clear();
  }

  /** Frees every tile and returns its memory to the accountant. */
  dispose(): void {
    for (const key of [...this.#tiles.keys()]) this.#free(key);
    this.#dirty.clear();
  }

  #touch(key: number, part: Rect): void {
    const previous = this.#dirty.get(key);
    this.#dirty.set(key, previous === undefined ? part : unionRects(previous, part));
    tileVersionCounter += 1;
    this.#versions.set(key, tileVersionCounter);
    this.#version = tileVersionCounter;
  }

  #key(tx: number, ty: number): number {
    return tx < 0 || ty < 0 || tx >= this.tilesX || ty >= this.tilesY ? -1 : ty * this.tilesX + tx;
  }

  #coord(key: number): TileCoord {
    return { tx: key % this.tilesX, ty: Math.floor(key / this.tilesX) };
  }

  #origin(tx: number, ty: number): { x: number; y: number } {
    return { x: tx * TILE_SIZE, y: ty * TILE_SIZE };
  }

  #tile(tx: number, ty: number): Surface {
    const tile = this.#tiles.get(this.#key(tx, ty));
    if (!tile) throw new Error(`Tile ${tx},${ty} is not allocated.`);
    return tile;
  }

  /** Allocates every missing tile in `coords` as one all-or-nothing reservation. */
  #allocate(coords: readonly TileCoord[]): void {
    const missing = coords
      .map(({ tx, ty }) => this.#key(tx, ty))
      .filter((k) => !this.#tiles.has(k));
    if (missing.length === 0) return;
    const tiles = allocateWithBudget(this.accountant, missing.length * TILE_BYTES, () =>
      missing.map(() => new Surface(TILE_SIZE, TILE_SIZE)),
    );
    missing.forEach((key, i) => {
      this.#tiles.set(key, tiles[i] as Surface);
      const { tx, ty } = this.#coord(key);
      this.#dirty.set(key, this.tileBounds(tx, ty));
    });
  }

  #free(key: number): void {
    this.#uniform.delete(key);
    if (this.#tiles.delete(key)) this.accountant.release(TILE_BYTES);
  }
}
