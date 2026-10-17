import {
  type ColorRgba8,
  type LayerLivePreview,
  type Rect,
  rect,
  Surface,
  TILE_BYTES,
  TILE_SIZE,
  type TileCoord,
  TiledPixelStore,
} from "@openpaint/document";
import {
  type CompositeDocument,
  type CompositeLayer,
  EMPTY_DOCUMENT,
  type LiveFilter,
} from "./composite";
import { transfer } from "./rpc";

/** A layer as the main thread describes it: the document's layer, structurally. */
export interface MirroredLayer {
  readonly id: number;
  readonly visible: boolean;
  readonly opacity: number;
  readonly blendMode: number;
  readonly pixels: TiledPixelStore;
  /** The per-pixel adjustment shown over the layer while a dialog previews it. */
  readonly livePreview?: LayerLivePreview | undefined;
}

/** The document as the main thread describes it: its size and layer stack, bottom to top. */
export interface MirroredDocument {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly MirroredLayer[];
}

export interface SyncLayer {
  readonly id: number;
  readonly visible: boolean;
  readonly opacity: number;
  readonly mode: number;
  /** The live filter shown over the layer (`LayerLivePreview`), or absent for none. */
  readonly live?: SyncLive;
}

/**
 * A layer's live filter as it crosses to the worker. The coverage is sent once: later syncs of the
 * same coverage carry only its key.
 */
export interface SyncLive {
  readonly effectId: string;
  readonly params: unknown;
  readonly region: Rect;
  /** Names the coverage: 0 for none, otherwise a number the mirror gave this coverage. */
  readonly coverageKey: number;
  /** The coverage bytes over `region`, in the first sync with this key only. */
  readonly coverage?: Uint8Array;
}

export interface SyncTile {
  readonly tx: number;
  readonly ty: number;
  /**
   * The tile as RGBA8, or undefined when the tile is transparent: the whole 256 px tile, or only
   * `rect` when that is given.
   */
  readonly pixels: Uint8Array | undefined;
  /**
   * The part of the tile that changed, in tile pixels, when only that part is sent (L9). The
   * receiver already holds the rest of the tile.
   */
  readonly rect?: Rect;
  /**
   * Set instead of `pixels` for a whole tile of one color (L9): the color's four RGBA bytes read as
   * one little-endian `Uint32` (`tileFill` gives the bytes back).
   */
  readonly fill?: number;
}

/** The RGBA bytes of a uniform tile's `fill`. */
export function tileFill(fill: number): ColorRgba8 {
  return { r: fill & 0xff, g: (fill >>> 8) & 0xff, b: (fill >>> 16) & 0xff, a: fill >>> 24 };
}

/** A whole tile's `pixels` filled with `fill`. */
export function tileFillBytes(fill: number): Uint8Array {
  const { r, g, b, a } = tileFill(fill);
  const word = new Uint32Array(new Uint8Array([r, g, b, a]).buffer)[0] ?? 0;
  const bytes = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  new Uint32Array(bytes.buffer).fill(word);
  return bytes;
}

/** A tile color as a `fill`. */
function packFill({ r, g, b, a }: ColorRgba8): number {
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
}

export interface SyncLayerTiles {
  readonly id: number;
  readonly tiles: readonly SyncTile[];
}

/**
 * One change to the document, as the engine worker needs it. A `full` sync replaces the worker's
 * stores with the allocated tiles listed. Otherwise only the listed tiles changed.
 */
export interface DocumentSync {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly SyncLayer[];
  readonly full: boolean;
  readonly tiles: readonly SyncLayerTiles[];
  /**
   * Layers whose store was replaced or that are new. The worker empties them, and the sync lists
   * all their allocated tiles.
   */
  readonly reset?: readonly number[];
}

/**
 * Main-thread side of the document binding. It describes the document to the engine on every
 * change. Only the first sync, a new image size and `invalidate` are full. A change to the layer
 * stack or to layer properties sends the stack alone, and a replaced or new store sends only that
 * layer's tiles (`DocumentSync.reset`); the worker matches layers by id. Anything else sends only
 * the changed part of each dirty tile (L9). Tile bytes are copies whose buffers move to the worker.
 */
export class DocumentMirror {
  #size: string | undefined;
  #stores = new Map<number, TiledPixelStore>();
  /** Dirty tiles the engine already has, per store, which the next sync leaves out. */
  readonly #acknowledged = new Map<TiledPixelStore, Set<string>>();
  /** Whole tiles of a full or reset sync not sent yet, by layer id. */
  readonly #pending = new Map<number, TileCoord[]>();
  /** The key of each live filter coverage, and the key the worker holds per layer id. */
  readonly #coverageKeys = new WeakMap<Uint8Array, number>();
  readonly #sentCoverage = new Map<number, number>();
  #nextCoverageKey = 0;

  /** Makes the next description a full sync, e.g. after the engine lost its GPU document. */
  invalidate(): void {
    this.#size = undefined;
  }

  /**
   * Leaves `tiles` of `store` out of the next sync once: the engine produced them itself, such as
   * the tiles of a stroke it painted and read back (engine v2).
   */
  acknowledge(store: TiledPixelStore, tiles: readonly { tx: number; ty: number }[]): void {
    const keys = this.#acknowledged.get(store) ?? new Set<string>();
    for (const { tx, ty } of tiles) keys.add(`${tx},${ty}`);
    this.#acknowledged.set(store, keys);
  }

  /** Whether whole tiles of a full or reset sync are still to be sent (`describe`'s budget). */
  get pending(): boolean {
    return this.#pending.size > 0;
  }

  /**
   * The next sync. A full or reset sync lists every allocated tile of its layers; with a byte
   * budget, only that many bytes of them go in one sync, and the rest wait for the next calls
   * (`pending`), so opening a large image does not copy every tile in one task (L9, L10).
   */
  describe(
    doc: MirroredDocument | undefined,
    budgetBytes: number = Number.POSITIVE_INFINITY,
  ): DocumentSync {
    const width = doc?.width ?? 0;
    const height = doc?.height ?? 0;
    const layers = doc?.layers ?? [];
    const size = `${width}x${height}`;
    const full = size !== this.#size;
    if (full) this.#sentCoverage.clear();
    const buffers: ArrayBuffer[] = [];
    const stack: SyncLayer[] = layers.map(({ id, visible, opacity, blendMode, livePreview }) => {
      const layer = { id, visible, opacity, mode: blendMode };
      if (livePreview === undefined) {
        this.#sentCoverage.delete(id);
        return layer;
      }
      return { ...layer, live: this.#live(id, livePreview, buffers) };
    });
    const reset = full
      ? []
      : layers.filter((layer) => this.#stores.get(layer.id) !== layer.pixels).map(({ id }) => id);
    this.#size = size;
    this.#stores = new Map(layers.map((layer) => [layer.id, layer.pixels]));
    if (full) this.#pending.clear();
    for (const id of this.#pending.keys()) {
      if (!this.#stores.has(id)) this.#pending.delete(id);
    }
    for (const layer of layers) {
      if (!full && !reset.includes(layer.id)) continue;
      this.#pending.set(layer.id, layer.pixels.allocatedTiles());
      layer.pixels.clearDirty();
    }

    let spent = 0;
    const tiles = layers.map((layer) => {
      const store = layer.pixels;
      const acknowledged = this.#acknowledged.get(store);
      const regions: DirtyTile[] = store
        .takeDirtyRegions()
        .filter(({ tx, ty }) => !acknowledged?.has(`${tx},${ty}`));
      const waiting = this.#pending.get(layer.id);
      while (waiting !== undefined && waiting.length > 0 && spent < budgetBytes) {
        const next = waiting.shift();
        if (next === undefined) break;
        regions.push(next);
        // A uniform tile costs nearly nothing to send; count it as such.
        if (store.uniformColor(next.tx, next.ty) === undefined) spent += TILE_BYTES;
      }
      if (waiting?.length === 0) this.#pending.delete(layer.id);
      return {
        id: layer.id,
        tiles: regions.map((region) => {
          const tile = tileSync(store, region);
          if (tile.pixels) buffers.push(tile.pixels.buffer as ArrayBuffer);
          return tile;
        }),
      };
    });
    this.#acknowledged.clear();
    const sync: DocumentSync = { width, height, layers: stack, full, tiles };
    return transfer(reset.length > 0 ? { ...sync, reset } : sync, buffers);
  }

  /**
   * The sync of a layer's live filter. Its coverage goes as a copy the first time the layer shows
   * it, and as its key alone after that (L9), so a dialog's preview sends only its parameters.
   */
  #live(id: number, preview: LayerLivePreview, buffers: ArrayBuffer[]): SyncLive {
    const { effectId, params, region, coverage } = preview;
    if (coverage === undefined) {
      this.#sentCoverage.delete(id);
      return { effectId, params, region, coverageKey: 0 };
    }
    let coverageKey = this.#coverageKeys.get(coverage);
    if (coverageKey === undefined) {
      this.#nextCoverageKey += 1;
      coverageKey = this.#nextCoverageKey;
      this.#coverageKeys.set(coverage, coverageKey);
    }
    if (this.#sentCoverage.get(id) === coverageKey) {
      return { effectId, params, region, coverageKey };
    }
    this.#sentCoverage.set(id, coverageKey);
    const bytes = coverage.slice();
    buffers.push(bytes.buffer);
    return { effectId, params, region, coverageKey, coverage: bytes };
  }
}

/** A tile to send, with the store rectangle that changed in it when only that part is sent. */
interface DirtyTile extends TileCoord {
  readonly area?: Rect;
}

/**
 * The sync entry of one tile: a copy of its bytes that the worker can own. A tile changed only in
 * part sends that part alone (L9), so a small brush dab does not copy 256 KB. The copy is a
 * `slice`: `new Uint8Array(clamped)` would convert the bytes one at a time, which is far slower.
 */
function tileSync(store: TiledPixelStore, { tx, ty, area }: DirtyTile): SyncTile {
  const tile = store.getTile(tx, ty);
  if (tile === undefined) return { tx, ty, pixels: undefined };
  const part =
    area === undefined
      ? undefined
      : rect(area.x - tx * TILE_SIZE, area.y - ty * TILE_SIZE, area.width, area.height);
  if (part === undefined || (part.width === TILE_SIZE && part.height === TILE_SIZE)) {
    // A tile of one color, such as a filled layer, goes as its color (L9).
    const color = store.uniformColor(tx, ty);
    if (color !== undefined) return { tx, ty, pixels: undefined, fill: packFill(color) };
    return { tx, ty, pixels: new Uint8Array(tile.data.slice().buffer) };
  }
  const pixels = new Uint8Array(part.width * part.height * 4);
  const row = part.width * 4;
  for (let y = 0; y < part.height; y++) {
    const from = ((part.y + y) * TILE_SIZE + part.x) * 4;
    pixels.set(tile.data.subarray(from, from + row), y * row);
  }
  return { tx, ty, pixels, rect: part };
}

/** What applying a sync did to the replica's document. */
export interface ReplicaChange {
  readonly document: CompositeDocument;
  /** The document was replaced: a full sync or a new size. */
  readonly full: boolean;
  /** The layer stack changed (layers, order, properties or replaced stores), not only pixels. */
  readonly restacked: boolean;
}

/**
 * Worker side of the document binding. It keeps the stores the main thread's tiles are written
 * into, by layer id, and the composite document the engine draws. The composite is rebuilt only
 * when the stack changes, so the engine's cached display tiles stay valid across pixel deltas.
 */
export class DocumentReplica {
  #stores = new Map<number, TiledPixelStore>();
  #document: CompositeDocument = EMPTY_DOCUMENT;
  readonly #filters = new LiveFilterReplica();

  /** Applies one sync and returns the document to draw, and what changed. */
  apply(sync: DocumentSync): ReplicaChange {
    const full =
      sync.full || sync.width !== this.#document.width || sync.height !== this.#document.height;
    if (full) {
      for (const store of this.#stores.values()) store.dispose();
      this.#stores = new Map();
    }
    const ids = new Set(sync.layers.map((layer) => layer.id));
    for (const [id, store] of this.#stores) {
      if (!ids.has(id) || sync.reset?.includes(id) === true) {
        store.dispose();
        this.#stores.delete(id);
      }
    }
    for (const { id } of sync.layers) {
      if (!this.#stores.has(id)) this.#stores.set(id, new TiledPixelStore(sync.width, sync.height));
    }
    const filters = this.#filters.apply(sync.layers);
    const layers: CompositeLayer[] = sync.layers.map((layer) => {
      const live = filters.get(layer.id);
      return {
        store: this.#store(layer.id),
        mode: layer.mode,
        opacity: layer.opacity,
        visible: layer.visible,
        ...(live && { live }),
      };
    });
    const restacked = full || !sameLayers(this.#document.layers, layers);
    if (restacked) this.#document = { width: sync.width, height: sync.height, layers };
    for (const { id, tiles } of sync.tiles) {
      const store = this.#store(id);
      for (const { tx, ty, pixels, rect: part, fill } of tiles) {
        if (fill !== undefined) {
          store.fill(tileFill(fill), store.tileBounds(tx, ty));
        } else if (pixels) {
          const bytes = new Uint8ClampedArray(pixels.buffer as ArrayBuffer);
          const area = part ?? rect(0, 0, TILE_SIZE, TILE_SIZE);
          store.writeRegion(
            new Surface(area.width, area.height, bytes),
            tx * TILE_SIZE + area.x,
            ty * TILE_SIZE + area.y,
          );
        } else {
          store.clear(store.tileBounds(tx, ty));
        }
      }
    }
    return { document: this.#document, full, restacked };
  }

  #store(id: number): TiledPixelStore {
    const store = this.#stores.get(id);
    if (!store) throw new Error(`Layer ${id} is not part of the engine's document.`);
    return store;
  }
}

/**
 * The worker's live filters, by layer id (FX-FW-PREVIEW-01). A coverage comes with the first sync
 * of its key and is kept for the later ones, and a filter sent again unchanged keeps its object, so
 * the stack compares equal.
 */
export class LiveFilterReplica {
  readonly #coverages = new Map<number, { readonly key: number; readonly bytes: Uint8Array }>();
  #filters = new Map<number, LiveFilter>();

  /** The live filters of a synced stack, by layer id. Layers without one are left out. */
  apply(layers: readonly SyncLayer[]): ReadonlyMap<number, LiveFilter> {
    const next = new Map<number, LiveFilter>();
    for (const { id, live } of layers) {
      if (live === undefined) continue;
      if (live.coverage !== undefined) {
        this.#coverages.set(id, { key: live.coverageKey, bytes: live.coverage });
      }
      const held = this.#coverages.get(id);
      const coverage = held !== undefined && held.key === live.coverageKey ? held.bytes : undefined;
      const key = JSON.stringify([live.effectId, live.params, live.region, live.coverageKey]);
      const previous = this.#filters.get(id);
      next.set(
        id,
        previous?.key === key
          ? previous
          : { effectId: live.effectId, params: live.params, region: live.region, coverage, key },
      );
    }
    for (const id of this.#coverages.keys()) {
      if (!next.has(id)) this.#coverages.delete(id);
    }
    this.#filters = next;
    return next;
  }
}

function sameLayers(a: CompositeDocument["layers"], b: CompositeDocument["layers"]): boolean {
  return (
    a.length === b.length &&
    a.every((layer, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        layer.store === other.store &&
        layer.mode === other.mode &&
        layer.opacity === other.opacity &&
        layer.visible === other.visible &&
        layer.live === other.live
      );
    })
  );
}
