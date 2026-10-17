import type { LinePoint } from "./line-curve";

/** A shape's drag rectangle in canvas pixels. */
export interface ShapeBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The property handle values a shape path reads (TL-SHAPE-01). `radius` is a length in pixels, and
 * `tailX` and `tailY` are unit-square coordinates.
 */
export type ShapeParams = Readonly<Record<string, number>>;

/** The corners of a drawn box, in canvas pixels. Corners sit on pixel corners (TL-SHAPE-01). */
export interface DragBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A path outline in a unit square, with its natural aspect ratio. */
export interface ShapeOutline {
  readonly path: string;
  readonly aspect: number;
}

/** A token is `{name}`, `{name.x}` or `{name.y}`, with an optional `1-` before the name. */
const TOKEN = /\{(1-)?([A-Za-z][A-Za-z0-9]*)(?:\.([xy]))?\}/g;

/** The path tokens: a command letter, or a number. */
const PATH_TOKEN = /[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** The number of decimals a substituted coordinate keeps. */
const DECIMALS = 9;

/**
 * Replaces the tokens of a path template with numbers in unit-square coordinates. A plain token
 * takes the parameter as it is. A `.x` or `.y` token takes a pixel length, clamped to half the
 * shorter side and divided by the box width or height, so a corner radius stays circular. A `1-`
 * token takes the complement of the value.
 */
export function substituteShapePath(path: string, box: ShapeBox, params: ShapeParams): string {
  return path.replace(
    TOKEN,
    (_match, complement: string | undefined, name: string, axis: string | undefined) => {
      const raw = params[name];
      if (raw === undefined || !Number.isFinite(raw)) {
        throw new Error(`Shape path token "${name}" has no value.`);
      }
      let value = raw;
      if (axis !== undefined) {
        const length = Math.min(Math.max(raw, 0), Math.min(box.width, box.height) / 2);
        value = length / (axis === "x" ? box.width : box.height);
      }
      return (complement === undefined ? value : 1 - value).toFixed(DECIMALS);
    },
  );
}

/** The segment count of a curve, from its length in pixels. */
function segmentCount(length: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.ceil(length / 2)));
}

function distance(a: LinePoint, b: LinePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** The points of a cubic Bezier after its start, ending on `end` (pixels). */
function cubicPoints(
  start: LinePoint,
  first: LinePoint,
  second: LinePoint,
  end: LinePoint,
): LinePoint[] {
  const length = distance(start, first) + distance(first, second) + distance(second, end);
  const count = segmentCount(length, 8, 256);
  const points: LinePoint[] = [];
  for (let k = 1; k <= count; k++) {
    const t = k / count;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    points.push({
      x: a * start.x + b * first.x + c * second.x + d * end.x,
      y: a * start.y + b * first.y + c * second.y + d * end.y,
    });
  }
  return points;
}

/** The angle from vector `u` to vector `v`, signed as in the SVG arc specification (F.6.5). */
function vectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
  return sign * Math.acos(Math.min(1, Math.max(-1, cos)));
}

/**
 * The points of an unrotated elliptical arc after its start, ending on `end` (pixels). The endpoint
 * form of the SVG specification (F.6.5) gives the center. Radii too small for the endpoints scale up.
 */
function arcPoints(
  start: LinePoint,
  end: LinePoint,
  radiusX: number,
  radiusY: number,
  largeArc: boolean,
  sweep: boolean,
): LinePoint[] {
  let rx = Math.abs(radiusX);
  let ry = Math.abs(radiusY);
  const halfDx = (start.x - end.x) / 2;
  const halfDy = (start.y - end.y) / 2;
  const lambda = (halfDx * halfDx) / (rx * rx) + (halfDy * halfDy) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * halfDy * halfDy - ry * ry * halfDx * halfDx;
  const denominator = rx * rx * halfDy * halfDy + ry * ry * halfDx * halfDx;
  let coefficient = Math.sqrt(Math.max(0, numerator / denominator));
  if (largeArc === sweep) coefficient = -coefficient;
  const cx = (coefficient * rx * halfDy) / ry + (start.x + end.x) / 2;
  const cy = (-coefficient * ry * halfDx) / rx + (start.y + end.y) / 2;
  const startX = (halfDx - (coefficient * rx * halfDy) / ry) / rx;
  const startY = (halfDy + (coefficient * ry * halfDx) / rx) / ry;
  const endX = (-halfDx - (coefficient * rx * halfDy) / ry) / rx;
  const endY = (-halfDy + (coefficient * ry * halfDx) / rx) / ry;
  const from = vectorAngle(1, 0, startX, startY);
  let turn = vectorAngle(startX, startY, endX, endY);
  if (!sweep && turn > 0) turn -= 2 * Math.PI;
  if (sweep && turn < 0) turn += 2 * Math.PI;
  const count = segmentCount(Math.abs(turn) * Math.max(rx, ry), 4, 256);
  const points: LinePoint[] = [];
  for (let k = 1; k < count; k++) {
    const angle = from + (turn * k) / count;
    points.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
  }
  points.push(end);
  return points;
}

/** Drops consecutive duplicates, and a last point that repeats the first (the ring closes itself). */
function cleanRing(ring: readonly LinePoint[]): LinePoint[] {
  const cleaned: LinePoint[] = [];
  for (const point of ring) {
    const last = cleaned[cleaned.length - 1];
    if (last === undefined || last.x !== point.x || last.y !== point.y) cleaned.push(point);
  }
  const first = cleaned[0];
  const last = cleaned[cleaned.length - 1];
  if (cleaned.length > 1 && first !== undefined && last !== undefined) {
    if (first.x === last.x && first.y === last.y) cleaned.pop();
  }
  return cleaned;
}

/**
 * The rings of a shape path drawn into a box (TL-SHAPE-02). The path is in a unit square, so each
 * unit coordinate maps to the box, and each arc radius scales by the box's width and height. Tokens
 * are substituted first (see `substituteShapePath`). Supports the absolute commands M, L, H, V, C,
 * Q, A and Z, with arcs that have no rotation. The result is empty for a box with no area.
 */
export function shapeRings(path: string, box: ShapeBox, params: ShapeParams): LinePoint[][] {
  if (!(box.width > 0 && box.height > 0)) return [];
  const tokens = substituteShapePath(path, box, params).match(PATH_TOKEN) ?? [];
  const toPixels = (point: LinePoint): LinePoint => ({
    x: box.x + point.x * box.width,
    y: box.y + point.y * box.height,
  });
  const isNumber = (index: number) => {
    const token = tokens[index];
    return token !== undefined && !/^[A-Za-z]$/.test(token);
  };
  let index = 0;
  const number = (): number => {
    if (!isNumber(index)) throw new Error(`Shape path "${path}" is missing a number.`);
    return Number(tokens[index++]);
  };
  const pair = (): LinePoint => ({ x: number(), y: number() });

  const rings: LinePoint[][] = [];
  let ring: LinePoint[] = [];
  let current: LinePoint = { x: 0, y: 0 };
  let subpathStart: LinePoint = current;
  /** The point the next segment starts from, in pixels. A ring that has no points yet starts there. */
  const pen = (): LinePoint[] => {
    if (ring.length === 0) ring.push(toPixels(current));
    return ring;
  };
  const closeRing = () => {
    if (ring.length > 0) rings.push(cleanRing(ring));
    ring = [];
  };

  while (index < tokens.length) {
    const letter = tokens[index++] ?? "";
    if (!/^[MLHVCQAZ]$/.test(letter)) {
      throw new Error(`Shape path "${path}" has an unsupported command "${letter}".`);
    }
    let command = letter;
    do {
      switch (command) {
        case "M": {
          const to = pair();
          closeRing();
          current = to;
          subpathStart = to;
          ring = [toPixels(to)];
          command = "L";
          break;
        }
        case "L": {
          const to = pair();
          pen().push(toPixels(to));
          current = to;
          break;
        }
        case "H": {
          const to = { x: number(), y: current.y };
          pen().push(toPixels(to));
          current = to;
          break;
        }
        case "V": {
          const to = { x: current.x, y: number() };
          pen().push(toPixels(to));
          current = to;
          break;
        }
        case "C": {
          const first = pair();
          const second = pair();
          const to = pair();
          pen().push(
            ...cubicPoints(toPixels(current), toPixels(first), toPixels(second), toPixels(to)),
          );
          current = to;
          break;
        }
        case "Q": {
          const control = pair();
          const to = pair();
          const start = current;
          const first = {
            x: start.x + (2 / 3) * (control.x - start.x),
            y: start.y + (2 / 3) * (control.y - start.y),
          };
          const second = {
            x: to.x + (2 / 3) * (control.x - to.x),
            y: to.y + (2 / 3) * (control.y - to.y),
          };
          pen().push(
            ...cubicPoints(toPixels(start), toPixels(first), toPixels(second), toPixels(to)),
          );
          current = to;
          break;
        }
        case "A": {
          const radiusX = number() * box.width;
          const radiusY = number() * box.height;
          const rotation = number();
          const largeArc = number() !== 0;
          const sweep = number() !== 0;
          const to = pair();
          if (rotation !== 0) throw new Error("Rotated arcs are not supported in shape paths.");
          const target = pen();
          const from = target[target.length - 1] ?? toPixels(current);
          const end = toPixels(to);
          if (radiusX === 0 || radiusY === 0) target.push(end);
          else target.push(...arcPoints(from, end, radiusX, radiusY, largeArc, sweep));
          current = to;
          break;
        }
        default: {
          closeRing();
          current = subpathStart;
          break;
        }
      }
    } while (command !== "Z" && isNumber(index));
  }
  closeRing();
  return rings;
}

/** Fits the vertices to the unit square and reads the natural aspect ratio. */
function outlineOf(vertices: readonly LinePoint[]): ShapeOutline {
  const xs = vertices.map((point) => point.x);
  const ys = vertices.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - top;
  const commands = vertices.map((point, index) => {
    const x = ((point.x - left) / width).toFixed(6);
    const y = ((point.y - top) / height).toFixed(6);
    return `${index === 0 ? "M" : "L"} ${x},${y}`;
  });
  return { path: `${commands.join(" ")} Z`, aspect: width / height };
}

/** A regular polygon with `sides` sides, with a vertex at `startDegrees` (0 is to the right). */
export function regularPolygon(sides: number, startDegrees: number): ShapeOutline {
  const vertices: LinePoint[] = [];
  for (let k = 0; k < sides; k++) {
    const angle = ((startDegrees + (360 * k) / sides) * Math.PI) / 180;
    vertices.push({ x: Math.cos(angle), y: Math.sin(angle) });
  }
  return outlineOf(vertices);
}

/**
 * A star with `points` points. The vertices alternate between the outer radius and the inner
 * radius, which is `innerRatio` times the outer one (TL-SHAPE-02).
 */
export function starPolygon(
  points: number,
  innerRatio: number,
  startDegrees: number,
): ShapeOutline {
  const vertices: LinePoint[] = [];
  for (let k = 0; k < points * 2; k++) {
    const radius = k % 2 === 0 ? 1 : innerRatio;
    const angle = ((startDegrees + (180 * k) / points) * Math.PI) / 180;
    vertices.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  return outlineOf(vertices);
}

/**
 * The box a drag from `anchor` to `point` draws (TL-SHAPE-01). Corners snap to whole pixel corners.
 * Shift keeps the aspect ratio and grows the box to hold the point. `fromCenter` (Alt) makes the
 * anchor the center.
 */
export function dragBox(
  anchor: LinePoint,
  point: LinePoint,
  options: { readonly aspect: number; readonly constrain: boolean; readonly fromCenter: boolean },
): DragBox {
  const from = { x: Math.round(anchor.x), y: Math.round(anchor.y) };
  let dx = Math.round(point.x) - from.x;
  let dy = Math.round(point.y) - from.y;
  if (options.constrain) {
    const half = Math.max(Math.abs(dy), Math.abs(dx) / options.aspect);
    dx = Math.round((dx < 0 ? -1 : 1) * half * options.aspect);
    dy = Math.round((dy < 0 ? -1 : 1) * half);
  }
  const far = { x: from.x + dx, y: from.y + dy };
  const near = options.fromCenter ? { x: from.x - dx, y: from.y - dy } : from;
  return {
    left: Math.min(near.x, far.x),
    top: Math.min(near.y, far.y),
    right: Math.max(near.x, far.x),
    bottom: Math.max(near.y, far.y),
  };
}

/** Whether a drag box has no area, so the shape is discarded (TL-SHAPE-01). */
export function isDegenerateBox(box: DragBox): boolean {
  return box.right <= box.left || box.bottom <= box.top;
}
