import { isEmptyRect, type Rect, rasterizeSelection, rectFromEdges } from "@openpaint/document";
import type { LinePoint } from "@openpaint/tools";
import type { CoveragePart } from "./layer-patch";

/** The side of the cells a thin polygon is rasterized in, in pixels. */
export const COVERAGE_CELL = 64;

type Rings = readonly (readonly LinePoint[])[];

/** Whether the segment from `a` to `b` passes through the closed rectangle (Liang-Barsky). */
function segmentMeetsRect(a: LinePoint, b: LinePoint, cell: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clips: [number, number][] = [
    [-dx, a.x - cell.x],
    [dx, cell.x + cell.width - a.x],
    [-dy, a.y - cell.y],
    [dy, cell.y + cell.height - a.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return false;
      t1 = Math.min(t1, t);
    }
  }
  return t0 <= t1;
}

/** Whether `p` lies inside the rings under the even-odd rule. */
function inside(rings: Rings, p: LinePoint): boolean {
  let result = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a === undefined || b === undefined) continue;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
        result = !result;
      }
    }
  }
  return result;
}

/**
 * The coverage of polygons over `area`, as parts of whole-pixel rectangles (L2). A thin polygon,
 * such as a turned outline's edge or a diagonal line, has a bounding box many times its own area,
 * so it is rasterized only over the `COVERAGE_CELL` cells it touches, joined into runs along each
 * row. Every pixel's coverage depends only on the polygon, so the parts give the same pixels as one
 * rasterization of the whole area.
 */
export function coverageParts(
  rings: Rings,
  area: Rect,
  mode: "aliased" | "antialiased",
): CoveragePart[] {
  if (isEmptyRect(area)) return [];
  const flat = rings.map((ring) => ring.flatMap((point) => [point.x, point.y]));
  const columns = Math.ceil(area.width / COVERAGE_CELL);
  const rows = Math.ceil(area.height / COVERAGE_CELL);
  if (columns * rows <= 4) return [{ area, coverage: rasterizeSelection(flat, area, mode) }];
  const cellAt = (column: number, row: number): Rect => {
    const left = area.x + column * COVERAGE_CELL;
    const top = area.y + row * COVERAGE_CELL;
    return rectFromEdges(
      left,
      top,
      Math.min(left + COVERAGE_CELL, area.x + area.width),
      Math.min(top + COVERAGE_CELL, area.y + area.height),
    );
  };
  const touched = new Uint8Array(columns * rows);
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const b = ring[i];
      if (a === undefined || b === undefined) continue;
      const clamp = (value: number, count: number) => Math.min(count - 1, Math.max(0, value));
      const c0 = clamp(Math.floor((Math.min(a.x, b.x) - area.x) / COVERAGE_CELL), columns);
      const c1 = clamp(Math.floor((Math.max(a.x, b.x) - area.x) / COVERAGE_CELL), columns);
      const r0 = clamp(Math.floor((Math.min(a.y, b.y) - area.y) / COVERAGE_CELL), rows);
      const r1 = clamp(Math.floor((Math.max(a.y, b.y) - area.y) / COVERAGE_CELL), rows);
      for (let row = r0; row <= r1; row++) {
        for (let column = c0; column <= c1; column++) {
          const index = row * columns + column;
          if (touched[index] === 0 && segmentMeetsRect(a, b, cellAt(column, row))) {
            touched[index] = 1;
          }
        }
      }
    }
  }
  // A cell no edge crosses is inside the polygon as a whole, or outside it.
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      if (touched[index] !== 0) continue;
      const cell = cellAt(column, row);
      const center = { x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 };
      if (inside(rings, center)) touched[index] = 1;
    }
  }
  const parts: CoveragePart[] = [];
  for (let row = 0; row < rows; row++) {
    let column = 0;
    while (column < columns) {
      if (touched[row * columns + column] === 0) {
        column++;
        continue;
      }
      const first = column;
      while (column < columns && touched[row * columns + column] !== 0) column++;
      const left = cellAt(first, row);
      const right = cellAt(column - 1, row);
      const run = rectFromEdges(left.x, left.y, right.x + right.width, left.y + left.height);
      parts.push({ area: run, coverage: rasterizeSelection(flat, run, mode) });
    }
  }
  return parts;
}
