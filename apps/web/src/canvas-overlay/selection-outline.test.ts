import { describe, expect, it, vi } from "vitest";
import {
  antDash,
  antOffset,
  antTile,
  outlinePath,
  outlineRuns,
  paintCrispOutline,
  paintSelectionOutline,
  SELECTION_TINT,
  selectionTintShown,
} from "./selection-outline";

/** The device pixels that runs `x, y, width, height` cover, as `"x,y"` keys. */
function pixelsOf(runs: readonly number[]): Set<string> {
  const pixels = new Set<string>();
  for (let i = 0; i < runs.length; i += 4) {
    const [x = 0, y = 0, w = 0, h = 0] = runs.slice(i, i + 4);
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) pixels.add(`${x + dx},${y + dy}`);
  }
  return pixels;
}

describe("selection outline (DOC-SEL-04)", () => {
  it("advances the ants one device pixel every 50 ms and wraps each 8 px period", () => {
    expect(antOffset(0, 1)).toBe(-0);
    expect(antOffset(49, 1)).toBe(-0);
    expect(antOffset(50, 1)).toBe(-1);
    expect(antOffset(350, 1)).toBe(-7);
    expect(antOffset(400, 1)).toBe(-0);
    expect(antOffset(100, 2)).toBe(-4);
  });

  it("turns the tint off while a dialog previews on the canvas", () => {
    expect(selectionTintShown({ layerProperties: false, effect: undefined })).toBe(true);
    expect(selectionTintShown({ layerProperties: true, effect: undefined })).toBe(false);
    expect(selectionTintShown({ layerProperties: false, effect: "dialog" })).toBe(false);
    expect(selectionTintShown({ layerProperties: false, effect: "rendering" })).toBe(false);
    expect(selectionTintShown({ layerProperties: false, effect: "error" })).toBe(true);
  });

  it("leaves out the tint when it is off, and fills it under the ants when it is on", () => {
    const fills: unknown[] = [];
    const ctx = {
      save: () => undefined,
      restore: () => undefined,
      setLineDash: () => undefined,
      stroke: () => undefined,
      fill: () => fills.push(ctx.fillStyle),
      fillStyle: "" as unknown,
    };
    const path = {} as Path2D;
    const draw = (tint: boolean) =>
      paintSelectionOutline(ctx as unknown as CanvasRenderingContext2D, path, {
        offset: 0,
        dpr: 1,
        tint,
      });
    draw(false);
    expect(fills).toEqual([]);
    draw(true);
    expect(fills).toEqual([SELECTION_TINT]);
  });

  it("has no path for an empty selection", () => {
    expect(outlinePath([], { zoom: 1, originX: 0, originY: 0 })).toBeUndefined();
  });

  describe("without antialiasing", () => {
    const layout = { zoom: 2, originX: 10, originY: 5 };

    it("traces a rectangle as four one-pixel runs at the zoomed device pixels", () => {
      const runs = outlineRuns([[0, 0, 10, 0, 10, 5, 0, 5]], layout, 100, 100);
      // Image (0, 0)-(10, 5) at zoom 2 from (10, 5) spans device (10, 5)-(30, 15).
      expect(runs).toEqual([10, 5, 21, 1, 30, 5, 1, 11, 10, 15, 21, 1, 10, 5, 1, 11]);
    });

    it("steps a diagonal edge one pixel per row, with no gaps", () => {
      const runs = outlineRuns([[0, 0, 3, 3, 0, 3]], { zoom: 1, originX: 0, originY: 0 }, 9, 9);
      const pixels = pixelsOf(runs);
      for (let i = 0; i <= 3; i++) expect(pixels.has(`${i},${i}`)).toBe(true);
      expect(pixels.has("1,0")).toBe(false);
    });

    it("traces only the visible part of a deeply zoomed outline", () => {
      const zoomed = { zoom: 1000, originX: -500_000, originY: -500_000 };
      const runs = outlineRuns([[0, 0, 1000, 0, 1000, 1000, 0, 1000]], zoomed, 200, 100);
      expect(runs.length).toBe(0);
      // The bottom right corner lands at device (100, 50): two edges, clipped to the canvas.
      const near = outlineRuns([[0, 0, 500.1, 0, 500.1, 500.05, 0, 500.05]], zoomed, 200, 100);
      expect(pixelsOf(near).has("100,50")).toBe(true);
      expect(pixelsOf(near).has("100,0")).toBe(true);
      expect(pixelsOf(near).has("0,50")).toBe(true);
      for (let i = 0; i < near.length; i += 4) {
        expect(near[i + 2] ?? 0).toBeLessThanOrEqual(202);
        expect(near[i + 3] ?? 0).toBeLessThanOrEqual(102);
      }
    });

    it("tiles the ants as diagonal stripes, so every row and column alternates dashes", () => {
      expect(antDash(1)).toBe(4);
      expect(antDash(1.5)).toBe(6);
      expect(antDash(0.1)).toBe(1);
      const tile = antTile(2);
      const at = (x: number, y: number) => tile[(y * 4 + x) * 4];
      expect([at(0, 0), at(1, 0), at(2, 0), at(3, 0)]).toEqual([0, 0, 255, 255]);
      expect([at(0, 1), at(0, 2), at(0, 3)]).toEqual([0, 255, 255]);
    });

    it("fills the runs once with the shifted pattern, after the tint", () => {
      const calls: string[] = [];
      const ctx = {
        save: () => calls.push("save"),
        restore: () => calls.push("restore"),
        fill: (_path: unknown, rule?: string) => calls.push(`fill ${ctx.fillStyle} ${rule ?? ""}`),
        fillStyle: "" as unknown,
        imageSmoothingEnabled: true,
      };
      const pattern = { setTransform: vi.fn(), toString: () => "pattern" };
      const runs = {} as Path2D;
      const tint = {} as Path2D;
      paintCrispOutline(
        ctx as unknown as CanvasRenderingContext2D,
        runs,
        pattern as unknown as CanvasPattern,
        { offset: -3, tint },
      );
      expect(pattern.setTransform).toHaveBeenCalledWith({ e: 3, f: 0 });
      expect(calls).toEqual(["save", `fill ${SELECTION_TINT} evenodd`, "fill pattern ", "restore"]);
      expect(ctx.imageSmoothingEnabled).toBe(false);
      calls.length = 0;
      paintCrispOutline(
        ctx as unknown as CanvasRenderingContext2D,
        runs,
        pattern as unknown as CanvasPattern,
        { offset: 0, tint: undefined },
      );
      expect(calls).toEqual(["save", "fill pattern ", "restore"]);
    });
  });
});
