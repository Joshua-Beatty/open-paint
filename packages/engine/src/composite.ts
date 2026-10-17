import {
  intersectRects,
  type Rect,
  rect,
  TILE_SIZE,
  type TiledPixelStore,
} from "@openpaint/document";

/** Number of layer blend modes (DOC-BLD-01 values 0-13). */
export const LAYER_BLEND_MODE_COUNT = 14;

/** One raster layer as the compositor sees it. Layers are bottom to top in the document. */
export interface CompositeLayer {
  readonly store: TiledPixelStore;
  /** DOC-BLD-01 layer blend mode, 0 (Normal) to 13 (Xor). */
  readonly mode: number;
  /** Layer opacity 0-255 (DOC-BLD-02 step 1). */
  readonly opacity: number;
  readonly visible: boolean;
  /** The per-pixel adjustment shown over the layer while a dialog previews it. */
  readonly live?: LiveFilter;
}

/** A live filter over a layer: the worker's side of `LayerLivePreview` (FX-FW-PREVIEW-01). */
export interface LiveFilter {
  readonly effectId: string;
  readonly params: unknown;
  /** The part of the layer the adjustment covers, in document pixels. */
  readonly region: Rect;
  /** The selection's coverage over `region`, one byte per pixel, or undefined for all of it. */
  readonly coverage: Uint8Array | undefined;
  /** The same for the same filter, so a filter sent again is not a change. */
  readonly key: string;
}

/** A stack of layers that share the document's pixel size. */
export interface CompositeDocument {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly CompositeLayer[];
}

export const EMPTY_DOCUMENT: CompositeDocument = { width: 0, height: 0, layers: [] };

export interface TileIndex {
  readonly tx: number;
  readonly ty: number;
}

/**
 * The layers that contribute to the composite, bottom to top: visible with opacity above zero
 * (DOC-BLD-02). Throws when a layer's mode, opacity or size is outside the document's contract.
 */
export function activeLayers(doc: CompositeDocument): CompositeLayer[] {
  const active: CompositeLayer[] = [];
  for (const layer of doc.layers) {
    if (!Number.isInteger(layer.mode) || layer.mode < 0 || layer.mode >= LAYER_BLEND_MODE_COUNT) {
      throw new RangeError(`Unknown layer blend mode ${layer.mode}.`);
    }
    if (!Number.isInteger(layer.opacity) || layer.opacity < 0 || layer.opacity > 255) {
      throw new RangeError(`Layer opacity ${layer.opacity} is not an integer in 0-255.`);
    }
    if (layer.store.width !== doc.width || layer.store.height !== doc.height) {
      throw new RangeError(
        `Layer is ${layer.store.width}x${layer.store.height}; the document is ${doc.width}x${doc.height}.`,
      );
    }
    if (layer.visible && layer.opacity > 0) active.push(layer);
  }
  return active;
}

/**
 * The part of the document that a canvas of `canvasWidth` x `canvasHeight` device pixels shows,
 * anchored at the top-left corner (1:1, no view transform yet).
 */
export function visibleRegion(
  doc: CompositeDocument,
  canvasWidth: number,
  canvasHeight: number,
): Rect {
  return intersectRects(
    rect(0, 0, doc.width, doc.height),
    rect(0, 0, Math.max(0, canvasWidth), Math.max(0, canvasHeight)),
  );
}

/** Tile indices covering `region`, row-major. Each tile spans `TILE_SIZE` document pixels. */
export function tilesCovering(region: Rect): TileIndex[] {
  if (region.width <= 0 || region.height <= 0) return [];
  const tx1 = Math.floor((region.x + region.width - 1) / TILE_SIZE);
  const ty1 = Math.floor((region.y + region.height - 1) / TILE_SIZE);
  const tiles: TileIndex[] = [];
  for (let ty = Math.floor(region.y / TILE_SIZE); ty <= ty1; ty++) {
    for (let tx = Math.floor(region.x / TILE_SIZE); tx <= tx1; tx++) tiles.push({ tx, ty });
  }
  return tiles;
}
