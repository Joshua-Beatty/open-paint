import { describe, expect, it } from "vitest";
import { TERM, termsOf } from "../brush-segments";
import { chunkLayers } from "./compositor";
import { maskWords } from "./stroke";
import { planStamps } from "./stroke-plan";

describe("termsOf", () => {
  const round = { joined: true, square: false, starts: true, ends: true };

  it("makes a joined round stroke's segments and the caps at its ends", () => {
    const dabs = [0, 0, 10, 20, 0, 10, 20, 0, 12, 40, 5, 10];
    expect(termsOf(dabs, round)).toEqual([
      { kind: TERM.cap, a: 0, b: 1 },
      { kind: TERM.segment, a: 0, b: 1 },
      { kind: TERM.segment, a: 2, b: 3 },
      { kind: TERM.cap, a: 3, b: 2 },
    ]);
    // A batch inside the stroke has neither cap.
    expect(termsOf(dabs, { ...round, starts: false, ends: false })).toHaveLength(2);
  });

  it("makes a lone dab a point only when it ends the stroke", () => {
    expect(termsOf([5, 5, 10], round)).toEqual([{ kind: TERM.point, a: 0, b: 0 }]);
    expect(termsOf([5, 5, 10], { ...round, ends: false })).toEqual([]);
    expect(termsOf([5, 5, 10, 9, 9, 10], { ...round, joined: false })).toHaveLength(2);
  });

  it("sweeps a square tip from dab to dab", () => {
    expect(termsOf([0, 0, 10, 20, 0, 10], { ...round, square: true })).toEqual([
      { kind: TERM.square, a: 0, b: 1 },
    ]);
  });
});

describe("planStamps", () => {
  const spacedSquares = { joined: false, square: true, starts: true, ends: true, antialias: false };

  it("groups parts by tile in stroke order and keeps each tile's parts in order", () => {
    // Dab 0 in tile (0,0), dab 1 across tiles (0,0) and (1,0), dab 2 in (1,0), dab 3 back in (0,0).
    const dabs = [100, 100, 20, 250, 100, 20, 300, 100, 20, 120, 120, 4];
    const stamps = planStamps(dabs, 600, 300, spacedSquares);
    expect(stamps.map((s) => [s.tx, s.ty, s.terms])).toEqual([
      [0, 0, [3, 0, 0, 3, 1, 1, 3, 3, 3]],
      [1, 0, [3, 1, 1, 3, 2, 2]],
    ]);
    expect(stamps[0]).toMatchObject({ x0: 90, y0: 90, x1: 256, y1: 122 });
    expect(stamps[1]).toMatchObject({ x0: 0, y0: 90, x1: 54, y1: 110 });
  });

  it("bounds a round tip's parts by the field's influence", () => {
    // Reach 10.5 px, times 1.45, plus a pixel: 16.225 px around the dab.
    const stamps = planStamps([50, 50, 20], 600, 300, {
      ...spacedSquares,
      square: false,
      antialias: true,
    });
    expect(stamps).toEqual([{ tx: 0, ty: 0, x0: 33, y0: 33, x1: 67, y1: 67, terms: [2, 0, 0] }]);
  });

  it("splits a dab over a tile corner into four tiles", () => {
    const stamps = planStamps([256, 256, 10], 1000, 1000, spacedSquares);
    expect(stamps.map((s) => [s.tx, s.ty])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(stamps[3]).toMatchObject({ x0: 0, y0: 0, x1: 5, y1: 5 });
  });

  it("ignores dabs outside the image", () => {
    expect(planStamps([-100, -100, 10, 5000, 5, 10], 600, 300, spacedSquares)).toEqual([]);
  });
});
describe("maskWords", () => {
  it("places the mask's coverage in the tile and leaves the rest uncovered", () => {
    const mask = {
      x: 250,
      y: 2,
      width: 10,
      height: 2,
      data: new Uint8Array(20).map((_, i) => i + 1),
    };
    const first = maskWords(mask, 0, 0);
    expect(first[2 * 256 + 250]).toBe(1);
    expect(first[3 * 256 + 255]).toBe(16);
    expect(first[2 * 256 + 249]).toBe(0);
    const second = maskWords(mask, 256, 0);
    expect(second[2 * 256]).toBe(7);
    expect(second[3 * 256 + 3]).toBe(20);
    expect(maskWords(mask, 0, 256).some((word) => word !== 0)).toBe(false);
  });
});

describe("chunkLayers", () => {
  it("keeps the stack in one chunk while it fits the bound pages", () => {
    expect(chunkLayers([new Set([0]), new Set([0, 1])])).toEqual([
      { start: 0, count: 2, pages: [0, 1] },
    ]);
    expect(chunkLayers([])).toEqual([{ start: 0, count: 0, pages: [] }]);
  });

  it("starts a chunk when the pages would pass eight", () => {
    const pages = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((page) => new Set([page]));
    expect(chunkLayers(pages)).toEqual([
      { start: 0, count: 8, pages: [0, 1, 2, 3, 4, 5, 6, 7] },
      { start: 8, count: 2, pages: [8, 9] },
    ]);
  });

  it("starts a chunk after 64 layers and refuses a layer over nine pages", () => {
    const many = Array.from({ length: 70 }, () => new Set([0]));
    expect(chunkLayers(many).map((chunk) => chunk.count)).toEqual([64, 6]);
    expect(() => chunkLayers([new Set([0, 1, 2, 3, 4, 5, 6, 7, 8])])).toThrow("9 tile pages");
  });
});
