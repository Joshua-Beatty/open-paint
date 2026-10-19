import {
  type Document,
  EMPTY_RECT,
  intersectRects,
  isEmptyRect,
  type Layer,
  type Rect,
  rect,
  rectFromEdges,
  Surface,
  TILE_SIZE,
  type TiledPixelStore,
  unionRects,
} from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import { type BucketOptions, bucketFillCpu } from "@openpaint/engine";
import { selectionCoverage } from "./paint-stroke";

/** The key of the store tile at (`tx`, `ty`) in a `TileRegion`. Images are far below 4096 tiles wide. */
function tileKey(tx: number, ty: number): number {
  return ty * 4096 + tx;
}

/**
 * A set of pixel rectangles, at most one per store tile: the pixels a tool session wrote (L2). A
 * rectangle that spans tiles is split along the tile grid, and rectangles in the same tile join
 * into their bounding rectangle. Restoring or recording a region touches only the tiles it has, so
 * a shape's outline costs its perimeter, not the box around it.
 */
export class TileRegion {
  readonly #parts = new Map<number, Rect>();

  /** A region of the given rectangles. Empty rectangles add nothing. */
  static of(...areas: readonly Rect[]): TileRegion {
    const region = new TileRegion();
    for (const area of areas) region.add(area);
    return region;
  }

  get isEmpty(): boolean {
    return this.#parts.size === 0;
  }

  /** Adds `area`, split along the tile grid. Its pixels must have non-negative coordinates. */
  add(area: Rect): void {
    if (isEmptyRect(area)) return;
    const right = area.x + area.width;
    const bottom = area.y + area.height;
    for (let ty = Math.floor(area.y / TILE_SIZE); ty * TILE_SIZE < bottom; ty++) {
      for (let tx = Math.floor(area.x / TILE_SIZE); tx * TILE_SIZE < right; tx++) {
        const part = intersectRects(
          area,
          rect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE),
        );
        if (isEmptyRect(part)) continue;
        const key = tileKey(tx, ty);
        const previous = this.#parts.get(key);
        this.#parts.set(key, previous === undefined ? part : unionRects(previous, part));
      }
    }
  }

  /** Adds every rectangle of `other`. */
  addRegion(other: TileRegion): void {
    for (const part of other.rects()) this.add(part);
  }

  /** The union of this region and `other`, as a new region. */
  union(other: TileRegion): TileRegion {
    const out = TileRegion.of(...this.rects());
    out.addRegion(other);
    return out;
  }

  /** The rectangles, one per tile, in no particular order. */
  rects(): Rect[] {
    return [...this.#parts.values()];
  }

  /** The smallest rectangle that holds the region, or an empty one. */
  bounds(): Rect {
    let bounds = EMPTY_RECT;
    for (const part of this.#parts.values()) bounds = joinRects(bounds, part);
    return bounds;
  }
}

/**
 * A layer's pixels as they were when a tool session began, copied one store tile at a time when an
 * area is first read (L9: no whole-layer copy on pointer down). The session must read an area
 * before it writes there, which a session that renders before it writes always does.
 */
export class LayerSnapshot {
  readonly #store: TiledPixelStore;
  /** The copied tiles by key, `null` for a tile that was transparent. */
  readonly #tiles = new Map<number, Surface | null>();

  constructor(store: TiledPixelStore) {
    this.#store = store;
  }

  get bounds(): Rect {
    return this.#store.bounds;
  }

  /** The snapshot's pixels over `area`, transparent outside the layer. */
  read(area: Rect): Surface {
    const out = new Surface(Math.max(0, area.width), Math.max(0, area.height));
    for (const { tx, ty } of this.#store.tilesInRect(area)) {
      const tile = this.#tile(tx, ty);
      if (tile === null) continue;
      const part = intersectRects(area, this.#store.tileBounds(tx, ty));
      out.copyFrom(
        tile,
        {
          x: part.x - tx * TILE_SIZE,
          y: part.y - ty * TILE_SIZE,
          width: part.width,
          height: part.height,
        },
        part.x - area.x,
        part.y - area.y,
      );
    }
    return out;
  }

  /** Copies the tiles under `area` that the snapshot has not read yet, before they are written. */
  keep(area: Rect): void {
    for (const { tx, ty } of this.#store.tilesInRect(area)) this.#tile(tx, ty);
  }

  /**
   * Writes the snapshot's pixels over `area` into `pixels`, straight from its tiles (no scratch
   * copy). A tile that was transparent is cleared.
   */
  restore(pixels: TiledPixelStore, area: Rect | TileRegion): void {
    if (area instanceof TileRegion) {
      for (const part of area.rects()) this.restore(pixels, part);
      return;
    }
    if (isEmptyRect(area)) return;
    for (const { tx, ty } of this.#store.tilesInRect(area)) {
      const part = intersectRects(area, this.#store.tileBounds(tx, ty));
      const tile = this.#tile(tx, ty);
      if (tile === null) {
        pixels.clear(part);
        continue;
      }
      pixels.writeRegion(tile, part.x, part.y, {
        x: part.x - tx * TILE_SIZE,
        y: part.y - ty * TILE_SIZE,
        width: part.width,
        height: part.height,
      });
    }
  }

  /**
   * The whole tile at (`tx`, `ty`) as the snapshot has it, or null when it was transparent, for a
   * history item's before-state (`Document.recordLayerPixels`).
   */
  readonly tileAt = (tx: number, ty: number): Surface | null => this.#tile(tx, ty);

  #tile(tx: number, ty: number): Surface | null {
    const key = ty * this.#store.tilesX + tx;
    let tile = this.#tiles.get(key);
    if (tile === undefined) {
      tile = this.#store.getTile(tx, ty)?.clone() ?? null;
      this.#tiles.set(key, tile);
    }
    return tile;
  }
}

/** Rendered pixels for one rectangle of a layer. */
export interface LayerPatch {
  readonly output: Surface;
  readonly area: Rect;
}

/** A render as rectangles of a layer, each inside one store tile (`renderCoverage`). */
export type LayerPatches = readonly LayerPatch[];

/** The pixels a set of patches covers. */
export function patchRegion(patches: LayerPatches | undefined): TileRegion {
  return TileRegion.of(...(patches ?? []).map((patch) => patch.area));
}

/** One coverage rasterized over its own rectangle of the layer. */
export interface CoveragePart {
  readonly area: Rect;
  readonly coverage: Uint8Array;
}

/** A fill pass: its parts combine by maximum (they overlap at joints) and are filled as one stencil. */
export interface CoverageFill {
  readonly parts: readonly CoveragePart[];
  readonly options: BucketOptions;
}

/** The selection clip of a render (TL-FRAME-04), read only over the rendered area. */
export interface SelectionClip {
  readonly selection: { readonly isEmpty: boolean; mask(area: Rect): Uint8Array };
  readonly pixelated: boolean;
}

/** Hatch patterns repeat every 8 pixels from the layer origin (TL-OPT-FILL). */
const HATCH_PERIOD = 8;

/** The union of two rectangles, where an empty one adds nothing. */
export function joinRects(a: Rect, b: Rect): Rect {
  if (isEmptyRect(a)) return b;
  if (isEmptyRect(b)) return a;
  return unionRects(a, b);
}

/**
 * `area` grown so its top-left corner sits on the hatch grid, clipped to `bounds`. A fill over a
 * buffer that starts there repeats its hatch from the layer origin, as a fill over the whole layer
 * does, so the pixels are the same.
 */
export function hatchAligned(area: Rect, bounds: Rect): Rect {
  const left = Math.floor(area.x / HATCH_PERIOD) * HATCH_PERIOD;
  const top = Math.floor(area.y / HATCH_PERIOD) * HATCH_PERIOD;
  return intersectRects(
    rectFromEdges(left, top, area.x + area.width, area.y + area.height),
    bounds,
  );
}

/**
 * Fills coverage stencils over a snapshot and clips the result to the selection (L2). The work is
 * done per store tile, over the rectangle the stencils' parts cover in that tile, and a tile no
 * part reaches is skipped: an outline costs its perimeter, not its box. The fills run in order
 * without antialiasing their stencils, so the result equals filling full-layer stencils and
 * cropping. `box` is the stencils' rectangle; the patches are empty when nothing is drawn.
 */
export function renderCoverage(
  base: LayerSnapshot,
  fills: readonly CoverageFill[],
  clip: SelectionClip,
): { readonly patches: LayerPatches; readonly box: Rect } {
  let box: Rect = EMPTY_RECT;
  /** Per tile, the parts of each fill that reach it. */
  const tiles = new Map<number, { tile: Rect; parts: CoveragePart[][] }>();
  const bounds = base.bounds;
  fills.forEach((fill, index) => {
    if (fill.options.antialias) throw new RangeError("Coverage fills are not feathered.");
    for (const part of fill.parts) {
      const area = intersectRects(part.area, bounds);
      if (isEmptyRect(area)) continue;
      box = joinRects(box, area);
      const right = area.x + area.width;
      const bottom = area.y + area.height;
      for (let ty = Math.floor(area.y / TILE_SIZE); ty * TILE_SIZE < bottom; ty++) {
        for (let tx = Math.floor(area.x / TILE_SIZE); tx * TILE_SIZE < right; tx++) {
          const key = tileKey(tx, ty);
          let entry = tiles.get(key);
          if (entry === undefined) {
            const tile = intersectRects(
              rect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE),
              bounds,
            );
            entry = { tile, parts: fills.map(() => []) };
            tiles.set(key, entry);
          }
          entry.parts[index]?.push(part);
        }
      }
    }
  });
  const patches: LayerPatch[] = [];
  for (const { tile, parts } of tiles.values()) {
    for (const area of reachAreas(parts, tile)) {
      const original = base.read(area);
      let filled = original;
      fills.forEach((fill, index) => {
        const list = parts[index] ?? [];
        if (list.length === 0) return;
        const mask = new Uint8Array(area.width * area.height);
        let any = false;
        for (const part of list) {
          if (!isEmptyRect(intersectRects(part.area, area))) {
            any = addCoverage(mask, area, part) || any;
          }
        }
        if (any) filled = bucketFillCpu(filled, mask, fill.options);
      });
      if (filled === original) continue;
      const coverage = selectionCoverage(clip.selection, area, clip.pixelated);
      const output = coverage === undefined ? filled : clipToCoverage(original, filled, coverage);
      patches.push({ output, area });
    }
  }
  return { patches, box };
}

/**
 * The areas of a tile that its parts reach, each on the hatch grid and apart from the others. Parts
 * whose areas meet are filled together. A thin diagonal, rasterized in cells (`coverageParts`),
 * then costs its cells, not the box they span in the tile (L2). Outside the parts the fills change
 * nothing, so the pixels are those of one fill over the parts' whole box.
 */
function reachAreas(parts: readonly (readonly CoveragePart[])[], tile: Rect): Rect[] {
  const areas: Rect[] = [];
  for (const list of parts) {
    for (const part of list) {
      const reach = intersectRects(part.area, tile);
      if (!isEmptyRect(reach)) areas.push(hatchAligned(reach, tile));
    }
  }
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < areas.length && !merged; i++) {
      for (let j = i + 1; j < areas.length; j++) {
        const a = areas[i];
        const b = areas[j];
        if (a === undefined || b === undefined || isEmptyRect(intersectRects(a, b))) continue;
        areas[i] = hatchAligned(unionRects(a, b), tile);
        areas.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return areas;
}

/**
 * Takes the larger coverage of each pixel of `part` into `mask`, which covers `area`; the part may
 * reach outside it. Returns whether any of the part's pixels inside `area` is covered.
 */
function addCoverage(mask: Uint8Array, area: Rect, part: CoveragePart): boolean {
  const { area: from, coverage } = part;
  const overlap = intersectRects(from, area);
  let any = false;
  for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
    const source = (y - from.y) * from.width - from.x;
    const target = (y - area.y) * area.width - area.x;
    for (let x = overlap.x; x < overlap.x + overlap.width; x++) {
      const value = coverage[source + x] ?? 0;
      if (value > (mask[target + x] ?? 0)) {
        mask[target + x] = value;
        any = true;
      }
    }
  }
  return any;
}

/** Writes patches into a layer's pixels; none writes nothing. */
export function writePatches(pixels: TiledPixelStore, patches: LayerPatches | undefined): void {
  for (const patch of patches ?? []) pixels.writeRegion(patch.output, patch.area.x, patch.area.y);
}

/**
 * The pixels of a tool session that draws one thing over a layer and keeps it editable, such as a
 * shape or a line (TL-FRAME-01). Each step renders over the layer as it was before the session, so
 * the steps never stack. `committed` is the output of the last recorded step. `region` holds every
 * pixel where the layer may differ from the base plus `committed`, and every pixel of `committed`:
 * a preview or a record restores just that and draws its own patches, so a step costs what it and
 * the step before it cover, never the union of every position the session has seen (L2).
 */
export class SessionPixels {
  readonly document: Document;
  readonly layer: Layer;
  /** The layer before the session. Every step draws over it. */
  readonly base: LayerSnapshot;
  readonly #store: TiledPixelStore;
  #committed: LayerPatches = [];
  #region = new TileRegion();

  constructor(document: Document, layer: Layer) {
    this.document = document;
    this.layer = layer;
    this.#store = layer.pixels;
    this.base = new LayerSnapshot(layer.pixels);
  }

  /** The output of the last recorded step, empty before the first. */
  get committed(): LayerPatches {
    return this.#committed;
  }

  /**
   * Whether the session can still draw on its layer: the layer is in the image and holds the
   * pixels the session began on (a resize or a deleted layer replaces them).
   */
  get valid(): boolean {
    return this.document.layers.includes(this.layer) && this.layer.pixels === this.#store;
  }

  /**
   * Takes `patches` as the output of the recorded step the layer shows now, after an undo or a redo
   * landed on one of the session's steps. Nothing is written.
   */
  adopt(patches: LayerPatches): void {
    this.#committed = patches;
    this.#region = patchRegion(patches);
  }

  /** Shows `patches` on the layer, with no history item. */
  show(patches: LayerPatches): void {
    const previous = this.#region;
    if (previous.isEmpty && patches.length === 0) return;
    for (const patch of patches) this.base.keep(patch.area);
    this.document.previewLayerPixels(this.layer, (pixels) => {
      this.base.restore(pixels, previous);
      writePatches(pixels, patches);
    });
    this.#region = patchRegion(patches).union(patchRegion(this.#committed));
  }

  /**
   * Records `patches` as one history item named `name`. The layer is first put back to the last
   * recorded step, so the item's before-state is right, even after previews. Returns false, and
   * records nothing, when neither the step nor any earlier one drew a pixel.
   */
  record(name: string, patches: LayerPatches): boolean {
    const next = patchRegion(patches);
    const area = this.#region.union(next);
    if (area.isEmpty) return false;
    for (const patch of patches) this.base.keep(patch.area);
    const committed = this.#committed;
    this.document.restoreLayerPixels(this.layer, (pixels) => {
      this.base.restore(pixels, area);
      writePatches(pixels, committed);
    });
    this.document.editLayerPixels(name, this.layer, area.rects(), (pixels) => {
      this.base.restore(pixels, area);
      writePatches(pixels, patches);
    });
    this.#committed = patches;
    this.#region = next;
    return true;
  }

  /** Puts the layer back to the last recorded step, or to the base before any. */
  revert(): void {
    const region = this.#region;
    if (region.isEmpty) return;
    const committed = this.#committed;
    this.document.restoreLayerPixels(this.layer, (pixels) => {
      this.base.restore(pixels, region);
      writePatches(pixels, committed);
    });
    this.#region = patchRegion(committed);
  }
}

/** Writes a patch into a layer's pixels; no patch writes nothing. */
export function writePatch(pixels: TiledPixelStore, patch: LayerPatch | undefined): void {
  if (patch !== undefined) pixels.writeRegion(patch.output, patch.area.x, patch.area.y);
}
