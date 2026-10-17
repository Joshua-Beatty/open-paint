/** Integer pixel coordinate. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Axis-aligned integer rectangle; covers pixels `x..x+width-1` by `y..y+height-1`. */
export interface Rect extends Point, Size {}

export const EMPTY_RECT: Rect = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

/** Builds a rectangle from inclusive-exclusive edges; inverted edges give an empty rectangle. */
export function rectFromEdges(left: number, top: number, right: number, bottom: number): Rect {
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function isEmptyRect(r: Rect): boolean {
  return r.width <= 0 || r.height <= 0;
}

export function isIntegerRect(r: Rect): boolean {
  return (
    Number.isInteger(r.x) &&
    Number.isInteger(r.y) &&
    Number.isInteger(r.width) &&
    Number.isInteger(r.height)
  );
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function rectArea(r: Rect): number {
  return isEmptyRect(r) ? 0 : r.width * r.height;
}

export function intersectRects(a: Rect, b: Rect): Rect {
  return rectFromEdges(
    Math.max(a.x, b.x),
    Math.max(a.y, b.y),
    Math.min(a.x + a.width, b.x + b.width),
    Math.min(a.y + a.height, b.y + b.height),
  );
}

/** Smallest rectangle containing both; empty inputs are ignored. */
export function unionRects(a: Rect, b: Rect): Rect {
  if (isEmptyRect(a)) return isEmptyRect(b) ? EMPTY_RECT : b;
  if (isEmptyRect(b)) return a;
  return rectFromEdges(
    Math.min(a.x, b.x),
    Math.min(a.y, b.y),
    Math.max(a.x + a.width, b.x + b.width),
    Math.max(a.y + a.height, b.y + b.height),
  );
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}

export function rectContainsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}

/** True when `inner` lies entirely inside `outer`. An empty `inner` is always contained. */
export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    isEmptyRect(inner) ||
    (inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height)
  );
}

/** Smallest integer rectangle covering a rectangle with fractional edges. */
export function roundOutRect(r: Rect): Rect {
  return rectFromEdges(
    Math.floor(r.x),
    Math.floor(r.y),
    Math.ceil(r.x + r.width),
    Math.ceil(r.y + r.height),
  );
}
