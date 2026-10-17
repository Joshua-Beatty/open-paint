/**
 * The pure geometry of the Line / Curve tool (TL-LINE-01): the control points, the curve types, the
 * flattened path, and the stroke pieces that draw it with dashes, caps and arrowheads. Coordinates
 * are canvas pixels. Nothing here touches pixels, so the app rasterizes the pieces and fills them.
 */

/** A point in canvas pixels, which need not be whole. */
export interface LinePoint {
  readonly x: number;
  readonly y: number;
}

/** The curve types of TL-LINE-01 (`shapes.curveType`), in settings order. */
export const CURVE_KINDS = ["Straight", "Spline", "Bezier"] as const;
export type CurveKind = (typeof CURVE_KINDS)[number];

/** The dash styles of TL-OPT-PEN (`pen.dashStyle`), in settings order. */
export const DASH_STYLES = ["Solid", "Dashes", "Dotted", "DashDot", "DashDotDot"] as const;
export type DashStyle = (typeof DASH_STYLES)[number];

/** The start and end caps of TL-OPT-PEN (`pen.startCap`, `pen.endCap`), in settings order. */
export const CAP_STYLES = ["Flat", "Arrow", "ArrowFilled", "Rounded"] as const;
export type CapStyle = (typeof CAP_STYLES)[number];

/**
 * An interior control point. It sits at `t` along the line from start to end until it is dragged,
 * after which `at` holds its place, so moving an endpoint keeps an untouched control on the line.
 */
export interface ControlPoint {
  readonly t: number;
  readonly at?: LinePoint;
}

/** A line or curve: its two endpoints and its two interior control points (TL-LINE-01). */
export interface LineCurve {
  readonly start: LinePoint;
  readonly end: LinePoint;
  readonly controls: readonly [ControlPoint, ControlPoint];
}

/** The flattening tolerance of curves, in pixels (TL-LINE-01). */
export const CURVE_TOLERANCE = 0.1;

/** The arrowhead width and length, in pen widths (TL-LINE-01, SHOULD). */
export const ARROWHEAD_SCALE = 5;

/** The Shift step of the line angle, in degrees (TL-LINE-01). */
const ANGLE_STEP = Math.PI / 12;

/**
 * The dash pattern of each style, in pen widths: dash, gap, dash, gap and so on. The lengths are
 * proposals, since the spec leaves them open.
 */
const DASH_UNITS: Readonly<Record<DashStyle, readonly number[]>> = {
  Solid: [],
  Dashes: [4, 2],
  Dotted: [1, 2],
  DashDot: [4, 2, 1, 2],
  DashDotDot: [4, 2, 1, 2, 1, 2],
};

const ORIGIN: LinePoint = { x: 0, y: 0 };

/** One drawn shape: rings combined with the even-odd rule, as the selection rasterizer does. */
export type StrokeShape = readonly (readonly LinePoint[])[];

/** The stroke's pen (TL-OPT-PEN): its width in pixels, dash style and caps. */
export interface StrokeStyle {
  readonly width: number;
  readonly dash: DashStyle;
  readonly startCap: CapStyle;
  readonly endCap: CapStyle;
}

/** A line or curve through `curve`, with the control points where the curve type uses them. */
export function createLine(start: LinePoint, end: LinePoint): LineCurve {
  return { start, end, controls: [{ t: 1 / 3 }, { t: 2 / 3 }] };
}

/** The place of a control point: its dragged position, or its place along the line. */
export function controlPosition(curve: LineCurve, index: 0 | 1): LinePoint {
  const control = curve.controls[index];
  if (control.at !== undefined) return control.at;
  return lerp(curve.start, curve.end, control.t);
}

/** The four control points in order: start, the two interior points and end. */
export function controlPoints(curve: LineCurve): [LinePoint, LinePoint, LinePoint, LinePoint] {
  return [curve.start, controlPosition(curve, 0), controlPosition(curve, 1), curve.end];
}

/** Moves one interior control point to `at`. The other points keep their places. */
export function moveControl(curve: LineCurve, index: 0 | 1, at: LinePoint): LineCurve {
  const controls = [...curve.controls] as [ControlPoint, ControlPoint];
  controls[index] = { t: curve.controls[index].t, at };
  return { start: curve.start, end: curve.end, controls };
}

/** The curve moved by (`dx`, `dy`): its endpoints and any dragged control points. */
export function translateLine(curve: LineCurve, dx: number, dy: number): LineCurve {
  const move = (point: LinePoint): LinePoint => ({ x: point.x + dx, y: point.y + dy });
  const [first, second] = curve.controls;
  const control = (c: ControlPoint): ControlPoint =>
    c.at === undefined ? { t: c.t } : { t: c.t, at: move(c.at) };
  return {
    start: move(curve.start),
    end: move(curve.end),
    controls: [control(first), control(second)],
  };
}

/** The distance from `p` to the nearest point of an open polyline. */
export function distanceToPolyline(points: readonly LinePoint[], p: LinePoint): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[i + 1] ?? a;
    if (a === undefined || b === undefined) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t =
      length === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/** An endpoint on the center of its pixel, so a one-pixel line lies on whole pixels (TL-LINE-01). */
export function snapToPixelCenter(point: LinePoint): LinePoint {
  return { x: Math.floor(point.x) + 0.5, y: Math.floor(point.y) + 0.5 };
}

/**
 * The point at the same distance from `anchor` as `point`, with its angle snapped to 15° steps.
 * Shift uses it for the line angle (TL-LINE-01).
 */
export function constrainAngle(anchor: LinePoint, point: LinePoint): LinePoint {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return point;
  const angle = Math.round(Math.atan2(dy, dx) / ANGLE_STEP) * ANGLE_STEP;
  return { x: anchor.x + Math.cos(angle) * length, y: anchor.y + Math.sin(angle) * length };
}

/** The live measurements of a line, in whole pixels and degrees (TL-LINE-01). */
export interface LineMeasure {
  readonly dx: number;
  readonly dy: number;
  readonly length: number;
  readonly angle: number;
}

/** The offset, length and angle from `start` to `end`. The angle runs clockwise from +x, in [0, 360). */
export function lineMeasure(start: LinePoint, end: LinePoint): LineMeasure {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  return {
    dx: Math.round(dx) || 0,
    dy: Math.round(dy) || 0,
    length: Math.round(Math.hypot(dx, dy)) || 0,
    angle: Math.round((degrees + 360) % 360) % 360,
  };
}

/**
 * The polyline of a curve, flattened to within CURVE_TOLERANCE pixels (TL-LINE-01). Straight joins
 * the endpoints. Spline runs a centripetal Catmull-Rom curve through all four points. Bezier is the
 * cubic whose two interior points are its control points. Consecutive duplicates are removed.
 */
export function curveSamples(
  points: readonly [LinePoint, LinePoint, LinePoint, LinePoint],
  kind: CurveKind,
): LinePoint[] {
  const [p0, p1, p2, p3] = points;
  if (kind === "Straight") return dedupe([p0, p3]);
  if (kind === "Bezier") {
    const out: LinePoint[] = [p0];
    flattenCubic(p0, p1, p2, p3, out);
    return dedupe(out);
  }
  const ghostStart = { x: 2 * p0.x - p1.x, y: 2 * p0.y - p1.y };
  const ghostEnd = { x: 2 * p3.x - p2.x, y: 2 * p3.y - p2.y };
  const through = [ghostStart, p0, p1, p2, p3, ghostEnd];
  const out: LinePoint[] = [p0];
  for (let i = 1; i <= 3; i++) {
    const [b0, b1, b2, b3] = centripetalCubic(
      through[i - 1] ?? p0,
      through[i] ?? p0,
      through[i + 1] ?? p3,
      through[i + 2] ?? p3,
    );
    flattenCubic(b0, b1, b2, b3, out);
  }
  return dedupe(out);
}

/**
 * The pieces that draw a polyline with a pen: one quad per flattened segment, one disc per interior
 * vertex, and the caps. Dashes split the path, and arrowheads shorten the body by their length so
 * the shaft ends at the arrow's base. Pieces overlap at joints, so the caller combines their
 * coverage with a maximum (never a sum). A polyline with no length gives no pieces.
 */
export function strokeShapes(input: readonly LinePoint[], style: StrokeStyle): StrokeShape[] {
  const poly = dedupe(input);
  if (poly.length < 2) return [];
  const width = Math.max(style.width, 1);
  const half = width / 2;
  const cumulative = [0];
  for (let i = 1; i < poly.length; i++) {
    cumulative.push((cumulative[i - 1] ?? 0) + distance(poly[i - 1] ?? ORIGIN, poly[i] ?? ORIGIN));
  }
  const total = cumulative[cumulative.length - 1] ?? 0;
  if (total === 0) return [];

  const arrowLength = ARROWHEAD_SCALE * width;
  const trimStart = isArrow(style.startCap) ? Math.min(arrowLength, total / 2) : 0;
  const trimEnd = isArrow(style.endCap) ? Math.min(arrowLength, total / 2) : 0;
  const shapes: StrokeShape[] = [];
  for (const [a, b] of dashIntervals(trimStart, total - trimEnd, style.dash, width)) {
    shapes.push(...bodyShapes(subPolyline(poly, cumulative, a, b), half));
  }
  const first = poly[0] ?? ORIGIN;
  const second = poly[1] ?? ORIGIN;
  const last = poly[poly.length - 1] ?? ORIGIN;
  const beforeLast = poly[poly.length - 2] ?? ORIGIN;
  shapes.push(
    ...capShapes(
      first,
      unit({ x: first.x - second.x, y: first.y - second.y }),
      style.startCap,
      width,
    ),
  );
  shapes.push(
    ...capShapes(
      last,
      unit({ x: last.x - beforeLast.x, y: last.y - beforeLast.y }),
      style.endCap,
      width,
    ),
  );
  return shapes;
}

/** The intervals of arc length that are inked, from `start` to `end`, for a dash style. */
function dashIntervals(
  start: number,
  end: number,
  dash: DashStyle,
  width: number,
): [number, number][] {
  if (end <= start) return [];
  const pattern = DASH_UNITS[dash].map((units) => units * width);
  if (pattern.length === 0) return [[start, end]];
  const out: [number, number][] = [];
  let position = start;
  for (let i = 0; position < end; i++) {
    const length = pattern[i % pattern.length] ?? width;
    if (i % 2 === 0) out.push([position, Math.min(position + length, end)]);
    position += length;
  }
  return out;
}

/**
 * The quads and joint discs of one inked run of the path, whose ends are flat: each end is the
 * line through the run's endpoint perpendicular to its end segment. A joint disc or an extended
 * quad close to an end would reach past that line, so the pieces within one pen width (of arc
 * length) of an end are clipped to it.
 */
function bodyShapes(run: readonly LinePoint[], half: number): StrokeShape[] {
  const segments = run.length - 1;
  const arc = [0];
  for (let j = 1; j < run.length; j++) {
    arc.push((arc[j - 1] ?? 0) + distance(run[j - 1] ?? ORIGIN, run[j] ?? ORIGIN));
  }
  const total = arc[segments] ?? 0;
  const first = run[0] ?? ORIGIN;
  const last = run[segments] ?? ORIGIN;
  const inward = unit(subtract(firstDistinct(run, first, 1), first));
  const outward = unit(subtract(last, firstDistinct(run, last, -1)));
  const reach = half * 2;
  /** The piece `ring` spanning arc length `a` to `b`, clipped to the flat ends near it. */
  const clipped = (ring: LinePoint[], a: number, b: number): LinePoint[] => {
    let out = ring;
    if (a < reach) out = clipHalfPlane(out, first, inward);
    if (total - b < reach) out = clipHalfPlane(out, last, scale(outward, -1));
    return out;
  };
  const shapes: StrokeShape[] = [];
  for (let j = 0; j < segments; j++) {
    const p = run[j] ?? ORIGIN;
    const q = run[j + 1] ?? ORIGIN;
    const d = unit({ x: q.x - p.x, y: q.y - p.y });
    if (d.x === 0 && d.y === 0) continue;
    // A joint extends each side of the segment by one pixel, so the neighbors overlap there.
    const from = j > 0 ? { x: p.x - d.x, y: p.y - d.y } : p;
    const to = j < segments - 1 ? { x: q.x + d.x, y: q.y + d.y } : q;
    const n = { x: -d.y * half, y: d.x * half };
    const quad = [
      { x: from.x + n.x, y: from.y + n.y },
      { x: to.x + n.x, y: to.y + n.y },
      { x: to.x - n.x, y: to.y - n.y },
      { x: from.x - n.x, y: from.y - n.y },
    ];
    const ring = clipped(quad, (arc[j] ?? 0) - 1, (arc[j + 1] ?? 0) + 1);
    if (ring.length >= 3) shapes.push([ring]);
  }
  for (let j = 1; j < segments; j++) {
    const s = arc[j] ?? 0;
    const ring = clipped(disc(run[j] ?? ORIGIN, half), s - half, s + half);
    if (ring.length >= 3) shapes.push([ring]);
  }
  return shapes;
}

/** The first point of `run` from its start (`step` 1) or end (`step` −1) that is not `from`. */
function firstDistinct(run: readonly LinePoint[], from: LinePoint, step: 1 | -1): LinePoint {
  const start = step === 1 ? 1 : run.length - 2;
  for (let i = start; i >= 0 && i < run.length; i += step) {
    const point = run[i] ?? from;
    if (distance(point, from) > 1e-9) return point;
  }
  return from;
}

/**
 * The convex polygon `ring` clipped to the half-plane of the points `p` with
 * `(p − origin) · normal ≥ 0` (Sutherland–Hodgman).
 */
function clipHalfPlane(
  ring: readonly LinePoint[],
  origin: LinePoint,
  normal: LinePoint,
): LinePoint[] {
  if (normal.x === 0 && normal.y === 0) return [...ring];
  const side = (p: LinePoint) => (p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y;
  const out: LinePoint[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i] ?? ORIGIN;
    const q = ring[(i + 1) % ring.length] ?? ORIGIN;
    const sp = side(p);
    const sq = side(q);
    if (sp >= 0) out.push(p);
    if (sp >= 0 !== sq >= 0) out.push(lerp(p, q, sp / (sp - sq)));
  }
  return out;
}

/** The cap at one end of the stroke: nothing, a round disc, or an arrowhead (TL-OPT-PEN). */
function capShapes(
  tip: LinePoint,
  outward: LinePoint,
  cap: CapStyle,
  width: number,
): StrokeShape[] {
  if (cap === "Flat") return [];
  if (cap === "Rounded") return [[disc(tip, width / 2)]];
  return [arrowhead(tip, outward, width, cap === "ArrowFilled")];
}

/**
 * An arrowhead with its tip on `tip`, pointing along the unit vector `outward`. Its base and its
 * length are both ARROWHEAD_SCALE pen widths. The outline version is the triangle with its inscribed
 * triangle, inset by one pen width, cut out (even-odd), when the triangle is wide enough to hold it.
 */
function arrowhead(
  tip: LinePoint,
  outward: LinePoint,
  width: number,
  filled: boolean,
): StrokeShape {
  const length = ARROWHEAD_SCALE * width;
  const halfBase = (ARROWHEAD_SCALE * width) / 2;
  const base = { x: tip.x - outward.x * length, y: tip.y - outward.y * length };
  const normal = { x: -outward.y, y: outward.x };
  const left = { x: base.x + normal.x * halfBase, y: base.y + normal.y * halfBase };
  const right = { x: base.x - normal.x * halfBase, y: base.y - normal.y * halfBase };
  const outer = [tip, left, right];
  if (filled) return [outer];
  const a = distance(left, right);
  const b = distance(tip, right);
  const c = distance(tip, left);
  const perimeter = a + b + c;
  const inradius = (a * length) / perimeter;
  if (inradius <= width) return [outer];
  const center = {
    x: (a * tip.x + b * left.x + c * right.x) / perimeter,
    y: (a * tip.y + b * left.y + c * right.y) / perimeter,
  };
  const scale = (inradius - width) / inradius;
  const inner = outer.map((vertex) => lerp(center, vertex, scale));
  return [outer, inner];
}

/** A circle of `radius` around `center`, with a chord error within CURVE_TOLERANCE. */
function disc(center: LinePoint, radius: number): LinePoint[] {
  const ratio = Math.max(-1, 1 - CURVE_TOLERANCE / Math.max(radius, 1e-9));
  const count = Math.max(12, Math.ceil(Math.PI / Math.acos(ratio)));
  const out: LinePoint[] = [];
  for (let k = 0; k < count; k++) {
    const angle = (k * 2 * Math.PI) / count;
    out.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  }
  return out;
}

/** The part of the polyline from arc length `a` to `b`, with its interior vertices. */
function subPolyline(
  poly: readonly LinePoint[],
  cumulative: readonly number[],
  a: number,
  b: number,
): LinePoint[] {
  const out = [pointAt(poly, cumulative, a)];
  for (let i = 1; i < poly.length - 1; i++) {
    const s = cumulative[i] ?? 0;
    if (s > a && s < b) out.push(poly[i] ?? ORIGIN);
  }
  out.push(pointAt(poly, cumulative, b));
  return out;
}

/** The point at arc length `s`, found by a binary search over the segment ends. */
function pointAt(poly: readonly LinePoint[], cumulative: readonly number[], s: number): LinePoint {
  let lo = 0;
  let hi = poly.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((cumulative[mid] ?? 0) <= s) lo = mid;
    else hi = mid - 1;
  }
  const from = cumulative[lo] ?? 0;
  const span = (cumulative[lo + 1] ?? from) - from;
  const t = span === 0 ? 0 : Math.min(1, Math.max(0, (s - from) / span));
  return lerp(poly[lo] ?? ORIGIN, poly[lo + 1] ?? ORIGIN, t);
}

/**
 * The cubic segment between `p1` and `p2` of the centripetal Catmull-Rom curve through the four
 * points (Barry and Goldman's knots, with the square-root spacing that avoids loops).
 */
function centripetalCubic(
  p0: LinePoint,
  p1: LinePoint,
  p2: LinePoint,
  p3: LinePoint,
): [LinePoint, LinePoint, LinePoint, LinePoint] {
  const t1 = Math.sqrt(distance(p0, p1));
  const t2 = t1 + Math.sqrt(distance(p1, p2));
  const t3 = t2 + Math.sqrt(distance(p2, p3));
  const span = t2 - t1;
  const tangentStart = add(
    subtract(divide(subtract(p1, p0), t1), divide(subtract(p2, p0), t2)),
    divide(subtract(p2, p1), span),
  );
  const tangentEnd = subtract(
    add(divide(subtract(p2, p1), span), divide(subtract(p3, p2), t3 - t2)),
    divide(subtract(p3, p1), t3 - t1),
  );
  return [
    p1,
    add(p1, scale(tangentStart, span / 3)),
    subtract(p2, scale(tangentEnd, span / 3)),
    p2,
  ];
}

/**
 * Appends the points of a cubic Bezier after its start, at uniform steps. The step count is the
 * smallest that keeps the chord error of a uniform walk within CURVE_TOLERANCE (its second
 * derivative is at most 6 times the second difference of the control points).
 */
function flattenCubic(
  p0: LinePoint,
  p1: LinePoint,
  p2: LinePoint,
  p3: LinePoint,
  out: LinePoint[],
): void {
  const bend = Math.max(
    distance({ x: p0.x - 2 * p1.x + p2.x, y: p0.y - 2 * p1.y + p2.y }, ORIGIN),
    distance({ x: p1.x - 2 * p2.x + p3.x, y: p1.y - 2 * p2.y + p3.y }, ORIGIN),
  );
  const steps = Math.max(1, Math.ceil(Math.sqrt((0.75 * bend) / CURVE_TOLERANCE)));
  for (let k = 1; k < steps; k++) {
    const t = k / steps;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
  out.push(p3);
}

function isArrow(cap: CapStyle): boolean {
  return cap === "Arrow" || cap === "ArrowFilled";
}

function dedupe(points: readonly LinePoint[]): LinePoint[] {
  const out: LinePoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last === undefined || distance(last, point) > 1e-9) out.push(point);
  }
  return out;
}

function distance(a: LinePoint, b: LinePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function unit(v: LinePoint): LinePoint {
  const length = Math.hypot(v.x, v.y);
  return length === 0 ? ORIGIN : { x: v.x / length, y: v.y / length };
}

function lerp(a: LinePoint, b: LinePoint, t: number): LinePoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function add(a: LinePoint, b: LinePoint): LinePoint {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a: LinePoint, b: LinePoint): LinePoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(v: LinePoint, k: number): LinePoint {
  return { x: v.x * k, y: v.y * k };
}

/** `v / d`, with a zero denominator giving zero (the knots coincide, so the vector is zero too). */
function divide(v: LinePoint, d: number): LinePoint {
  return d === 0 ? ORIGIN : { x: v.x / d, y: v.y / d };
}
