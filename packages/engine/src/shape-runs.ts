import type { Rect } from "@openpaint/document";

/** Sub-scanlines per pixel row of antialiased masks, as in `crates/opaint-cpu/src/mask.rs`. */
const SUBSAMPLES = 16;

/**
 * A selection mask over a rectangle as runs: row `y` holds the breaks
 * `breaks[offsets[y]] .. breaks[offsets[y + 1]]`, each `x << 8 | value`, sorted by `x`; a pixel
 * takes the value of the last break at or before it, and 0 before the first.
 */
export interface ShapeRuns {
  readonly offsets: Uint32Array;
  readonly breaks: Uint32Array;
}

interface Edge {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * The mask `rasterize_polygons` (`crates/opaint-cpu/src/mask.rs`) makes of the rings over `area`,
 * byte for byte, as runs: the same f64 operations in the same order, but only the pixels that the
 * edges cross are computed one by one, so the cost follows the outline, not the area (L2). `coords`
 * are canvas pixels; `counts` holds the vertex count of each ring.
 */
export function shapeRuns(
  coords: Float64Array,
  counts: Uint32Array,
  area: Rect,
  antialiased: boolean,
): ShapeRuns {
  const { width, height } = area;
  const edges: Edge[] = [];
  let start = 0;
  for (const count of counts) {
    if (count >= 3) {
      for (let i = 0; i < count; i++) {
        const p = (start + i) * 2;
        const q = (start + ((i + 1) % count)) * 2;
        // As `rasterizeSelection`: coordinates relative to the area, in f64.
        const x0 = (coords[p] ?? 0) - area.x;
        const y0 = (coords[p + 1] ?? 0) - area.y;
        const x1 = (coords[q] ?? 0) - area.x;
        const y1 = (coords[q + 1] ?? 0) - area.y;
        if (y0 === y1) continue;
        edges.push({ x0, y0, x1, y1, top: Math.min(y0, y1), bottom: Math.max(y0, y1) });
      }
    }
    start += count;
  }
  edges.sort((a, b) => a.top - b.top);
  const offsets = new Uint32Array(height + 1);
  let breaks = new Uint32Array(Math.max(16, height * 4));
  let used = 0;
  const push = (x: number, value: number) => {
    if (used === breaks.length) {
      const grown = new Uint32Array(breaks.length * 2);
      grown.set(breaks);
      breaks = grown;
    }
    breaks[used++] = (x << 8) | value;
  };
  if (edges.length === 0 || width === 0) {
    return { offsets, breaks: breaks.subarray(0, 0) };
  }
  const samples = antialiased ? SUBSAMPLES : 1;
  const weight = 1 / samples;
  const maxX = width;
  let next = 0;
  let active: Edge[] = [];
  const crossings: number[] = [];
  const partial = new Map<number, number>();
  const interior = new Map<number, number>();
  const spans: [number, number][] = [];
  for (let row = 0; row < height; row++) {
    offsets[row] = used;
    partial.clear();
    interior.clear();
    spans.length = 0;
    // Edges that can reach this row's sub-scanlines.
    const rowBottom = row + 1;
    while (next < edges.length && (edges[next] as Edge).top < rowBottom) {
      active.push(edges[next] as Edge);
      next++;
    }
    active = active.filter((edge) => edge.bottom > row);
    if (active.length === 0) continue;
    for (let sample = 0; sample < samples; sample++) {
      const y = row + (sample + 0.5) * weight;
      crossings.length = 0;
      for (const e of active) {
        if (y >= e.top && y < e.bottom) {
          crossings.push(e.x0 + ((y - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0));
        }
      }
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const a = Math.min(Math.max(crossings[k] as number, 0), maxX);
        const b = Math.min(Math.max(crossings[k + 1] as number, 0), maxX);
        if (a >= b) continue;
        if (!antialiased) {
          const from = Math.ceil(a - 0.5);
          const to = Math.min(Math.ceil(b - 0.5), width);
          if (from < to) spans.push([from, to]);
          continue;
        }
        const first = Math.floor(a);
        const last = Math.floor(b);
        if (first === last) {
          partial.set(first, (partial.get(first) ?? 0) + (b - a) * weight);
          continue;
        }
        partial.set(first, (partial.get(first) ?? 0) + (first + 1 - a) * weight);
        if (last < width) partial.set(last, (partial.get(last) ?? 0) + (b - last) * weight);
        if (first + 1 < last) {
          interior.set(first + 1, (interior.get(first + 1) ?? 0) + weight);
          interior.set(last, (interior.get(last) ?? 0) - weight);
        }
      }
    }
    if (!antialiased) {
      spans.sort((a, b) => a[0] - b[0]);
      let open: [number, number] | undefined;
      for (const span of spans) {
        if (open !== undefined && span[0] <= open[1]) {
          open[1] = Math.max(open[1], span[1]);
          continue;
        }
        if (open !== undefined) {
          push(open[0], 255);
          push(open[1], 0);
        }
        open = [span[0], span[1]];
      }
      if (open !== undefined) {
        push(open[0], 255);
        if (open[1] < width) push(open[1], 0);
      }
      continue;
    }
    // The value changes only at pixels with a partial part, just after them, and at interior steps.
    const marks = new Set<number>();
    for (const x of partial.keys()) {
      marks.add(x);
      marks.add(x + 1);
    }
    for (const x of interior.keys()) marks.add(x);
    const xs = [...marks].filter((x) => x >= 0 && x < width).sort((a, b) => a - b);
    let running = 0;
    let shown = 0;
    let stepped = -1;
    const steps = [...interior.keys()].sort((a, b) => a - b);
    let s = 0;
    for (const x of xs) {
      while (s < steps.length && (steps[s] as number) <= x) {
        if ((steps[s] as number) > stepped) running += interior.get(steps[s] as number) ?? 0;
        s++;
      }
      stepped = x;
      const value = Math.min(
        255,
        Math.max(0, Math.floor(((partial.get(x) ?? 0) + running) * 255 + 0.5)),
      );
      if (value !== shown) {
        push(x, value);
        shown = value;
      }
    }
  }
  offsets[height] = used;
  return { offsets, breaks: breaks.subarray(0, used) };
}

/** The runs as a dense mask, row-major, one byte per pixel (tests). */
export function runsToMask(runs: ShapeRuns, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let value = 0;
    let x = 0;
    for (let i = runs.offsets[y] ?? 0; i < (runs.offsets[y + 1] ?? 0); i++) {
      const word = runs.breaks[i] ?? 0;
      const at = word >>> 8;
      mask.fill(value, y * width + x, y * width + at);
      x = at;
      value = word & 255;
    }
    mask.fill(value, y * width + x, (y + 1) * width);
  }
  return mask;
}
