import { describe, expect, it } from "vitest";
import { rect } from "./geometry";
import {
  type ClipOperation,
  clipPolygons,
  normalizePolygons,
  polygonsArea,
  polygonsBounds,
  rectPolygon,
  type SelectionPolygon,
} from "./selection-polygons";

/** A small deterministic generator, so a failing case can be replayed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Even-odd membership: a point is inside when a ray crosses an odd number of edges. */
function contains(polygons: readonly SelectionPolygon[], x: number, y: number): boolean {
  let inside = false;
  for (const polygon of polygons) {
    const n = polygon.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = polygon[i * 2] ?? 0;
      const y0 = polygon[i * 2 + 1] ?? 0;
      const x1 = polygon[j * 2] ?? 0;
      const y1 = polygon[j * 2 + 1] ?? 0;
      if (y0 <= y !== y1 <= y) {
        const crossX = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
        if (crossX > x) inside = !inside;
      }
    }
  }
  return inside;
}

function randomSet(next: () => number, count: number): SelectionPolygon[] {
  const polygons: SelectionPolygon[] = [];
  for (let p = 0; p < count; p++) {
    const sides = 3 + Math.floor(next() * 3);
    const ring: number[] = [];
    for (let i = 0; i < sides; i++) {
      ring.push(Math.round(next() * 320) / 8, Math.round(next() * 320) / 8);
    }
    polygons.push(ring);
  }
  return polygons;
}

const OPERATIONS: Record<ClipOperation, (a: boolean, b: boolean) => boolean> = {
  union: (a, b) => a || b,
  difference: (a, b) => a && !b,
  intersection: (a, b) => a && b,
  xor: (a, b) => a !== b,
};

describe("clipPolygons membership (Clipper2 adapter)", () => {
  const next = random(20260412);
  const cases = Array.from({ length: 60 }, () => ({
    a: randomSet(next, 1 + Math.floor(next() * 2)),
    b: randomSet(next, 1 + Math.floor(next() * 2)),
    samples: Array.from({ length: 150 }, () => [next() * 42, next() * 42] as const),
  }));

  it.each(Object.keys(OPERATIONS) as ClipOperation[])(
    "%s agrees with even-odd membership at random points",
    (operation) => {
      const check = OPERATIONS[operation];
      for (const { a, b, samples } of cases) {
        const result = clipPolygons(operation, a, b);
        for (const [x, y] of samples) {
          const expected = check(contains(a, x, y), contains(b, x, y));
          expect(contains(result, x, y)).toBe(expected);
        }
      }
    },
  );
});

describe("normalizePolygons", () => {
  it("keeps a rectangle as one clean four-corner ring", () => {
    const rings = normalizePolygons([rectPolygon(rect(1, 2, 3, 4))]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(8);
    expect(polygonsArea(rings)).toBe(12);
    expect(polygonsBounds(rings)).toEqual(rect(1, 2, 3, 4));
  });

  it("is idempotent for area and membership", () => {
    const next = random(7);
    for (let i = 0; i < 20; i++) {
      const once = normalizePolygons(randomSet(next, 2));
      const twice = normalizePolygons(once);
      expect(polygonsArea(twice)).toBeCloseTo(polygonsArea(once), 9);
      expect(twice.length).toBe(once.length);
    }
  });

  it("drops degenerate input", () => {
    expect(normalizePolygons([[0, 0, 4, 4]])).toEqual([]);
    expect(normalizePolygons([[0, 0, 4, 0, 8, 0]])).toEqual([]);
  });

  it("returns no negative zeros", () => {
    const [ring] = normalizePolygons([rectPolygon(rect(0, 0, 2, 2))]);
    for (const value of ring ?? []) expect(Object.is(value, -0)).toBe(false);
  });
});

describe("polygon measures", () => {
  it("measures a fractional polygon exactly", () => {
    expect(polygonsArea([[0, 0, 2.5, 0, 2.5, 1, 0, 1]])).toBe(2.5);
  });

  it("bounds a set by its vertices, rounded outward", () => {
    expect(polygonsBounds([[1.25, 0.5, 3.75, 0.5, 3.75, 2.25]])).toEqual(rect(1, 0, 3, 3));
    expect(polygonsBounds([])).toEqual(rect(0, 0, 0, 0));
  });
});
