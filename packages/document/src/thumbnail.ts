import type { Document } from "./document";
import { type Rect, rect } from "./geometry";
import type { Layer } from "./layer";
import { drawOverlay, type LayerOverlay, overlayByTile } from "./layer-overlay";
import { type CompositeSource, flattenRegion } from "./layer-pixels";
import { Surface } from "./surface";
import { TILE_SIZE, type TiledPixelStore } from "./tiled-store";

/** The most source pixels flattened at once, which bounds the working memory of a thumbnail. */
const BAND_PIXELS = 1 << 20;
/** The source pixels a thumbnail slice flattens between two turns of the event loop (PRD-NF-02). */
const SLICE_PIXELS = 1 << 18;

/** The size that fits `maxSize` on the longer side. Thumbnails never upscale. */
export function thumbnailSize(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  if (!Number.isInteger(maxSize) || maxSize < 1) {
    throw new RangeError(`Invalid thumbnail size ${maxSize}.`);
  }
  const scale = Math.min(1, maxSize / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Box-averages a source image into a thumbnail. The source arrives as horizontal bands, top to
 * bottom, so the whole image never has to be in memory at once. Colors are averaged premultiplied
 * and then straightened, so transparent pixels do not darken their neighbours.
 */
export class ThumbnailAccumulator {
  readonly #width: number;
  readonly #height: number;
  readonly #thumbWidth: number;
  readonly #thumbHeight: number;
  readonly #column: Uint32Array;
  readonly #colorSums: Float64Array;
  readonly #alphaSums: Float64Array;
  readonly #counts: Uint32Array;
  #nextRow = 0;

  constructor(width: number, height: number, maxSize: number) {
    const size = thumbnailSize(width, height, maxSize);
    this.#width = width;
    this.#height = height;
    this.#thumbWidth = size.width;
    this.#thumbHeight = size.height;
    const bins = size.width * size.height;
    this.#column = Uint32Array.from({ length: width }, (_, x) =>
      Math.floor((x * size.width) / width),
    );
    this.#colorSums = new Float64Array(bins * 3);
    this.#alphaSums = new Float64Array(bins);
    this.#counts = new Uint32Array(bins);
  }

  /** Adds the rows `top` to `top + band.height - 1`. Bands must follow each other without gaps. */
  addBand(band: Surface, top: number): void {
    if (top !== this.#nextRow || band.width !== this.#width || band.height < 1) {
      throw new RangeError("Thumbnail bands must cover the image from top to bottom.");
    }
    const data = band.data;
    for (let row = 0; row < band.height; row++) {
      const binRow =
        Math.floor(((top + row) * this.#thumbHeight) / this.#height) * this.#thumbWidth;
      for (let x = 0; x < this.#width; x++) {
        const i = (row * this.#width + x) * 4;
        const alpha = data[i + 3] ?? 0;
        const bin = binRow + (this.#column[x] ?? 0);
        this.#colorSums[bin * 3] = (this.#colorSums[bin * 3] ?? 0) + (data[i] ?? 0) * alpha;
        this.#colorSums[bin * 3 + 1] =
          (this.#colorSums[bin * 3 + 1] ?? 0) + (data[i + 1] ?? 0) * alpha;
        this.#colorSums[bin * 3 + 2] =
          (this.#colorSums[bin * 3 + 2] ?? 0) + (data[i + 2] ?? 0) * alpha;
        this.#alphaSums[bin] = (this.#alphaSums[bin] ?? 0) + alpha;
        this.#counts[bin] = (this.#counts[bin] ?? 0) + 1;
      }
    }
    this.#nextRow = top + band.height;
  }

  /** The finished thumbnail. Every row must have been added. */
  finish(): Surface {
    if (this.#nextRow !== this.#height) {
      throw new RangeError("Thumbnail bands must cover every row.");
    }
    const bins = this.#thumbWidth * this.#thumbHeight;
    const out = new Uint8ClampedArray(bins * 4);
    for (let bin = 0; bin < bins; bin++) {
      const count = this.#counts[bin] ?? 0;
      if (count === 0) continue;
      const alphaSum = this.#alphaSums[bin] ?? 0;
      out[bin * 4 + 3] = Math.round(alphaSum / count);
      if (alphaSum > 0) {
        for (let c = 0; c < 3; c++) {
          out[bin * 4 + c] = Math.round((this.#colorSums[bin * 3 + c] ?? 0) / alphaSum);
        }
      }
    }
    return new Surface(this.#thumbWidth, this.#thumbHeight, out);
  }
}

function rowsPerBand(width: number): number {
  return Math.max(1, Math.floor(BAND_PIXELS / width));
}

/** Builds a thumbnail from bands of `band(area)`, read top to bottom so memory stays bounded. */
function bandedThumbnail(
  width: number,
  height: number,
  maxSize: number,
  band: (area: Rect) => Surface,
): Surface {
  const accumulator = new ThumbnailAccumulator(width, height, maxSize);
  const bandRows = rowsPerBand(width);
  for (let top = 0; top < height; top += bandRows) {
    const bandHeight = Math.min(bandRows, height - top);
    accumulator.addBand(band(rect(0, top, width, bandHeight)), top);
  }
  return accumulator.finish();
}

/**
 * A thumbnail of the document's visible layers composited over transparency (Document-level
 * flatten), at most `maxSize` pixels on the longer side. The document is left unchanged.
 */
export function documentThumbnail(doc: Document, maxSize: number): Surface {
  const visible = doc.layers.filter((layer) => layer.visible);
  return bandedThumbnail(doc.width, doc.height, maxSize, (area) => flattenRegion(visible, area));
}

/**
 * A thumbnail of one layer's own pixels (DOC-LYR-01), at most `maxSize` pixels on the longer side.
 * Its visibility, opacity and blend mode do not apply, so the thumbnail shows the pixels as stored.
 */
export function layerThumbnail(layer: Layer, maxSize: number): Surface {
  const { width, height } = layer.pixels;
  return bandedThumbnail(width, height, maxSize, (area) => layer.pixels.readRegion(area));
}

/** The part of the thumbnail sums that one store tile adds: its rectangle of bins and their sums. */
interface TileSums {
  /** What the sums were read from (tile versions), to tell whether the tile changed since. */
  readonly versions: readonly number[];
  readonly binX: number;
  readonly binY: number;
  readonly binsAcross: number;
  readonly colorSums: Float64Array;
  readonly alphaSums: Float64Array;
}

/**
 * A box-averaged thumbnail kept as per-tile partial sums (L8: work at thumbnail cost). Each
 * store tile adds its pixels' premultiplied sums to the bins it overlaps; a refresh re-reads only the
 * tiles whose content changed and adds up the small per-tile sums. The sums are whole numbers, so
 * the result is exactly `ThumbnailAccumulator`'s over the same pixels.
 */
export class TiledThumbnail {
  readonly #width: number;
  readonly #height: number;
  readonly #thumbWidth: number;
  readonly #thumbHeight: number;
  readonly #column: Uint32Array;
  readonly #row: Uint32Array;
  readonly #counts: Uint32Array;
  readonly #tiles = new Map<number, TileSums>();
  readonly #tilesX: number;
  readonly #tilesY: number;
  #result: Surface | undefined;

  constructor(width: number, height: number, maxSize: number) {
    const size = thumbnailSize(width, height, maxSize);
    this.#width = width;
    this.#height = height;
    this.#thumbWidth = size.width;
    this.#thumbHeight = size.height;
    this.#column = Uint32Array.from({ length: width }, (_, x) =>
      Math.floor((x * size.width) / width),
    );
    this.#row = Uint32Array.from({ length: height }, (_, y) =>
      Math.floor((y * size.height) / height),
    );
    // A bin holds (its columns) x (its rows) pixels, so the counts come from the two axes alone.
    const columns = new Uint32Array(size.width);
    for (const bin of this.#column) columns[bin] = (columns[bin] ?? 0) + 1;
    const rows = new Uint32Array(size.height);
    for (const bin of this.#row) rows[bin] = (rows[bin] ?? 0) + 1;
    this.#counts = new Uint32Array(size.width * size.height);
    for (let by = 0; by < size.height; by++) {
      for (let bx = 0; bx < size.width; bx++) {
        this.#counts[by * size.width + bx] = (columns[bx] ?? 0) * (rows[by] ?? 0);
      }
    }
    this.#tilesX = Math.ceil(width / TILE_SIZE);
    this.#tilesY = Math.ceil(height / TILE_SIZE);
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  /**
   * Brings every tile up to date. `versions(tx, ty)` identifies the tile's content: a tile whose
   * versions equal the stored ones is not read again. `read(area)` gives the tile's pixels over
   * `area`, or undefined when they are all transparent. `pause` runs before each batch of reads
   * (about `SLICE_PIXELS` pixels times `cost`), so a large change never holds the thread long.
   */
  async refresh(
    versions: (tx: number, ty: number) => readonly number[],
    read: (area: Rect) => Surface | undefined,
    pause: () => Promise<void>,
    cost = 1,
  ): Promise<void> {
    let budget = 0;
    for (let ty = 0; ty < this.#tilesY; ty++) {
      for (let tx = 0; tx < this.#tilesX; tx++) {
        const key = ty * this.#tilesX + tx;
        const stored = this.#tiles.get(key);
        const current = versions(tx, ty);
        if (sameVersions(stored?.versions, current, stored === undefined)) continue;
        const area = rect(
          tx * TILE_SIZE,
          ty * TILE_SIZE,
          Math.min(TILE_SIZE, this.#width - tx * TILE_SIZE),
          Math.min(TILE_SIZE, this.#height - ty * TILE_SIZE),
        );
        if (budget <= 0) {
          await pause();
          budget = SLICE_PIXELS;
        }
        budget -= area.width * area.height * Math.max(1, cost);
        // The content may have changed during the pause, so its versions are read again.
        const latest = versions(tx, ty);
        const pixels = read(area);
        this.#result = undefined;
        if (pixels === undefined) {
          if (latest.every((version) => version === 0)) this.#tiles.delete(key);
          else this.#tiles.set(key, this.#emptySums(latest));
        } else {
          this.#tiles.set(key, this.#sums(latest, area, pixels));
        }
      }
    }
  }

  /** The thumbnail of the tiles as last refreshed. It is the same object until a tile changes. */
  finish(): Surface {
    if (this.#result !== undefined) return this.#result;
    const bins = this.#thumbWidth * this.#thumbHeight;
    const colorSums = new Float64Array(bins * 3);
    const alphaSums = new Float64Array(bins);
    for (const tile of this.#tiles.values()) {
      const rows = tile.alphaSums.length / tile.binsAcross;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < tile.binsAcross; i++) {
          const from = j * tile.binsAcross + i;
          const to = (tile.binY + j) * this.#thumbWidth + tile.binX + i;
          alphaSums[to] = (alphaSums[to] ?? 0) + (tile.alphaSums[from] ?? 0);
          for (let c = 0; c < 3; c++) {
            colorSums[to * 3 + c] =
              (colorSums[to * 3 + c] ?? 0) + (tile.colorSums[from * 3 + c] ?? 0);
          }
        }
      }
    }
    const out = new Uint8ClampedArray(bins * 4);
    for (let bin = 0; bin < bins; bin++) {
      const count = this.#counts[bin] ?? 0;
      if (count === 0) continue;
      const alphaSum = alphaSums[bin] ?? 0;
      out[bin * 4 + 3] = Math.round(alphaSum / count);
      if (alphaSum > 0) {
        for (let c = 0; c < 3; c++) {
          out[bin * 4 + c] = Math.round((colorSums[bin * 3 + c] ?? 0) / alphaSum);
        }
      }
    }
    this.#result = new Surface(this.#thumbWidth, this.#thumbHeight, out);
    return this.#result;
  }

  #emptySums(versions: readonly number[]): TileSums {
    return {
      versions,
      binX: 0,
      binY: 0,
      binsAcross: 0,
      colorSums: new Float64Array(0),
      alphaSums: new Float64Array(0),
    };
  }

  /** The sums of `pixels`, which hold the tile's `area` (row stride `pixels.width`). */
  #sums(versions: readonly number[], area: Rect, pixels: Surface): TileSums {
    const binX = this.#column[area.x] ?? 0;
    const binY = this.#row[area.y] ?? 0;
    const binsAcross = (this.#column[area.x + area.width - 1] ?? 0) - binX + 1;
    const binsDown = (this.#row[area.y + area.height - 1] ?? 0) - binY + 1;
    const colorSums = new Float64Array(binsAcross * binsDown * 3);
    const alphaSums = new Float64Array(binsAcross * binsDown);
    const data = pixels.data;
    const stride = pixels.width;
    for (let y = 0; y < area.height; y++) {
      const binRow = ((this.#row[area.y + y] ?? 0) - binY) * binsAcross;
      for (let x = 0; x < area.width; x++) {
        const i = (y * stride + x) * 4;
        const alpha = data[i + 3] ?? 0;
        if (alpha === 0) continue;
        const bin = binRow + (this.#column[area.x + x] ?? 0) - binX;
        colorSums[bin * 3] = (colorSums[bin * 3] ?? 0) + (data[i] ?? 0) * alpha;
        colorSums[bin * 3 + 1] = (colorSums[bin * 3 + 1] ?? 0) + (data[i + 1] ?? 0) * alpha;
        colorSums[bin * 3 + 2] = (colorSums[bin * 3 + 2] ?? 0) + (data[i + 2] ?? 0) * alpha;
        alphaSums[bin] = (alphaSums[bin] ?? 0) + alpha;
      }
    }
    return { versions, binX, binY, binsAcross, colorSums, alphaSums };
  }
}

/** Whether a tile's stored versions still match. A tile never seen matches when it was never written. */
function sameVersions(
  stored: readonly number[] | undefined,
  current: readonly number[],
  unseen: boolean,
): boolean {
  if (unseen) return current.every((version) => version === 0);
  if (stored === undefined || stored.length !== current.length) return false;
  return stored.every((version, i) => version === current[i]);
}

/** The stack a document thumbnail was summed for. Any change to it starts the sums over. */
interface ThumbnailStack {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly CompositeSource[];
}

function sameStack(a: ThumbnailStack, b: ThumbnailStack): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.layers.length === b.layers.length &&
    a.layers.every((layer, i) => {
      const other = b.layers[i];
      return (
        other !== undefined &&
        layer.pixels === other.pixels &&
        layer.blendMode === other.blendMode &&
        layer.opacity === other.opacity
      );
    })
  );
}

/**
 * Renders document and layer thumbnails of one size incrementally: it keeps per-tile sums for each
 * layer store and each document, so a refresh after an edit reads and composites only the tiles the
 * edit touched (L8). The results equal `documentThumbnail` and `layerThumbnail`.
 */
export class ThumbnailRenderer {
  readonly #layers = new WeakMap<TiledPixelStore, TiledThumbnail>();
  readonly #documents = new WeakMap<
    Document,
    { readonly stack: ThumbnailStack; readonly sums: TiledThumbnail }
  >();

  constructor(readonly maxSize: number) {}

  /** `layerThumbnail(layer, maxSize)`. It returns the same surface while the layer is unchanged. */
  async layer(layer: Layer, pause: () => Promise<void>): Promise<Surface> {
    const store = layer.pixels;
    let sums = this.#layers.get(store);
    if (sums === undefined) {
      sums = new TiledThumbnail(store.width, store.height, this.maxSize);
      this.#layers.set(store, sums);
    }
    // A pending result shown over the layer counts as its pixels (TL-FRAME-01).
    const overlay = this.#overlayOf(layer.overlay, store.tilesX);
    await sums.refresh(
      (tx, ty) => [store.tileVersion(tx, ty), overlay.version(tx, ty)],
      (area) => {
        const tx = area.x / TILE_SIZE;
        const ty = area.y / TILE_SIZE;
        const patches = overlay.patches(tx, ty);
        if (patches === undefined) return store.getTile(tx, ty);
        const out = store.readRegion(area);
        drawOverlay(out, area, patches);
        return out;
      },
      pause,
    );
    return sums.finish();
  }

  readonly #overlaySerials = new WeakMap<LayerOverlay, number>();
  #nextOverlay = 0;

  /** An overlay's patches by tile, and a version for each tile it covers (0 for the others). */
  #overlayOf(overlay: LayerOverlay | undefined, tilesX: number) {
    let serial = 0;
    if (overlay !== undefined) {
      serial = this.#overlaySerials.get(overlay) ?? 0;
      if (serial === 0) {
        this.#nextOverlay += 1;
        serial = this.#nextOverlay;
        this.#overlaySerials.set(overlay, serial);
      }
    }
    const tiles = overlayByTile(overlay, tilesX);
    return {
      version: (tx: number, ty: number) => (tiles.has(ty * tilesX + tx) ? serial : 0),
      patches: (tx: number, ty: number) => tiles.get(ty * tilesX + tx),
    };
  }

  /** `documentThumbnail(doc, maxSize)`. It returns the same surface while the image is unchanged. */
  async document(doc: Document, pause: () => Promise<void>): Promise<Surface> {
    const stack: ThumbnailStack = {
      width: doc.width,
      height: doc.height,
      layers: doc.layers
        .filter((layer) => layer.visible)
        .map(({ pixels, blendMode, opacity }) => ({ pixels, blendMode, opacity })),
    };
    const overlays = doc.layers
      .filter((layer) => layer.visible)
      .map((layer) => ({
        overlay: layer.overlay,
        tiles: this.#overlayOf(layer.overlay, layer.pixels.tilesX),
      }));
    let entry = this.#documents.get(doc);
    if (entry === undefined || !sameStack(entry.stack, stack)) {
      entry = { stack, sums: new TiledThumbnail(doc.width, doc.height, this.maxSize) };
      this.#documents.set(doc, entry);
    }
    const { layers } = entry.stack;
    const shown = layers.map((layer, index) => ({ ...layer, overlay: overlays[index]?.overlay }));
    await entry.sums.refresh(
      (tx, ty) =>
        layers.flatMap((layer, index) => [
          layer.pixels.tileVersion(tx, ty),
          overlays[index]?.tiles.version(tx, ty) ?? 0,
        ]),
      (area) => {
        const tx = area.x / TILE_SIZE;
        const ty = area.y / TILE_SIZE;
        if (
          layers.every(
            (layer, index) =>
              layer.pixels.getTile(tx, ty) === undefined &&
              overlays[index]?.tiles.patches(tx, ty) === undefined,
          )
        ) {
          return undefined;
        }
        return flattenRegion(shown, area);
      },
      pause,
      layers.length,
    );
    return entry.sums.finish();
  }
}
