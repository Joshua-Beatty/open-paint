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

/**
 * An ellipse inscribed in `r`, as a convex ring whose vertices are whole pixel corners
 * (TL-SEL-ELL-01; owner request: selections are pixel based). The ring is the convex hull of the
 * corners inside the ellipse grown by `ELLIPSE_GROWTH`, which straddles the curve (about a tenth
 * of a pixel from it on average), so its edges are straight runs between corners, with no
 * repeated, collinear or self-touching vertices. The ring reaches each side of `r`.
 */
export function ellipsePolygon(r: Rect): SelectionPolygon {
  const left = Math.ceil(r.x);
  const top = Math.ceil(r.y);
  const right = Math.floor(r.x + r.width);
  const bottom = Math.floor(r.y + r.height);
  if (right <= left || bottom <= top) return rectPolygon(r);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const rx = r.width / 2 + ELLIPSE_GROWTH;
  const ry = r.height / 2 + ELLIPSE_GROWTH;
  const corners: [number, number][] = [];
  // The corners in each column and each row: every corner inside lies between the ends of its
  // column, so the hull of the ends is the hull of them all. Columns and rows both count, so a
  // thin ellipse keeps its far ends.
  const span = (
    from: number,
    to: number,
    center: number,
    radius: number,
    across: number,
    acrossRadius: number,
    min: number,
    max: number,
    put: (along: number, at: number) => void,
  ) => {
    for (let along = from; along <= to; along++) {
      const t = (along - center) / radius;
      const reach = acrossRadius * Math.sqrt(Math.max(0, 1 - t * t));
      let lo = Math.max(min, Math.ceil(across - reach));
      let hi = Math.min(max, Math.floor(across + reach));
      if (lo > hi) {
        if (along !== from && along !== to) continue;
        // The ellipse's far end falls between corners: the two nearest stand for it.
        lo = Math.max(min, Math.floor(across));
        hi = Math.min(max, Math.ceil(across));
      }
      put(along, lo);
      if (hi !== lo) put(along, hi);
    }
  };
  span(left, right, cx, rx, cy, ry, top, bottom, (x, y) =>
    corners.push([normalizeZero(x), normalizeZero(y)]),
  );
  span(top, bottom, cy, ry, cx, rx, left, right, (y, x) =>
    corners.push([normalizeZero(x), normalizeZero(y)]),
  );
  const hull = convexHull(corners);
  if (hull.length < 3) return rectPolygon(r);
  return hull.flat();
}

/**
 * How far the ellipse is grown, in pixels, before the corners inside it are taken: the hull of
 * the corners inside the exact ellipse lies within it, and this growth centres the hull on it.
 */
const ELLIPSE_GROWTH = 0.25;

/** The convex hull of `points`, counter-clockwise on screen, without collinear points. */
function convexHull(points: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) =>
    ((a[0] ?? 0) - (o[0] ?? 0)) * ((b[1] ?? 0) - (o[1] ?? 0)) -
    ((a[1] ?? 0) - (o[1] ?? 0)) * ((b[0] ?? 0) - (o[0] ?? 0));
  const chain = (list: readonly (readonly [number, number])[]) => {
    const out: [number, number][] = [];
    for (const p of list) {
      while (out.length >= 2) {
        const a = out[out.length - 2] as [number, number];
        const b = out[out.length - 1] as [number, number];
        if (cross(a, b, p) > 0) break;
        out.pop();
      }
      out.push([p[0], p[1]]);
    }
    out.pop();
    return out;
  };
  return [...chain(sorted), ...chain([...sorted].reverse())];
}

/** The smallest integer rectangle that covers every vertex (DOC-SEL-01 bounds). */
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

/**
 * A polygon set normalized onto whole pixel corners (owner request: selections are pixel based).
 * Every vertex goes to its nearest pixel corner, the rings are unioned again on the pixel grid,
 * so edges that crossed after rounding meet at a corner too, and repeated and collinear vertices
 * are dropped. Each edge then runs straight between two pixel corners, at any slope.
 */
export function pixelPolygons(polygons: readonly SelectionPolygon[]): SelectionPolygon[] {
  const subject = toPaths(polygons, 1);
  return fromPaths(Clipper.Union(subject, new Paths64(), FillRule.EvenOdd), 1, true);
}

/** Whether every vertex of the set is a whole pixel corner. */
export function onPixelCorners(polygons: readonly SelectionPolygon[]): boolean {
  return polygons.every((polygon) => polygon.every((value) => Number.isInteger(value)));
}

function* vertices(polygon: SelectionPolygon): Generator<readonly [number, number]> {
  for (let i = 0; i + 1 < polygon.length; i += 2) {
    yield [polygon[i] ?? 0, polygon[i + 1] ?? 0];
  }
}

function scaled(value: number, scale: number): number {
  if (!Number.isFinite(value) || Math.abs(value * CLIPPER_SCALE) > MAX_SCALED_COORDINATE) {
    throw new RangeError("Selection coordinates must lie within 262,144 px of the origin.");
  }
  return Math.round(value * scale);
}

function toPaths(polygons: readonly SelectionPolygon[], scale = CLIPPER_SCALE): Paths64 {
  const paths = new Paths64();
  for (const polygon of polygons) {
    const path = new Path64();
    const ring = dedupeRing(
      [...vertices(polygon)].map(([x, y]) => [scaled(x, scale), scaled(y, scale)]),
    );
    for (const [x, y] of ring) path.push({ x, y });
    paths.push(path);
  }
  return paths;
}

/**
 * The JS port can emit each corner twice and keep degenerate rings, so the output is cleaned:
 * repeated vertices go (and, with `straight`, vertices on a straight run between their
 * neighbours), and rings with fewer than three points or no area are dropped.
 */
function fromPaths(paths: Paths64, scale = CLIPPER_SCALE, straight = false): SelectionPolygon[] {
  const rings: SelectionPolygon[] = [];
  for (const path of paths) {
    let ring = dedupeRing(path.map((point) => [point.x, point.y]));
    if (straight) ring = dropCollinear(ring);
    if (ring.length < 3) continue;
    const flat: number[] = [];
    for (const [x, y] of ring) flat.push(unscale(x, scale), unscale(y, scale));
    if (polygonsArea([flat]) > 0) rings.push(flat);
  }
  return rings;
}

/** Twice the signed area of the triangle `o`, `a`, `b`: zero when the three are collinear. */
function turn(
  o: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * The ring without vertices that lie on the line through their neighbours, which also removes
 * zero-width spikes. Integer coordinates keep the test exact.
 */
function dropCollinear(
  ring: readonly (readonly [number, number])[],
): (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  for (const point of ring) {
    while (out.length >= 2) {
      const a = out[out.length - 2] as readonly [number, number];
      const b = out[out.length - 1] as readonly [number, number];
      if (turn(a, b, point) !== 0) break;
      out.pop();
    }
    out.push(point);
  }
  let changed = true;
  while (changed && out.length >= 3) {
    changed = false;
    const n = out.length;
    if (
      turn(
        out[n - 2] as [number, number],
        out[n - 1] as [number, number],
        out[0] as [number, number],
      ) === 0
    ) {
      out.pop();
      changed = true;
      continue;
    }
    if (
      turn(
        out[n - 1] as [number, number],
        out[0] as [number, number],
        out[1] as [number, number],
      ) === 0
    ) {
      out.shift();
      changed = true;
    }
  }
  return out;
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

function unscale(value: number, scale: number): number {
  return normalizeZero(value / scale);
}

/** `-0` becomes `0`, so that coordinates compare and print the same way. */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}
