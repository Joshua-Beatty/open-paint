import {
  isEmptyRect,
  type Rect,
  rect,
  Surface,
  TILE_SIZE,
  type TiledPixelStore,
} from "@openpaint/document";
import { activeLayers, type CompositeDocument } from "./composite";
import { compositeCpu } from "./composite-cpu";
import { boxHalveRgba8, compositeRgba8, premultiplyRgba8, resampleLanczos3Rgba8 } from "./cpu";
import { applyLiveFilter } from "./live-filter";

/** ARC-03-03: display tiles are 128 device pixels across at every mip level. */
export const DISPLAY_TILE_SIZE = 128;
/** Tiles kept in memory before the least recently used are evicted (64 MiB of RGBA8). */
export const DISPLAY_TILE_CAPACITY = 1024;

/** ARC-03-05: nearest neighbor at level 0 and zoom >= 100 %, bilinear otherwise. */
export type Sampling = "nearest" | "bilinear";

/**
 * One cached display tile: premultiplied RGBA8 sRGB (ARC-03-07). `level` 0 covers 128 document
 * pixels per tile edge. Level n covers 128 * 2^n, at 1/2^n resolution.
 */
export interface DisplayTile {
  readonly level: number;
  readonly tx: number;
  readonly ty: number;
  readonly pixels: Uint8Array;
}

export interface TileRef {
  readonly level: number;
  readonly tx: number;
  readonly ty: number;
}

/** ARC-03-03/04: mip levels until the whole image fits in one tile. */
export function displayLevels(width: number, height: number): number {
  const extent = Math.max(width, height);
  let levels = 1;
  while (DISPLAY_TILE_SIZE * 2 ** (levels - 1) < extent) levels++;
  return levels;
}

/** Document pixels covered by one tile edge at `level`. */
export function tileEdge(level: number): number {
  return DISPLAY_TILE_SIZE * 2 ** level;
}

/** Tiles needed along an axis of `extent` document pixels at `level`. */
export function tilesAcross(extent: number, level: number): number {
  return Math.ceil(extent / tileEdge(level));
}

/** ARC-03-04: mipLevel = log2(1 / zoom), floored and clamped to the available levels. */
export function mipLevel(zoom: number, levels: number): number {
  return Math.min(levels - 1, Math.max(0, Math.floor(Math.log2(1 / zoom))));
}

/** ARC-03-05: nearest neighbor at mip level 0 and zoom >= 100 %, bilinear otherwise. */
export function samplingFor(level: number, zoom: number): Sampling {
  return level === 0 && zoom >= 1 ? "nearest" : "bilinear";
}

export function tileKey(level: number, tx: number, ty: number): string {
  return `${level}/${tx}/${ty}`;
}

interface CacheEntry {
  readonly tile: DisplayTile;
  /** The document changed under this tile. It is still shown until its rebuild replaces it. */
  stale: boolean;
  /** A mip tile from the quick box filter, to be replaced by its Lanczos-3 build when idle. */
  readonly draft: boolean;
}

/**
 * The display tile cache: an LRU of tiles keyed by level and grid position. Reading a tile marks
 * it recently used, so tiles on screen survive eviction. Edits mark tiles stale rather than
 * dropping them, so the canvas keeps showing the previous pixels until fresh ones are built
 * instead of flashing to the checkerboard.
 */
export class DisplayTileCache {
  readonly #tiles = new Map<string, CacheEntry>();
  /** The highest level a tile was cached at since the last clear. */
  #maxLevel = 0;

  constructor(readonly capacity = DISPLAY_TILE_CAPACITY) {}

  get size(): number {
    return this.#tiles.size;
  }

  /** Whether an up-to-date tile is cached. Stale tiles don't count: they still need a rebuild. */
  has(ref: TileRef): boolean {
    const entry = this.#tiles.get(tileKey(ref.level, ref.tx, ref.ty));
    return entry !== undefined && !entry.stale;
  }

  /** Whether the cached tile is out of date. False when nothing is cached. */
  isStale(level: number, tx: number, ty: number): boolean {
    return this.#tiles.get(tileKey(level, tx, ty))?.stale === true;
  }

  /** Whether an up-to-date tile is cached that is a draft (box-filtered) mip tile. */
  isDraft(ref: TileRef): boolean {
    const entry = this.#tiles.get(tileKey(ref.level, ref.tx, ref.ty));
    return entry !== undefined && !entry.stale && entry.draft;
  }

  /** Whether an up-to-date, final (not draft) tile is cached. */
  hasFinal(ref: TileRef): boolean {
    const entry = this.#tiles.get(tileKey(ref.level, ref.tx, ref.ty));
    return entry !== undefined && !entry.stale && !entry.draft;
  }

  /**
   * The tile the display shows at `ref` now and whether it is up to date (not stale), without
   * marking it used. Undefined when nothing is cached there.
   */
  peek(ref: TileRef): { readonly tile: DisplayTile; readonly fresh: boolean } | undefined {
    const entry = this.#tiles.get(tileKey(ref.level, ref.tx, ref.ty));
    return entry === undefined ? undefined : { tile: entry.tile, fresh: !entry.stale };
  }

  /** The cached tile for display, fresh or stale. */
  get(level: number, tx: number, ty: number): DisplayTile | undefined {
    const key = tileKey(level, tx, ty);
    const entry = this.#tiles.get(key);
    if (entry) {
      this.#tiles.delete(key);
      this.#tiles.set(key, entry);
    }
    return entry?.tile;
  }

  put(tile: DisplayTile, draft = false): void {
    this.#maxLevel = Math.max(this.#maxLevel, tile.level);
    const key = tileKey(tile.level, tile.tx, tile.ty);
    this.#tiles.delete(key);
    this.#tiles.set(key, { tile, stale: false, draft });
    while (this.#tiles.size > this.capacity) {
      const oldest = this.#tiles.keys().next().value as string;
      this.#tiles.delete(oldest);
    }
  }

  /**
   * Marks stale every tile whose document footprint overlaps `area`, at every level. It looks up
   * the tiles under `area` at each cached level rather than scanning the cache, so the cost follows
   * the area, not the number of cached tiles (L2).
   */
  invalidate(area: Rect): void {
    if (isEmptyRect(area)) return;
    const right = area.x + area.width;
    const bottom = area.y + area.height;
    for (let level = 0; level <= this.#maxLevel; level++) {
      const edge = tileEdge(level);
      const tx1 = Math.ceil(right / edge);
      const ty1 = Math.ceil(bottom / edge);
      for (let ty = Math.floor(area.y / edge); ty < ty1; ty++) {
        for (let tx = Math.floor(area.x / edge); tx < tx1; tx++) {
          const entry = this.#tiles.get(tileKey(level, tx, ty));
          if (entry !== undefined) entry.stale = true;
        }
      }
    }
  }

  clear(): void {
    this.#tiles.clear();
    this.#maxLevel = 0;
  }
}

/** A tile to build, and whether it must be final (Lanczos-3) rather than a draft. */
interface BuildItem {
  readonly ref: TileRef;
  readonly final: boolean;
}

/**
 * Builds display tiles on demand. Level 0 is the composite of the document (straight alpha, then
 * premultiplied). A higher level is a downscale of its 2x2 children, built first. Requested tiles
 * are built as drafts: a 2x2 box filter, which is about 30 times faster than Lanczos-3, so an edit
 * at a zoomed-out view reaches the screen quickly (L2/L7). Tiles passed to `request` as `refine`
 * are then rebuilt with Lanczos-3 from final children (ARC-03-04) once nothing else is pending.
 * Work is pumped in small slices so the engine stays responsive while a large image renders
 * (ARC-03-06). Tiles are built against the document at the time of the build.
 */
export class DisplayTileBuilder {
  readonly #stack: BuildItem[] = [];

  constructor(
    readonly cache: DisplayTileCache,
    private readonly document: () => CompositeDocument,
  ) {}

  get pending(): boolean {
    return this.#stack.length > 0;
  }

  /**
   * Replaces the work list. `refs` are in priority order: the first is built first. When none of
   * them needs building, the drafts among `refine` are queued for their final build.
   */
  request(refs: readonly TileRef[], refine: readonly TileRef[] = []): void {
    this.#stack.length = 0;
    for (const ref of [...refs].reverse()) {
      if (!this.cache.has(ref)) this.#stack.push({ ref, final: false });
    }
    if (this.#stack.length > 0) return;
    for (const ref of [...refine].reverse()) {
      if (this.cache.isDraft(ref)) this.#stack.push({ ref, final: true });
    }
  }

  clear(): void {
    this.#stack.length = 0;
  }

  /** Builds tiles until the work list is empty or `now()` reaches `deadline`. Returns the count. */
  pump(deadline: number, now: () => number): number {
    const doc = this.document();
    let built = 0;
    while (this.#stack.length > 0 && now() < deadline) {
      const item = this.#stack[this.#stack.length - 1] as BuildItem;
      const { ref, final } = item;
      const ready = (tile: TileRef) => (final ? this.cache.hasFinal(tile) : this.cache.has(tile));
      if (ready(ref)) {
        this.#stack.pop();
        continue;
      }
      if (ref.level === 0) {
        this.cache.put(renderBase(doc, ref));
        this.#stack.pop();
        built++;
        continue;
      }
      const missing = childrenOf(doc, ref).filter((child) => !ready(child));
      if (missing.length > 0 && !final && hasLiveFilter(doc)) {
        // A live filter changes every tile on each dialog change, and building the children
        // composites the whole image at full size. A draft sampled at this level shows the change
        // at screen cost; the final build replaces it once the changes pause.
        this.cache.put(renderSampled(doc, ref), true);
        this.#stack.pop();
        built++;
        continue;
      }
      if (missing.length > 0) {
        for (const child of missing.reverse()) this.#stack.push({ ref: child, final });
        continue;
      }
      this.cache.put(downsample(this.cache, doc, ref, final), !final);
      this.#stack.pop();
      built++;
    }
    return built;
  }
}
/** The in-grid children of a tile one level down (its 2x2 block). */
function childrenOf(doc: CompositeDocument, ref: TileRef): TileRef[] {
  const level = ref.level - 1;
  const across = tilesAcross(doc.width, level);
  const down = tilesAcross(doc.height, level);
  const children: TileRef[] = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const tx = ref.tx * 2 + dx;
      const ty = ref.ty * 2 + dy;
      if (tx < across && ty < down) children.push({ level, tx, ty });
    }
  }
  return children;
}

function renderBase(doc: CompositeDocument, ref: TileRef): DisplayTile {
  const size = DISPLAY_TILE_SIZE;
  const area = rect(ref.tx * size, ref.ty * size, size, size);
  const surface = compositeCpu(doc, area);
  const pixels = new Uint8Array(surface.data.buffer, surface.data.byteOffset, surface.data.length);
  premultiplyRgba8(pixels);
  padTile(pixels, size, doc.width - area.x, doc.height - area.y);
  return { level: ref.level, tx: ref.tx, ty: ref.ty, pixels };
}

function hasLiveFilter(doc: CompositeDocument): boolean {
  return doc.layers.some((layer) => layer.live !== undefined);
}

/**
 * A draft of a mip tile built straight from the layers: each tile pixel takes the document pixel
 * at the center of the block it covers, from every active layer, through the layer's live filter,
 * and the layers are blended as at level 0. It costs the tile's own pixels, not its block's.
 */
function renderSampled(doc: CompositeDocument, ref: TileRef): DisplayTile {
  const size = DISPLAY_TILE_SIZE;
  const step = 2 ** ref.level;
  const x0 = ref.tx * size * step + step / 2;
  const y0 = ref.ty * size * step + step / 2;
  const out = new Surface(size, size);
  const layer = new Surface(size, size);
  for (const active of activeLayers(doc)) {
    if (!sampleLayer(active.store, layer, x0, y0, step)) continue;
    if (active.live !== undefined) applyLiveFilter(layer, active.live, x0, y0, step);
    compositeRgba8(bytesOf(out), bytesOf(layer), active.mode, active.opacity);
  }
  const pixels = bytesOf(out);
  premultiplyRgba8(pixels);
  padTile(
    pixels,
    size,
    coveredExtent(doc.width, ref.level) - ref.tx * size,
    coveredExtent(doc.height, ref.level) - ref.ty * size,
  );
  return { level: ref.level, tx: ref.tx, ty: ref.ty, pixels };
}

/**
 * Fills `out` with the store's pixels at (`x0 + i × step`, `y0 + j × step`), transparent outside
 * the store. Returns false, leaving `out` unspecified, when every sample is transparent.
 */
function sampleLayer(
  store: TiledPixelStore,
  out: Surface,
  x0: number,
  y0: number,
  step: number,
): boolean {
  const target = new Uint32Array(out.data.buffer, out.data.byteOffset, out.width * out.height);
  target.fill(0);
  let any = false;
  for (let j = 0; j < out.height; j++) {
    const y = y0 + j * step;
    if (y >= store.height) break;
    const ty = Math.floor(y / TILE_SIZE);
    const row = (y - ty * TILE_SIZE) * TILE_SIZE;
    let tx = -1;
    let words: Uint32Array | undefined;
    for (let i = 0; i < out.width; i++) {
      const x = x0 + i * step;
      if (x >= store.width) break;
      const column = Math.floor(x / TILE_SIZE);
      if (column !== tx) {
        tx = column;
        const tile = store.getTile(tx, ty);
        words =
          tile === undefined
            ? undefined
            : new Uint32Array(tile.data.buffer, tile.data.byteOffset, TILE_SIZE * TILE_SIZE);
      }
      if (words === undefined) continue;
      target[j * out.width + i] = words[row + x - tx * TILE_SIZE] ?? 0;
      any = true;
    }
  }
  return any;
}

function bytesOf(surface: Surface): Uint8Array {
  return new Uint8Array(surface.data.buffer, surface.data.byteOffset, surface.data.byteLength);
}

/**
 * The image pixels at `level` along an axis of `extent` document pixels that the image covers
 * completely. A last, partly covered pixel is left out, since it is partly transparent.
 */
export function coveredExtent(extent: number, level: number): number {
  return Math.max(1, Math.floor(extent / 2 ** level));
}

/**
 * Fills the pixels of a square tile (`size` across) beyond the image with copies of its last
 * column and row (`width` and `height` are the covered pixels from the tile's corner). The frame
 * never draws those pixels, but filtering at the image's edge samples them: copies keep the edge
 * opaque, where transparency would let a line of checkerboard show through (UI-VIEW-02).
 */
export function padTile(pixels: Uint8Array, size: number, width: number, height: number): void {
  const w = Math.min(size, Math.floor(width));
  const h = Math.min(size, Math.floor(height));
  if (w <= 0 || h <= 0 || (w === size && h === size)) return;
  const stride = size * 4;
  if (w < size) {
    for (let y = 0; y < h; y++) {
      const last = y * stride + (w - 1) * 4;
      for (let x = w; x < size; x++) pixels.copyWithin(y * stride + x * 4, last, last + 4);
    }
  }
  const lastRow = (h - 1) * stride;
  for (let y = h; y < size; y++) pixels.copyWithin(y * stride, lastRow, lastRow + stride);
}

function downsample(
  cache: DisplayTileCache,
  doc: CompositeDocument,
  ref: TileRef,
  final: boolean,
): DisplayTile {
  const size = DISPLAY_TILE_SIZE;
  const block = new Uint8Array(size * 2 * size * 2 * 4);
  for (const child of childrenOf(doc, ref)) {
    const tile = cache.get(child.level, child.tx, child.ty);
    if (!tile) continue;
    const originX = (child.tx - ref.tx * 2) * size;
    const originY = (child.ty - ref.ty * 2) * size;
    for (let y = 0; y < size; y++) {
      const from = y * size * 4;
      const to = ((originY + y) * size * 2 + originX) * 4;
      block.set(tile.pixels.subarray(from, from + size * 4), to);
    }
  }
  // The block and the result are padded past the image's covered pixels, so neither filter mixes
  // transparency into the image's edge.
  const child = ref.level - 1;
  padTile(
    block,
    size * 2,
    coveredExtent(doc.width, child) - ref.tx * size * 2,
    coveredExtent(doc.height, child) - ref.ty * size * 2,
  );
  const pixels = final
    ? resampleLanczos3Rgba8(block, size * 2, size * 2, size, size)
    : boxHalve(block, size * 2);
  padTile(
    pixels,
    size,
    coveredExtent(doc.width, ref.level) - ref.tx * size,
    coveredExtent(doc.height, ref.level) - ref.ty * size,
  );
  return { level: ref.level, tx: ref.tx, ty: ref.ty, pixels };
}

/**
 * Halves a square premultiplied RGBA8 block of `edge` pixels by averaging each 2x2 group, rounded
 * to nearest. Color stays at or below alpha, since each average is no larger than its alpha's.
 * It runs in WASM: the same loop in JS took about twice as long in Firefox as in Chromium.
 */
export function boxHalve(block: Uint8Array, edge: number): Uint8Array {
  return boxHalveRgba8(block, edge);
}
