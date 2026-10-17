import { type Rect, rect } from "./geometry";
import type { AffineMatrix } from "./selection-polygons";

export interface Vector {
  readonly x: number;
  readonly y: number;
}

/** The map that moves every point by (`dx`, `dy`). */
export function translationAffine(dx: number, dy: number): AffineMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy };
}

/** The map that scales by (`sx`, `sy`) about the point (`px`, `py`). */
export function scalingAboutAffine(px: number, py: number, sx: number, sy: number): AffineMatrix {
  return { a: sx, b: 0, c: 0, d: sy, e: px - sx * px, f: py - sy * py };
}

/** The map that turns by `radians` (clockwise on screen) about the point (`px`, `py`). */
export function rotationAboutAffine(px: number, py: number, radians: number): AffineMatrix {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: px - cos * px + sin * py,
    f: py - sin * px - cos * py,
  };
}

/** The point `m` maps `(x, y)` to. */
export function applyAffine(m: AffineMatrix, x: number, y: number): Vector {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/**
 * The inverse map. Throws a RangeError for a singular matrix, which no tool produces, since every
 * tool scales by at least 1e-7.
 */
export function invertAffine(m: AffineMatrix): AffineMatrix {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || det === 0) throw new RangeError("The transform is singular.");
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

/** True when `m` only moves by whole pixels, so resampling would change nothing. */
export function isIntegerTranslation(m: AffineMatrix): boolean {
  return (
    m.a === 1 &&
    m.b === 0 &&
    m.c === 0 &&
    m.d === 1 &&
    Number.isInteger(m.e) &&
    Number.isInteger(m.f)
  );
}

export function sameAffine(a: AffineMatrix, b: AffineMatrix): boolean {
  return a.a === b.a && a.b === b.b && a.c === b.c && a.d === b.d && a.e === b.e && a.f === b.f;
}

/** The whole-pixel rectangle that covers `source` after `m`. Its corners are floored and ceiled. */
export function affineBounds(source: Rect, m: AffineMatrix): Rect {
  const corners = [
    applyAffine(m, source.x, source.y),
    applyAffine(m, source.x + source.width, source.y),
    applyAffine(m, source.x + source.width, source.y + source.height),
    applyAffine(m, source.x, source.y + source.height),
  ];
  const left = Math.floor(Math.min(...corners.map((p) => p.x)));
  const top = Math.floor(Math.min(...corners.map((p) => p.y)));
  const right = Math.ceil(Math.max(...corners.map((p) => p.x)));
  const bottom = Math.ceil(Math.max(...corners.map((p) => p.y)));
  return rect(left, top, right - left, bottom - top);
}
