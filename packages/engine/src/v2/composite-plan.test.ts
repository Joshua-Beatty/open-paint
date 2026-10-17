import { describe, expect, it } from "vitest";
import {
  CompositeCache,
  type CompositeDraw,
  compositeKey,
  compositeLevel,
  compositeSampling,
  planComposite,
} from "./composite-plan";

const doc = { width: 4000, height: 3000 };
const viewport = { width: 1440, height: 900 };

describe("planComposite", () => {
  it("picks the mip level and sampling from the zoom (ARC-03-04/05)", () => {
    expect([1, 0.75, 0.5, 0.224, 0.1, 0.001].map(compositeLevel)).toEqual([0, 0, 1, 2, 3, 8]);
    expect(compositeLevel(4)).toBe(0);
    expect(compositeSampling(0, 1)).toBe("nearest");
    expect(compositeSampling(0, 0.75)).toBe("bilinear");
    expect(compositeSampling(1, 0.5)).toBe("bilinear");
  });

  it("covers the fitted image with level 2 tiles that share edges", () => {
    const plan = planComposite({ mode: "fit" }, doc, { width: 1056, height: 672 });
    expect(plan.level).toBe(2);
    expect(plan.draws.map((draw) => [draw.cx, draw.cy])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
    const [first, second] = plan.draws;
    expect(first && second && first.dst.x + first.dst.width).toBe(second?.dst.x);
    expect(plan.canvas.width).toBe(Math.round(4000 * plan.zoom));
  });

  it("plans only the visible tiles when zoomed in", () => {
    const view = { mode: "fixed", zoom: 1, originX: -1000, originY: -500 } as const;
    const plan = planComposite(view, doc, viewport);
    expect(plan.level).toBe(0);
    expect(plan.sampling).toBe("nearest");
    const xs = plan.draws.map((draw) => draw.cx);
    const ys = plan.draws.map((draw) => draw.cy);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([3, 9]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([1, 5]);
  });

  it("ends the edge tiles at the canvas edge, showing only the image's part (UI-VIEW-02)", () => {
    for (const size of [doc, { width: 1001, height: 777 }, { width: 4097, height: 257 }]) {
      for (const port of [viewport, { width: 517, height: 389 }, { width: 1333, height: 911 }]) {
        const plan = planComposite({ mode: "fit" }, size, port);
        const { canvas } = plan;
        const right = canvas.x + canvas.width;
        const bottom = canvas.y + canvas.height;
        let area = 0;
        for (const { dst, cover, cx, cy, level } of plan.draws) {
          area += dst.width * dst.height;
          expect(dst.x + dst.width).toBeLessThanOrEqual(right);
          expect(dst.y + dst.height).toBeLessThanOrEqual(bottom);
          const edge = 256 * 2 ** level;
          // Where a dst meets the canvas edge, it shows the image up to its edge, or to less than a
          // device pixel before it when the last tile's sliver rounds away.
          const pixel = 1 / plan.zoom;
          expect((cx + cover.x) * edge).toBeLessThanOrEqual(size.width + 1e-9);
          expect((cy + cover.y) * edge).toBeLessThanOrEqual(size.height + 1e-9);
          if (dst.x + dst.width === right) {
            expect((cx + cover.x) * edge).toBeGreaterThan(size.width - pixel);
          }
          if (dst.y + dst.height === bottom) {
            expect((cy + cover.y) * edge).toBeGreaterThan(size.height - pixel);
          }
        }
        expect(area).toBe(canvas.width * canvas.height);
      }
    }
  });

  it("plans nothing for an empty image", () => {
    expect(planComposite({ mode: "fit" }, { width: 0, height: 0 }, viewport).draws).toEqual([]);
  });
});

function draw(level: number, cx: number, cy: number): CompositeDraw {
  return {
    key: compositeKey(level, cx, cy),
    level,
    cx,
    cy,
    dst: { x: 0, y: 0, width: 1, height: 1 },
    cover: { x: 1, y: 1 },
  };
}

describe("CompositeCache", () => {
  it("blends a tile once, then again only after a layer tile under it changes", () => {
    const cache = new CompositeCache();
    const draws = [draw(0, 0, 0), draw(0, 1, 0)];
    expect(cache.prepare(draws).work.map((w) => w.draw.key)).toEqual(["0/0/0", "0/1/0"]);
    expect(cache.prepare(draws).work).toEqual([]);

    cache.invalidateTile(1, 0);
    const { slots, work } = cache.prepare(draws);
    expect(work.map((w) => w.draw.key)).toEqual(["0/1/0"]);
    expect(slots).toEqual([0, 1]);
  });

  it("maps a layer tile to the composite tile over it at every level", () => {
    const cache = new CompositeCache();
    const draws = [draw(0, 5, 3), draw(1, 2, 1), draw(2, 1, 0), draw(3, 0, 0), draw(2, 0, 0)];
    cache.prepare(draws);
    cache.invalidateTile(5, 3);
    expect(cache.prepare(draws).work.map((w) => w.draw.key)).toEqual([
      "0/5/3",
      "1/2/1",
      "2/1/0",
      "3/0/0",
    ]);
    cache.invalidateAll();
    expect(cache.prepare(draws).work).toHaveLength(5);
  });

  it("evicts the least recently drawn tiles beyond its size and reuses their slots", () => {
    const cache = new CompositeCache(2);
    cache.prepare([draw(0, 0, 0), draw(0, 1, 0)]);
    cache.prepare([draw(0, 1, 0)]);
    const next = cache.prepare([draw(0, 2, 0)]);
    expect(next.slots).toEqual([0]);
    expect(cache.size).toBe(2);
    expect(cache.slotCount).toBe(2);
    expect(cache.isDirty("0/0/0")).toBe(true);
  });
});
