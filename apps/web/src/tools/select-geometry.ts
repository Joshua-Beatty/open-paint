import {
  clipPolygons,
  convertDotsPerUnit,
  ellipsePolygon,
  pixelPolygons,
  type Rect,
  type Resolution,
  rect,
  rectPolygon,
  type SelectionCombineMode,
  type SelectionPolygon,
  type Size,
} from "@openpaint/document";

/** The Draw mode of Rectangle Select (TL-SEL-RECT-01). */
export type DrawMode = "normal" | "fixedRatio" | "fixedSize";

/** The units a Fixed Ratio or Fixed Size box is measured in (TL-SEL-RECT-01). */
export type SizeUnit = "pixel" | "inch" | "centimeter";

/** A whole-pixel point in canvas coordinates. */
export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

const TOOLBAR_COMBINE_MODES: Readonly<Record<string, SelectionCombineMode>> = {
  Replace: "replace",
  Union: "union",
  Exclude: "exclude",
  Intersect: "intersect",
  Xor: "xor",
};

const DRAW_MODES: Readonly<Record<string, DrawMode>> = {
  Normal: "normal",
  FixedRatio: "fixedRatio",
  FixedSize: "fixedSize",
};

const SIZE_UNITS: Readonly<Record<string, SizeUnit>> = {
  Pixel: "pixel",
  Inch: "inch",
  Centimeter: "centimeter",
};

/** The Selection Mode choice as a combine mode (TL-OPT-SELMODE). Unknown values give Replace. */
export function combineModeOf(value: unknown): SelectionCombineMode {
  return (typeof value === "string" && TOOLBAR_COMBINE_MODES[value]) || "replace";
}

/** The Draw mode choice (TL-SEL-RECT-01). Unknown values give Any Size. */
export function drawModeOf(value: unknown): DrawMode {
  return (typeof value === "string" && DRAW_MODES[value]) || "normal";
}

/** The units choice of a Fixed Ratio or Fixed Size box. Unknown values give Pixels. */
export function sizeUnitOf(value: unknown): SizeUnit {
  return (typeof value === "string" && SIZE_UNITS[value]) || "pixel";
}

/**
 * The combine mode of a drag (TL-SEL-01): Ctrl with the left button adds, Alt with the left button
 * subtracts, Ctrl with the right button inverts and Alt with the right button intersects. With no
 * such modifier, the toolbar's Selection Mode applies.
 */
export function combineModeFor(
  input: { readonly button: number; readonly ctrlKey: boolean; readonly altKey: boolean },
  toolbar: SelectionCombineMode,
): SelectionCombineMode {
  if (input.button === 0) {
    if (input.ctrlKey) return "union";
    if (input.altKey) return "exclude";
  } else if (input.button === 2) {
    if (input.ctrlKey) return "xor";
    if (input.altKey) return "intersect";
  }
  return toolbar;
}

/** A length in the given unit as pixels of a document with `resolution` (TL-SEL-RECT-01). */
export function lengthInPixels(length: number, unit: SizeUnit, resolution: Resolution): number {
  return length * convertDotsPerUnit(resolution.x, resolution.unit, unit);
}

/**
 * The rectangle of a drag from `start` to `end`. Both pixels count, so the rectangle reaches one
 * pixel past the end on the far side (TL-SEL-RECT-01). With `square`, the longer side sets both.
 */
export function dragRect(start: PixelPoint, end: PixelPoint, square: boolean): Rect {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let width = Math.abs(dx) + 1;
  let height = Math.abs(dy) + 1;
  if (square) width = height = Math.max(width, height);
  return spanRect(start, width, height, dx < 0 ? -1 : 1, dy < 0 ? -1 : 1);
}

/**
 * A drag rectangle with the width to height ratio `ratio`. The side the drag reaches furthest along
 * sets the size, and the other side follows the ratio (TL-SEL-RECT-01 Fixed Ratio).
 */
export function ratioRect(start: PixelPoint, end: PixelPoint, ratio: number): Rect {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let width = Math.abs(dx) + 1;
  let height = Math.abs(dy) + 1;
  if (width / height > ratio) height = Math.max(1, Math.round(width / ratio));
  else width = Math.max(1, Math.round(height * ratio));
  return spanRect(start, width, height, dx < 0 ? -1 : 1, dy < 0 ? -1 : 1);
}

/**
 * A rectangle of exactly `width` by `height` pixels with its top left at `point`, moved back inside
 * the canvas where it would hang over an edge (TL-SEL-RECT-01 Fixed Size).
 */
export function fixedSizeRect(
  point: PixelPoint,
  width: number,
  height: number,
  canvas: Size,
): Rect {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const x = Math.min(Math.max(0, point.x), Math.max(0, canvas.width - w));
  const y = Math.min(Math.max(0, point.y), Math.max(0, canvas.height - h));
  return rect(x, y, w, h);
}

/**
 * The polygons of a selection shape clipped to the canvas (TL-SEL-01: clipped to the image), with
 * every vertex on a pixel corner (owner request), where a slanted edge meets the canvas edge too.
 */
export function shapePolygons(
  shape: "rectangle" | "ellipse",
  area: Rect,
  canvas: Size,
): SelectionPolygon[] {
  const outline = shape === "ellipse" ? ellipsePolygon(area) : rectPolygon(area);
  return pixelPolygons(
    clipPolygons("intersection", [outline], [rectPolygon(rect(0, 0, canvas.width, canvas.height))]),
  );
}

/**
 * The polygon of a freeform lasso path, closed automatically between its last and first points, and
 * clipped to the canvas (TL-SEL-LASSO-01), with every vertex on a pixel corner and straight runs
 * merged into one edge. Empty when the path encloses no area.
 */
export function lassoPolygons(points: readonly PixelPoint[], canvas: Size): SelectionPolygon[] {
  if (points.length < 3) return [];
  const ring = points.flatMap((point) => [point.x, point.y]);
  return pixelPolygons(
    clipPolygons("intersection", [ring], [rectPolygon(rect(0, 0, canvas.width, canvas.height))]),
  );
}

/**
 * How far, in image pixels, the pointer may stray from a straight run between two pixel corners
 * while the Lasso still draws it as one edge.
 */
export const LASSO_STRAIGHT_TOLERANCE = 0.5;

/** The distance from `p` to the segment from `a` to `b`. */
function segmentDistance(p: PixelPoint, a: PixelPoint, b: PixelPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * A Lasso path between pixel corners (TL-SEL-LASSO-01; owner request: selections are pixel based).
 * Each pointer sample goes to its nearest pixel corner. While every sample since the last vertex
 * stays within `LASSO_STRAIGHT_TOLERANCE` of the straight run from that vertex to the newest
 * corner, the run only grows; otherwise its end becomes a vertex and a new run starts. So the
 * outline is straight edges between corners at any slope (1 by 1, 2 by 3, 7 by 1, ...), with no
 * repeated vertices, and the vertices already placed never move.
 */
export class CornerPath {
  /** The vertices, then the end of the run being drawn. */
  #points: PixelPoint[] = [];
  /** The pointer samples since the last vertex, in image pixels. */
  #samples: PixelPoint[] = [];
  /** Whether the last point is the end of the run being drawn rather than a vertex. */
  #open = false;

  /** The path's corners, in order. */
  get points(): readonly PixelPoint[] {
    return this.#points;
  }

  /** Adds a pointer sample at `sample` (image pixels, fractional). */
  add(sample: PixelPoint): void {
    const points = this.#points;
    const last = points.at(-1);
    if (last === undefined) {
      points.push(nearestCorner(sample));
      this.#samples = [];
      return;
    }
    const vertex = this.#open ? points.at(-2) : last;
    if (vertex === undefined) return;
    this.#samples.push(sample);
    const end = this.#runEnd(vertex, this.#open ? last : undefined, sample);
    if (end !== undefined) {
      if (this.#open) points[points.length - 1] = end;
      else points.push(end);
      this.#open = true;
      return;
    }
    // No straight run from the vertex reaches the pointer: the run's end (if any) becomes a
    // vertex, and a new run starts there towards the corner nearest the pointer.
    this.#samples = [];
    this.#open = false;
    const from = points.at(-1) ?? vertex;
    const next = nearestCorner(sample);
    if (next.x !== from.x || next.y !== from.y) {
      points.push(next);
      this.#open = true;
    }
  }

  /**
   * The corner the run from `vertex` ends at for the samples so far: the corner nearest `sample`,
   * else the run's current end, else another corner of the pixel under `sample`, nearest first,
   * whichever first keeps every sample within the tolerance of the run. Undefined when none does.
   */
  #runEnd(
    vertex: PixelPoint,
    end: PixelPoint | undefined,
    sample: PixelPoint,
  ): PixelPoint | undefined {
    const x = Math.floor(sample.x);
    const y = Math.floor(sample.y);
    const around: PixelPoint[] = [
      { x, y },
      { x: x + 1, y },
      { x, y: y + 1 },
      { x: x + 1, y: y + 1 },
    ];
    const gap = (p: PixelPoint) => Math.hypot(p.x - sample.x, p.y - sample.y);
    around.sort((p, q) => gap(p) - gap(q));
    const candidates = [nearestCorner(sample), ...(end === undefined ? [] : [end]), ...around];
    for (const corner of candidates) {
      if (corner.x === vertex.x && corner.y === vertex.y) continue;
      const fits = this.#samples.every(
        (p) => segmentDistance(p, vertex, corner) <= LASSO_STRAIGHT_TOLERANCE,
      );
      if (fits) return corner;
    }
    return undefined;
  }

  /** Moves the whole path by whole pixels (TL-SEL-01 move-origin mode). */
  translate(dx: number, dy: number): void {
    this.#points = this.#points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    this.#samples = this.#samples.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  }
}

/** The pixel corner nearest to `p`. */
export function nearestCorner(p: PixelPoint): PixelPoint {
  return { x: Math.round(p.x) + 0, y: Math.round(p.y) + 0 };
}

/** A rectangle grown from `anchor` in the direction of the drag, `width` by `height` pixels. */
function spanRect(
  anchor: PixelPoint,
  width: number,
  height: number,
  dirX: number,
  dirY: number,
): Rect {
  const x = dirX >= 0 ? anchor.x : anchor.x - width + 1;
  const y = dirY >= 0 ? anchor.y : anchor.y - height + 1;
  return rect(x, y, width, height);
}
