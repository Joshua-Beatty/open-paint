import type { Rect, Size } from "./geometry";
import { rect } from "./geometry";
import { maskRunPolygons, rasterizeSelection } from "./selection-mask";
import {
  type AffineMatrix,
  type ClipOperation,
  clipPolygons,
  composeAffine,
  DEFAULT_SELECTION_QUALITY,
  pixelPolygons,
  polygonsArea,
  polygonsBounds,
  rectPolygon,
  type SelectionCombineMode,
  type SelectionPolygon,
  type SelectionQuality,
  transformPolygon,
} from "./selection-polygons";

const COMBINE_OPERATIONS: Record<Exclude<SelectionCombineMode, "replace">, ClipOperation> = {
  union: "union",
  exclude: "difference",
  intersect: "intersection",
  xor: "xor",
};

/**
 * An immutable selection (DOC-SEL-01): a normalized polygon set, a quality (DOC-SEL-03) and an
 * optional pending transform that applies on commit. Every operation returns a new selection, so
 * history can keep the previous one. An empty polygon set means nothing is selected.
 *
 * Selections are pixel based (owner request): the polygons, and the polygons a pending transform
 * gives, have every vertex on a whole pixel corner (`pixelPolygons`). Geometry with fractional
 * vertices, such as a selection from an older checkpoint, is snapped when it is made.
 */
export class Selection {
  readonly quality: SelectionQuality;
  readonly pendingTransform: AffineMatrix | undefined;
  readonly #polygons: readonly SelectionPolygon[];

  constructor(
    polygons: readonly SelectionPolygon[] = [],
    quality: SelectionQuality = DEFAULT_SELECTION_QUALITY,
    pendingTransform?: AffineMatrix,
  ) {
    this.#polygons = pixelPolygons(polygons);
    this.quality = quality;
    this.pendingTransform = pendingTransform;
  }

  /** The whole canvas rectangle, as used by Select All (DOC-SEL-06a). */
  static all(size: Size, quality: SelectionQuality = DEFAULT_SELECTION_QUALITY): Selection {
    return new Selection([rectPolygon(rect(0, 0, size.width, size.height))], quality);
  }

  /** True when nothing is selected. */
  get isEmpty(): boolean {
    return this.#polygons.length === 0;
  }

  /** The committed polygons, without the pending transform. */
  get polygons(): readonly SelectionPolygon[] {
    return this.#polygons;
  }

  /** The polygons with the pending transform applied and snapped to pixel corners. */
  effectivePolygons(): readonly SelectionPolygon[] {
    if (!this.pendingTransform) return this.#polygons;
    const m = this.pendingTransform;
    return pixelPolygons(this.#polygons.map((polygon) => transformPolygon(polygon, m)));
  }

  /** The integer rectangle that bounds the selection, or an empty rectangle when empty. */
  bounds(): Rect {
    return polygonsBounds(this.effectivePolygons());
  }

  /**
   * Whether the selection fully covers every pixel of `area`: it is one solid rectangle with whole
   * pixel corners (Select All, an aligned rectangle) that contains `area`. Its mask there is then
   * all 255 in either quality, so it need not be rasterized (L2).
   */
  coversRect(area: Rect): boolean {
    if (this.isEmpty) return false;
    const bounds = this.bounds();
    const solid = this.area() === bounds.width * bounds.height;
    return (
      solid &&
      area.x >= bounds.x &&
      area.y >= bounds.y &&
      area.x + area.width <= bounds.x + bounds.width &&
      area.y + area.height <= bounds.y + bounds.height
    );
  }

  /** The area in square pixels. Rings are normalized, so the signed sum is the exact area. */
  area(): number {
    return polygonsArea(this.effectivePolygons());
  }

  /**
   * The clip mask over `area` in row-major order, one byte per pixel, using this selection's
   * quality (DOC-SEL-03). An empty selection gives an all-zero mask.
   */
  mask(area: Rect): Uint8Array {
    return rasterizeSelection(this.effectivePolygons(), area, this.quality);
  }

  withQuality(quality: SelectionQuality): Selection {
    return new Selection(this.#polygons, quality, this.pendingTransform);
  }

  /** Adds `m` to the pending transform. Nothing changes until `commit`. */
  transform(m: AffineMatrix): Selection {
    const pending = this.pendingTransform ? composeAffine(m, this.pendingTransform) : m;
    return new Selection(this.#polygons, this.quality, pending);
  }

  /** Applies the pending transform to the geometry. Returns this selection when none is pending. */
  commit(): Selection {
    if (!this.pendingTransform) return this;
    return new Selection(this.effectivePolygons(), this.quality);
  }

  /**
   * Combines `incoming` with this selection (DOC-SEL-02). Replace discards the current geometry.
   * Union adds, Exclude subtracts `incoming`, Intersect keeps the overlap and Xor keeps the
   * non-overlapping parts.
   */
  combine(incoming: readonly SelectionPolygon[], mode: SelectionCombineMode): Selection {
    if (mode === "replace") return new Selection(incoming, this.quality);
    return new Selection(
      clipPolygons(COMBINE_OPERATIONS[mode], this.effectivePolygons(), incoming),
      this.quality,
    );
  }

  /**
   * The canvas minus this selection (DOC-SEL-06c). Aliased selections invert pixel by pixel,
   * giving a pixel-aligned result. Antialiased selections invert through polygon clipping.
   */
  inverted(size: Size): Selection {
    const canvas = rect(0, 0, size.width, size.height);
    if (this.quality === "aliased") {
      const mask = this.mask(canvas);
      for (let i = 0; i < mask.length; i++) mask[i] = mask[i] === 0 ? 255 : 0;
      return new Selection(maskRunPolygons(mask, size.width, size.height), this.quality);
    }
    return new Selection(
      clipPolygons("difference", [rectPolygon(canvas)], this.effectivePolygons()),
      this.quality,
    );
  }
}
