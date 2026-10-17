import { type Rect, TILE_SIZE } from "@openpaint/document";
import type { CompositeDocument, LiveFilter } from "../composite";
import {
  type DocumentSync,
  type FloatLayer,
  FloatReplica,
  LiveFilterReplica,
  type SyncTile,
  tileFillBytes,
} from "../document-sync";
import { slotPage } from "./tile-allocator";
import { GpuTilePool, TILE_BYTES } from "./tile-pool";
import { TileTable } from "./tile-table";

/** What the compositor must re-blend after a change to the document. */
export interface DocumentChanges {
  /** A layer tile at (`tx`, `ty`) changed in some layer. */
  tileChanged(tx: number, ty: number): void;
  /** The stack changed: layers, their order, visibility, opacity or blend mode. */
  stackChanged(): void;
}

/**
 * The document on the GPU: every layer's allocated tiles as slots of the
 * tile pool, and the layer stack. It is filled from the main thread's `syncDocument` deltas and
 * full syncs, uploading only the tiles listed. The worker keeps no CPU copy of the pixels.
 */
export class GpuDocument {
  readonly pool: GpuTilePool;
  #table = new TileTable(0, 0);
  /** The page each layer last allocated in, so a layer's tiles share few pages. */
  readonly #pageOf = new Map<number, number>();
  readonly #filters = new LiveFilterReplica();
  /** The live filter the compositor applies, and its layer. One layer at a time has one. */
  #live: { readonly layerId: number; readonly filter: LiveFilter } | undefined;
  readonly #floats = new FloatReplica();
  #float: FloatLayer | undefined;

  /** `pageSlices` caps the tile pool's page size (tests use tiny pages). */
  constructor(
    device: GPUDevice,
    readonly changes: DocumentChanges,
    pageSlices?: number,
  ) {
    this.pool = new GpuTilePool(device, pageSlices);
  }

  get width(): number {
    return this.#table.width;
  }

  get height(): number {
    return this.#table.height;
  }

  get table(): TileTable {
    return this.#table;
  }

  /** The live filter shown over a layer (FX-FW-PREVIEW-01), or undefined. */
  get live(): LiveFilter | undefined {
    return this.#live?.filter;
  }

  /**
   * Applies one sync from the main thread. A full sync, or one that changes the image size,
   * replaces everything. Otherwise the stack is updated by layer id, the layers listed in `reset`
   * are emptied first, and only the listed tiles are uploaded.
   */
  apply(sync: DocumentSync): void {
    if (sync.full || sync.width !== this.width || sync.height !== this.height) {
      this.clear(sync.width, sync.height);
    }
    const { freed, changed } = this.#table.setStack(
      sync.layers.map(({ id, visible, opacity, mode }) => ({ id, visible, opacity, mode })),
    );
    for (const code of freed) this.pool.free(code);
    const live = [...this.#filters.apply(sync.layers)][0];
    const filterChanged = live?.[1] !== this.#live?.filter || live?.[0] !== this.#live?.layerId;
    if (filterChanged) {
      this.#live = live && { layerId: live[0], filter: live[1] };
      this.#table.setLiveLayer(live?.[0]);
    }
    if (changed || freed.length > 0 || filterChanged) this.changes.stackChanged();
    const float = this.#floats.apply(sync.layers);
    if (float !== this.#float) {
      // Each placement re-blends the tiles under the float's region, where it was and is now.
      for (const shown of [this.#float, float]) {
        if (shown !== undefined) this.#tilesChanged(shown.base.region);
      }
      this.#float = float;
      this.#table.setFloatLayer(float?.layerId);
    }
    for (const id of sync.reset ?? []) this.#emptyLayer(id);
    for (const { id, tiles } of sync.tiles) {
      for (const tile of tiles) this.writeTile(id, tile);
    }
  }

  /** The floating content shown over a layer (TL-MOVE-PIX-01), or undefined. */
  get float(): FloatLayer | undefined {
    return this.#float;
  }

  #tilesChanged(region: Rect): void {
    const table = this.#table;
    const tx1 = Math.min(table.tilesX, Math.ceil((region.x + region.width) / TILE_SIZE));
    const ty1 = Math.min(table.tilesY, Math.ceil((region.y + region.height) / TILE_SIZE));
    for (let ty = Math.max(0, Math.floor(region.y / TILE_SIZE)); ty < ty1; ty++) {
      for (let tx = Math.max(0, Math.floor(region.x / TILE_SIZE)); tx < tx1; tx++) {
        this.changes.tileChanged(tx, ty);
      }
    }
  }

  /** Shows a CPU composite document, as the test pattern does (M0.09). */
  load(doc: CompositeDocument): void {
    this.clear(doc.width, doc.height);
    const layers = doc.layers.map((layer, index) => ({
      id: index + 1,
      visible: layer.visible,
      opacity: layer.opacity,
      mode: layer.mode,
    }));
    this.#table.setStack(layers);
    doc.layers.forEach((layer, index) => {
      for (const { tx, ty } of layer.store.allocatedTiles()) {
        const tile = layer.store.getTile(tx, ty);
        const pixels =
          tile && new Uint8Array(tile.data.buffer, tile.data.byteOffset, tile.data.length);
        this.writeTile(index + 1, { tx, ty, pixels });
      }
    });
    this.changes.stackChanged();
  }

  /**
   * Uploads one tile of a layer, whole or only its `rect`, or frees it when `pixels` is undefined
   * (transparent). A part of a tile the GPU does not hold yet lands on a transparent tile.
   */
  writeTile(id: number, tile: SyncTile): void {
    const { tx, ty, rect } = tile;
    const pixels = tile.fill === undefined ? tile.pixels : tileFillBytes(tile.fill);
    const table = this.#table;
    if (tx < 0 || ty < 0 || tx >= table.tilesX || ty >= table.tilesY) return;
    const existing = table.tile(id, tx, ty);
    if (pixels) {
      const code = existing ?? this.allocateFor(id);
      if (rect === undefined) {
        this.pool.write(code, pixels);
      } else {
        if (existing === undefined) this.pool.write(code, new Uint8Array(TILE_BYTES));
        this.pool.writeRect(code, pixels, rect);
      }
      table.setTile(id, tx, ty, code);
    } else if (existing !== undefined) {
      table.setTile(id, tx, ty, undefined);
      this.pool.free(existing);
    } else {
      return;
    }
    this.changes.tileChanged(tx, ty);
  }

  /** A slot for a new tile of layer `id`, near the layer's other tiles. */
  allocateFor(id: number): number {
    const code = this.pool.allocate(this.#pageOf.get(id));
    this.#pageOf.set(id, slotPage(code));
    return code;
  }

  /** Drops every tile and layer, and starts an empty `width` × `height` document. */
  clear(width: number, height: number): void {
    this.pool.reset();
    this.#pageOf.clear();
    this.#live = undefined;
    this.#float = undefined;
    this.#floats.clear();
    this.#table = new TileTable(width, height);
    this.changes.stackChanged();
  }

  destroy(): void {
    this.pool.destroy();
  }

  #emptyLayer(id: number): void {
    const tiles = [...this.#table.tiles(id).keys()];
    for (const key of tiles) {
      const { tx, ty } = this.#table.coord(key);
      this.writeTile(id, { tx, ty, pixels: undefined });
    }
  }
}
