/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { rect } from "./geometry";
import { Selection } from "./selection";
import {
  type AffineMatrix,
  composeAffine,
  rectPolygon,
  type SelectionCombineMode,
  transformPolygon,
} from "./selection-polygons";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const translate = (dx: number, dy: number): AffineMatrix => ({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: dx,
  f: dy,
});
const scale = (s: number): AffineMatrix => ({ a: s, b: 0, c: 0, d: s, e: 0, f: 0 });

/**
 * Truth table for DOC-SEL-02 on a 4x4 canvas split into four 2x2 cells. `A` covers the top row of
 * cells (A and not B, plus both), and `B` covers the left column (B and not A, plus both).
 */
const A_RECT = rect(0, 0, 4, 2);
const B_RECT = rect(0, 0, 2, 4);
const CELLS = {
  both: { x: 0, y: 0 },
  aOnly: { x: 2, y: 0 },
  bOnly: { x: 0, y: 2 },
  neither: { x: 2, y: 2 },
} as const;

/** For each mode, whether the cells `both`, `aOnly`, `bOnly`, `neither` end up selected. */
const TRUTH_TABLE: Record<SelectionCombineMode, readonly [boolean, boolean, boolean, boolean]> = {
  replace: [true, false, true, false],
  union: [true, true, true, false],
  exclude: [false, true, false, false],
  intersect: [true, false, false, false],
  xor: [false, true, true, false],
};

describe("combine modes (DOC-SEL-02) truth table", () => {
  const base = new Selection([rectPolygon(A_RECT)], "aliased");
  const mask = (selection: Selection) => selection.mask(rect(0, 0, 4, 4));

  it.each(Object.keys(TRUTH_TABLE) as SelectionCombineMode[])("%s", (mode) => {
    const result = mask(base.combine([rectPolygon(B_RECT)], mode));
    const expected = TRUTH_TABLE[mode];
    (Object.keys(CELLS) as (keyof typeof CELLS)[]).forEach((cell, i) => {
      const { x, y } = CELLS[cell];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          expect(result[(y + dy) * 4 + x + dx]).toBe(expected[i] ? 255 : 0);
        }
      }
    });
  });

  it("keeps the selection quality and does not change the operands", () => {
    const aliased = base.combine([rectPolygon(B_RECT)], "union");
    expect(aliased.quality).toBe("aliased");
    expect(base.area()).toBe(8);
    expect(base.bounds()).toEqual(A_RECT);
  });

  it("combines an empty selection with a region", () => {
    const empty = new Selection();
    const region = [rectPolygon(B_RECT)];
    expect(empty.combine(region, "union").area()).toBe(8);
    expect(empty.combine(region, "exclude").isEmpty).toBe(true);
    expect(empty.combine(region, "intersect").isEmpty).toBe(true);
    expect(empty.combine(region, "xor").area()).toBe(8);
  });
});

describe("combined areas (exact, Clipper2)", () => {
  const a = new Selection([rectPolygon(rect(0, 0, 4, 4))]);
  const b = [rectPolygon(rect(2, 2, 4, 4))];
  it.each([
    ["replace", 16],
    ["union", 28],
    ["exclude", 12],
    ["intersect", 4],
    ["xor", 24],
  ] as const)("%s has area %d", (mode, area) => {
    expect(a.combine(b, mode).area()).toBe(area);
  });

  it("keeps holes out of the area", () => {
    const frame = new Selection([rectPolygon(rect(0, 0, 6, 6)), rectPolygon(rect(2, 2, 2, 2))]);
    expect(frame.area()).toBe(32);
    expect(frame.bounds()).toEqual(rect(0, 0, 6, 6));
  });
});

describe("selection bounds and area", () => {
  it("snaps fractional vertices to their nearest pixel corners", () => {
    const fractional = new Selection([rectPolygon({ x: 1.5, y: 0, width: 1.75, height: 2 })]);
    expect(fractional.polygons).toEqual([[3, 2, 2, 2, 2, 0, 3, 0]]);
    expect(fractional.bounds()).toEqual(rect(2, 0, 1, 2));
    expect(fractional.area()).toBe(2);
  });

  it("is empty with no bounds and no area", () => {
    const empty = new Selection();
    expect(empty.isEmpty).toBe(true);
    expect(empty.bounds()).toEqual(rect(0, 0, 0, 0));
    expect(empty.area()).toBe(0);
  });

  it("rejects coordinates beyond the Clipper range", () => {
    expect(() => new Selection([[0, 0, 300000, 0, 0, 10]])).toThrow(RangeError);
  });
});

describe("Select All and invert (DOC-SEL-06a/c)", () => {
  it("selects the whole canvas", () => {
    const all = Selection.all({ width: 8, height: 6 });
    expect(all.bounds()).toEqual(rect(0, 0, 8, 6));
    expect(all.area()).toBe(48);
  });

  it("inverts an antialiased selection through polygon clipping", () => {
    const inverted = new Selection([rectPolygon(rect(2, 2, 4, 4))]).inverted({
      width: 8,
      height: 8,
    });
    expect(inverted.area()).toBe(48);
    expect(inverted.bounds()).toEqual(rect(0, 0, 8, 8));
    expect(inverted.quality).toBe("antialiased");
  });

  it("inverts an aliased selection pixel by pixel into pixel-aligned polygons", () => {
    const selection = new Selection([rectPolygon(rect(1, 1, 2, 2))], "aliased");
    const inverted = selection.inverted({ width: 4, height: 4 });
    expect(inverted.quality).toBe("aliased");
    expect(inverted.area()).toBe(12);
    const original = selection.mask(rect(0, 0, 4, 4));
    const complement = inverted.mask(rect(0, 0, 4, 4));
    original.forEach((value, i) => {
      expect(complement[i]).toBe(255 - value);
    });
  });

  it("inverting nothing selects the whole canvas", () => {
    expect(new Selection().inverted({ width: 3, height: 2 }).area()).toBe(6);
  });
});

describe("transforms (DOC-SEL-05)", () => {
  const square = new Selection([rectPolygon(rect(0, 0, 2, 2))]);

  it("applies a pending transform to bounds and area without changing the committed polygons", () => {
    const moved = square.transform({ ...scale(2), e: 1, f: 1 });
    expect(moved.polygons).toEqual(square.polygons);
    expect(moved.bounds()).toEqual(rect(1, 1, 4, 4));
    expect(moved.area()).toBe(16);
  });

  it("commits the pending transform into the geometry", () => {
    const moved = square.transform(translate(3, 0));
    const committed = moved.commit();
    expect(committed.pendingTransform).toBeUndefined();
    expect(committed.polygons).toEqual(moved.effectivePolygons());
    expect(committed.bounds()).toEqual(moved.bounds());
  });

  it("applies later transforms after earlier ones", () => {
    const composed = square.transform(translate(3, 0)).transform(scale(2));
    expect(composed.bounds()).toEqual(rect(6, 0, 4, 4));
    expect(composed.pendingTransform).toEqual(composeAffine(scale(2), translate(3, 0)));
  });

  it("combines using the transformed geometry", () => {
    const moved = square.transform(translate(10, 0));
    expect(moved.combine([rectPolygon(rect(0, 0, 2, 2))], "union").area()).toBe(8);
  });

  it("transforms each vertex with the affine matrix", () => {
    expect(transformPolygon([1, 2, 3, 4], { a: 0, b: 1, c: -1, d: 0, e: 5, f: 0 })).toEqual([
      3, 1, 1, 3,
    ]);
  });
});

describe("edge quality (DOC-SEL-03)", () => {
  // A diagonal edge between pixel corners, from (4, 0) to (0, 1).
  const wedge = [[0, 0, 4, 0, 0, 1]];

  it("aliased masks sample pixel centers and antialiased masks give coverage", () => {
    const aa = new Selection(wedge, "antialiased");
    const coverage = Array.from(aa.mask(rect(0, 0, 4, 1)));
    [7 / 8, 5 / 8, 3 / 8, 1 / 8].forEach((expected, i) => {
      expect(Math.abs((coverage[i] ?? 0) - expected * 255)).toBeLessThanOrEqual(1);
    });
    const aliased = aa.withQuality("aliased");
    expect(aliased.area()).toBe(2);
    expect(Array.from(aliased.mask(rect(0, 0, 4, 1)))).toEqual([255, 255, 0, 0]);
  });

  it("returns an all-zero mask for an empty selection", () => {
    expect(Array.from(new Selection().mask(rect(0, 0, 2, 2)))).toEqual([0, 0, 0, 0]);
  });
});

/** Whether every vertex is a whole pixel corner and no ring repeats a vertex or runs straight. */
function wellFormedOnCorners(polygons: readonly (readonly number[])[]): boolean {
  for (const ring of polygons) {
    const n = ring.length / 2;
    if (n < 3) return false;
    for (let i = 0; i < n; i++) {
      const at = (k: number) => [ring[((i + k) % n) * 2] ?? 0, ring[((i + k) % n) * 2 + 1] ?? 0];
      const [ox, oy] = at(0) as [number, number];
      const [ax, ay] = at(1) as [number, number];
      const [bx, by] = at(2) as [number, number];
      if (!Number.isInteger(ox) || !Number.isInteger(oy)) return false;
      if (ox === ax && oy === ay) return false;
      if ((ax - ox) * (by - oy) - (ay - oy) * (bx - ox) === 0) return false;
    }
  }
  return true;
}

describe("pixel-based selections (owner request)", () => {
  it("merges straight runs, so a lasso's diagonal becomes one edge", () => {
    const selection = new Selection([[0, 0, 1, 1, 2, 2, 3, 3, 3, 0, 2, 0, 1, 0]]);
    expect(selection.polygons).toHaveLength(1);
    expect(selection.polygons[0]).toHaveLength(6);
    expect(selection.area()).toBe(4.5);
  });

  it("keeps the vertices on pixel corners where two diagonal edges cross", () => {
    const a = new Selection([[0, 0, 7, 3, 0, 5]]);
    const crossed = a.combine([[1, 4, 8, 0, 8, 5]], "union");
    expect(wellFormedOnCorners(crossed.polygons)).toBe(true);
    const xor = a.combine([[1, 4, 8, 0, 8, 5]], "xor");
    expect(wellFormedOnCorners(xor.polygons)).toBe(true);
  });

  it("snaps a rotated selection's vertices to the nearest pixel corners", () => {
    const square = new Selection([rectPolygon(rect(10, 10, 13, 7))]);
    for (const degrees of [1, 7.5, 15, 33, 45, 89.9, 90, 135, 180, 271]) {
      const t = (degrees * Math.PI) / 180;
      const [cx, cy] = [16.5, 13.5];
      const turn: AffineMatrix = {
        a: Math.cos(t),
        b: Math.sin(t),
        c: -Math.sin(t),
        d: Math.cos(t),
        e: cx - cx * Math.cos(t) + cy * Math.sin(t),
        f: cy - cx * Math.sin(t) - cy * Math.cos(t),
      };
      const turned = square.transform(turn);
      expect(wellFormedOnCorners(turned.effectivePolygons())).toBe(true);
      expect(wellFormedOnCorners(turned.commit().polygons)).toBe(true);
      expect(Math.abs(turned.area() - 91)).toBeLessThan(13 + 7);
    }
  });

  it("scales onto whole pixels", () => {
    const square = new Selection([[0, 0, 3, 0, 3, 3, 0, 3, 0, 2, 1, 1]]);
    const scaled = square.transform({ a: 5 / 3, b: 0, c: 0, d: 4 / 3, e: 2, f: 1 });
    expect(wellFormedOnCorners(scaled.effectivePolygons())).toBe(true);
    expect(scaled.bounds()).toEqual(rect(2, 1, 5, 4));
  });
});

describe("coversRect (L2)", () => {
  it("is true for a solid, pixel-aligned rectangle around the area", () => {
    const all = Selection.all({ width: 40, height: 30 });
    expect(all.coversRect(rect(0, 0, 40, 30))).toBe(true);
    expect(all.coversRect(rect(5, 5, 10, 10))).toBe(true);
    expect(all.coversRect(rect(35, 0, 10, 10))).toBe(false);
  });

  it("is false for shapes that leave pixels partly or wholly out", () => {
    expect(new Selection([[0.5, 0, 10, 0, 10, 10, 0.5, 10]]).coversRect(rect(0, 0, 10, 10))).toBe(
      false,
    );
    expect(new Selection([[0, 0, 10, 0, 0, 10]]).coversRect(rect(0, 0, 10, 10))).toBe(false);
    expect(new Selection().coversRect(rect(0, 0, 1, 1))).toBe(false);
  });
});
