import { Clipper, FillRule, Path64, Paths64 } from "clipper2-js";
import { EMPTY_RECT, type Rect, rectFromEdges } from "./geometry";

/**
 * A closed ring as flat coordinates `[x0, y0, x1, y1, ...]` in canvas pixels (DOC-SEL-01). The
 * ring closes implicitly from its last point back to its first.
 */
export type SelectionPolygon = readonly number[];

/** DOC-SEL-03: how the polygon becomes a clip mask. */
export type SelectionQuality = "aliased" | "antialiased";

/** DOC-SEL-03: the default selection quality. */
export const DEFAULT_SELECTION_QUALITY: SelectionQuality = "antialiased";

/** DOC-SEL-02: how a new polygon set combines with the current selection. */
export type SelectionCombineMode = "replace" | "union" | "exclude" | "intersect" | "xor";

/** A 2-D affine transform: `x' = a x + c y + e`, `y' = b x + d y + f`. */
export interface AffineMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY_AFFINE: AffineMatrix = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/**
 * Clipper2 works on integer coordinates, so polygon points are scaled by this factor and rounded
 * (1/256 px). Scaled values must stay within `MAX_SCALED_COORDINATE`, which the JS port needs to
 * keep its intermediate products exact. That limit is 262,144 px, the largest document size.
 */
const CLIPPER_SCALE = 256;
const MAX_SCALED_COORDINATE = 2 ** 26;

/** Applies `inner` first, then `outer`. */
export function composeAffine(outer: AffineMatrix, inner: AffineMatrix): AffineMatrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function transformPolygon(polygon: SelectionPolygon, m: AffineMatrix): SelectionPolygon {
  const out: number[] = [];
  for (const [x, y] of vertices(polygon)) {
    out.push(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f);
  }
  return out;
}

/** The four corners of a rectangle, clockwise from the top left. */
export function rectPolygon(r: Rect): SelectionPolygon {
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  return [r.x, r.y, right, r.y, right, bottom, r.x, bottom];
}

/** The smallest integer rectangle that covers every vertex (DOC-SEL-01 bounds). */
/**
 * An ellipse inscribed in `r`, as a closed ring. The segment count grows with the ellipse's size,
 * so the curve stays smooth at any zoom (TL-SEL-ELL-01).
 */
export function ellipsePolygon(r: Rect): SelectionPolygon {
  const segments = Math.min(1024, Math.max(32, Math.ceil((Math.PI * (r.width + r.height)) / 4)));
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const rx = r.width / 2;
  const ry = r.height / 2;
  const ring: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    ring.push(cx + rx * Math.cos(angle), cy + ry * Math.sin(angle));
  }
  return ring;
}

export function polygonsBounds(polygons: readonly SelectionPolygon[]): Rect {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    for (const [x, y] of vertices(polygon)) {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (left > right) return EMPTY_RECT;
  return rectFromEdges(
    normalizeZero(Math.floor(left)),
    normalizeZero(Math.floor(top)),
    normalizeZero(Math.ceil(right)),
    normalizeZero(Math.ceil(bottom)),
  );
}

/** The exact area of the polygon set, in square pixels. The set must be normalized. */
export function polygonsArea(polygons: readonly SelectionPolygon[]): number {
  let twiceArea = 0;
  for (const polygon of polygons) {
    const points = [...vertices(polygon)];
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i] ?? [0, 0];
      const [x1, y1] = points[(i + 1) % points.length] ?? [0, 0];
      twiceArea += x0 * y1 - x1 * y0;
    }
  }
  return Math.abs(twiceArea) / 2;
}

export type ClipOperation = "union" | "difference" | "intersection" | "xor";

/**
 * Boolean operation on two polygon sets with the even-odd fill rule applied to each set
 * (DOC-SEL-01). The result is normalized: its rings do not overlap, and holes are separate rings.
 */
export function clipPolygons(
  operation: ClipOperation,
  subject: readonly SelectionPolygon[],
  clip: readonly SelectionPolygon[],
): SelectionPolygon[] {
  const s = toPaths(subject);
  const c = toPaths(clip);
  const rule = FillRule.EvenOdd;
  switch (operation) {
    case "union":
      return fromPaths(Clipper.Union(s, c, rule));
    case "difference":
      return fromPaths(Clipper.Difference(s, c, rule));
    case "intersection":
      return fromPaths(Clipper.Intersect(s, c, rule));
    case "xor":
      return fromPaths(Clipper.Xor(s, c, rule));
  }
}

/** Normalizes a raw polygon set so that its rings are free of self-overlap. */
export function normalizePolygons(polygons: readonly SelectionPolygon[]): SelectionPolygon[] {
  return clipPolygons("union", polygons, []);
}

function* vertices(polygon: SelectionPolygon): Generator<readonly [number, number]> {
  for (let i = 0; i + 1 < polygon.length; i += 2) {
    yield [polygon[i] ?? 0, polygon[i + 1] ?? 0];
  }
}

function scaled(value: number): number {
  const s = Math.round(value * CLIPPER_SCALE);
  if (!Number.isFinite(s) || Math.abs(s) > MAX_SCALED_COORDINATE) {
    throw new RangeError("Selection coordinates must lie within 262,144 px of the origin.");
  }
  return s;
}

function toPaths(polygons: readonly SelectionPolygon[]): Paths64 {
  const paths = new Paths64();
  for (const polygon of polygons) {
    const path = new Path64();
    const ring = dedupeRing([...vertices(polygon)].map(([x, y]) => [scaled(x), scaled(y)]));
    for (const [x, y] of ring) path.push({ x, y });
    paths.push(path);
  }
  return paths;
}

/**
 * The JS port can emit each corner twice and keep degenerate rings, so the output is cleaned:
 * repeated vertices go, and rings with fewer than three points or no area are dropped.
 */
function fromPaths(paths: Paths64): SelectionPolygon[] {
  const rings: SelectionPolygon[] = [];
  for (const path of paths) {
    const ring = dedupeRing(path.map((point) => [point.x, point.y]));
    if (ring.length < 3) continue;
    const flat: number[] = [];
    for (const [x, y] of ring) flat.push(unscale(x), unscale(y));
    if (polygonsArea([flat]) > 0) rings.push(flat);
  }
  return rings;
}

/** Removes consecutive repeated points, including a last point equal to the first. */
function dedupeRing(points: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  const ring: (readonly [number, number])[] = [];
  for (const point of points) {
    const last = ring[ring.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) ring.push(point);
  }
  while (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) break;
    ring.pop();
  }
  return ring;
}

function unscale(value: number): number {
  return normalizeZero(value / CLIPPER_SCALE);
}

/** `-0` becomes `0`, so that coordinates compare and print the same way. */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}
