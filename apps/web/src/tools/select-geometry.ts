import {
  clipPolygons,
  convertDotsPerUnit,
  ellipsePolygon,
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

/** The polygons of a selection shape clipped to the canvas (TL-SEL-01: clipped to the image). */
export function shapePolygons(
  shape: "rectangle" | "ellipse",
  area: Rect,
  canvas: Size,
): SelectionPolygon[] {
  const outline = shape === "ellipse" ? ellipsePolygon(area) : rectPolygon(area);
  return clipPolygons(
    "intersection",
    [outline],
    [rectPolygon(rect(0, 0, canvas.width, canvas.height))],
  );
}

/**
 * The polygon of a freeform lasso path, closed automatically between its last and first points, and
 * clipped to the canvas (TL-SEL-LASSO-01). Empty when the path encloses no area.
 */
export function lassoPolygons(points: readonly PixelPoint[], canvas: Size): SelectionPolygon[] {
  if (points.length < 3) return [];
  const ring = points.flatMap((point) => [point.x, point.y]);
  return clipPolygons(
    "intersection",
    [ring],
    [rectPolygon(rect(0, 0, canvas.width, canvas.height))],
  );
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
