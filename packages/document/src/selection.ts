import type { Rect, Size } from "./geometry";
import { rect } from "./geometry";
import { maskRunPolygons, rasterizeSelection } from "./selection-mask";
import {
  type AffineMatrix,
  type ClipOperation,
  clipPolygons,
  composeAffine,
  DEFAULT_SELECTION_QUALITY,
  normalizePolygons,
  onPixelCorners,
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
 * Selections are pixel based (owner request): the tools make them with every vertex on a whole
 * pixel corner, combining two such selections keeps them there, and `placed` keeps them there
 * through moves and resizes. A rotated outline keeps its exact, fractional vertices (owner
 * request), through later moves, resizes, combines, history and checkpoints: the selection itself
 * never snaps geometry it is given.
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
    this.#polygons = normalizePolygons(polygons);
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

  /** The polygons with the pending transform applied and normalized. */
  effectivePolygons(): readonly SelectionPolygon[] {
    if (!this.pendingTransform) return this.#polygons;
    const m = this.pendingTransform;
    return normalizePolygons(this.#polygons.map((polygon) => transformPolygon(polygon, m)));
  }

  /**
   * The selection moved by `m` and committed, as the move tools place it (owner request). A move,
   * resize, flip or quarter turn of a selection on pixel corners stays on pixel corners: its
   * vertices go to the nearest corner. Any other turn, or a selection already off the corners
   * (a rotated one), keeps its exact outline, so a rotation never changes the shape.
   */
  placed(m: AffineMatrix): Selection {
    const moved = this.transform(m).commit();
    if (!axisAligned(m) || !onPixelCorners(this.effectivePolygons())) return moved;
    return new Selection(pixelPolygons(moved.polygons), this.quality);
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
    const current = this.effectivePolygons();
    const result = clipPolygons(COMBINE_OPERATIONS[mode], current, incoming);
    // Two outlines on pixel corners combine onto pixel corners, where their slanted edges cross
    // too. A rotated outline keeps its exact edges, and so its crossings.
    const snap = onPixelCorners(current) && onPixelCorners(incoming);
    return new Selection(snap ? pixelPolygons(result) : result, this.quality);
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
    const current = this.effectivePolygons();
    const result = clipPolygons("difference", [rectPolygon(canvas)], current);
    return new Selection(onPixelCorners(current) ? pixelPolygons(result) : result, this.quality);
  }
}

/** Whether `m` keeps the axes: no turn, or a quarter turn, possibly with a flip and a scale. */
function axisAligned(m: AffineMatrix): boolean {
  const tiny = (value: number) => Math.abs(value) < 1e-9;
  return (tiny(m.b) && tiny(m.c)) || (tiny(m.a) && tiny(m.d));
}
