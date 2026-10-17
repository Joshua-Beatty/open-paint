import { TILE_SIZE } from "@openpaint/document";
import { NO_TILE, slotPage } from "./tile-allocator";

/** A layer's place in the stack and how it blends (DOC-BLD-02). */
export interface StackLayer {
  readonly id: number;
  readonly visible: boolean;
  readonly opacity: number;
  readonly mode: number;
}

interface LayerTiles {
  info: StackLayer;
  /** Committed tiles: tile key to slot code. */
  readonly tiles: Map<number, number>;
  /** Tiles shown instead of the committed ones, such as a stroke's preview. */
  readonly overrides: Map<number, number>;
  /** How many of the layer's committed and override tiles live in each page. */
  readonly pages: Map<number, number>;
}

/** What the compositor uploads: the tile grid of every active layer, and the layers' blending. */
export interface BuiltTable {
  /** Slot codes, `tilesX * tilesY` per active layer, bottom to top, `NO_TILE` where empty. */
  readonly table: Uint32Array;
  /**
   * Four words per active layer: table offset, blend mode, opacity, and 1 when the compositor
   * draws the layer through the live filter.
   */
  readonly layers: Uint32Array;
  /** The pages each active layer's tiles use, bottom to top. */
  readonly pages: readonly ReadonlySet<number>[];
}

/**
 * The GPU document's layer stack and the slot of every allocated tile.
 * It is plain bookkeeping: the GPU work happens in `GpuDocument`. Each change reports the tiles
 * it touched, so the compositor re-blends only those.
 */
export class TileTable {
  readonly tilesX: number;
  readonly tilesY: number;
  #layers: LayerTiles[] = [];
  readonly #byId = new Map<number, LayerTiles>();
  #built: BuiltTable | undefined;
  /** The layer the compositor shows through the live filter, if any. */
  #liveLayer: number | undefined;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.tilesX = Math.ceil(width / TILE_SIZE);
    this.tilesY = Math.ceil(height / TILE_SIZE);
  }

  get layerCount(): number {
    return this.#layers.length;
  }

  key(tx: number, ty: number): number {
    return ty * this.tilesX + tx;
  }

  coord(key: number): { tx: number; ty: number } {
    return { tx: key % this.tilesX, ty: Math.floor(key / this.tilesX) };
  }

  has(id: number): boolean {
    return this.#byId.has(id);
  }

  /**
   * Replaces the stack. Layers keep their tiles by id. Returns the slot codes of the layers that
   * left the stack, for the caller to free, and whether anything about the stack changed.
   */
  setStack(stack: readonly StackLayer[]): { freed: number[]; changed: boolean } {
    const before = JSON.stringify(this.#layers.map((layer) => layer.info));
    const next = stack.map((info) => {
      const existing = this.#byId.get(info.id);
      if (existing) {
        existing.info = { ...info };
        return existing;
      }
      return { info: { ...info }, tiles: new Map(), overrides: new Map(), pages: new Map() };
    });
    const keep = new Set(stack.map((layer) => layer.id));
    const freed: number[] = [];
    for (const [id, layer] of this.#byId) {
      if (keep.has(id)) continue;
      freed.push(...layer.tiles.values(), ...layer.overrides.values());
      this.#byId.delete(id);
    }
    for (const layer of next) this.#byId.set(layer.info.id, layer);
    this.#layers = next;
    const changed = before !== JSON.stringify(next.map((layer) => layer.info));
    if (changed || freed.length > 0) this.#built = undefined;
    return { freed, changed };
  }

  /** Marks the layer the compositor draws through the live filter (undefined for none). */
  setLiveLayer(id: number | undefined): void {
    if (id === this.#liveLayer) return;
    this.#liveLayer = id;
    this.#built = undefined;
  }

  /** The committed slot of a tile, or undefined when it is transparent. */
  tile(id: number, tx: number, ty: number): number | undefined {
    return this.#layer(id).tiles.get(this.key(tx, ty));
  }

  /** Every committed tile of a layer, as tile keys and slot codes. */
  tiles(id: number): ReadonlyMap<number, number> {
    return this.#layer(id).tiles;
  }

  /** Sets or clears (undefined) a committed tile. Returns the slot it replaced. */
  setTile(id: number, tx: number, ty: number, code: number | undefined): number | undefined {
    const layer = this.#layer(id);
    const key = this.key(tx, ty);
    const previous = layer.tiles.get(key);
    if (previous === code) return undefined;
    if (previous !== undefined) countPage(layer.pages, previous, -1);
    if (code === undefined) layer.tiles.delete(key);
    else {
      layer.tiles.set(key, code);
      countPage(layer.pages, code, 1);
    }
    this.#built = undefined;
    return previous;
  }

  /** Shows `code` instead of the committed tile until the override is cleared. */
  setOverride(id: number, tx: number, ty: number, code: number): void {
    const layer = this.#layer(id);
    const key = this.key(tx, ty);
    const previous = layer.overrides.get(key);
    if (previous === code) return;
    if (previous !== undefined) countPage(layer.pages, previous, -1);
    layer.overrides.set(key, code);
    countPage(layer.pages, code, 1);
    this.#built = undefined;
  }

  /** Drops every override of a layer and returns them as tile keys and slot codes. */
  clearOverrides(id: number): Map<number, number> {
    const layer = this.#byId.get(id);
    if (layer === undefined) return new Map();
    const overrides = new Map(layer.overrides);
    for (const code of overrides.values()) countPage(layer.pages, code, -1);
    layer.overrides.clear();
    if (overrides.size > 0) this.#built = undefined;
    return overrides;
  }

  /** Every slot code in use, committed and overriding, for a reset. */
  allCodes(): number[] {
    return this.#layers.flatMap((layer) => [...layer.tiles.values(), ...layer.overrides.values()]);
  }

  /** The table the compositor reads. Rebuilt only after a change. */
  build(): BuiltTable {
    if (this.#built) return this.#built;
    const active = this.#layers.filter((layer) => layer.info.visible && layer.info.opacity > 0);
    const cells = this.tilesX * this.tilesY;
    const table = new Uint32Array(Math.max(1, active.length * cells)).fill(NO_TILE);
    const layers = new Uint32Array(Math.max(4, active.length * 4));
    active.forEach((layer, index) => {
      const base = index * cells;
      for (const [key, code] of layer.tiles) table[base + key] = code;
      for (const [key, code] of layer.overrides) table[base + key] = code;
      const live = layer.info.id === this.#liveLayer ? 1 : 0;
      layers.set([base, layer.info.mode, layer.info.opacity, live], index * 4);
    });
    this.#built = {
      table,
      layers,
      pages: active.map((layer) => new Set(layer.pages.keys())),
    };
    return this.#built;
  }

  #layer(id: number): LayerTiles {
    const layer = this.#byId.get(id);
    if (!layer) throw new Error(`Layer ${id} is not part of the engine's document.`);
    return layer;
  }
}

function countPage(pages: Map<number, number>, code: number, delta: number): void {
  const page = slotPage(code);
  const count = (pages.get(page) ?? 0) + delta;
  if (count > 0) pages.set(page, count);
  else pages.delete(page);
}
