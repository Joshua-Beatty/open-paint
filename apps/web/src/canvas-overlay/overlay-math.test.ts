import { type ViewLayout, viewLayout } from "@openpaint/engine";
import { describe, expect, it } from "vitest";
import {
  gridLines,
  gridOpacity,
  rulerScale,
  rulerTicks,
  viewPoint,
  visibleImageRect,
} from "./overlay-math";

describe("viewPoint", () => {
  it("maps an image point to device pixels with the origin and zoom", () => {
    expect(viewPoint({ originX: 10, originY: 20, zoom: 4 }, { x: 2, y: 3 })).toEqual({
      x: 18,
      y: 32,
    });
  });

  it("gives nothing without a layout", () => {
    expect(viewPoint(undefined, { x: 2, y: 3 })).toBeUndefined();
  });
});

function layout(overrides: Partial<ViewLayout>): ViewLayout {
  return {
    mode: "fixed",
    zoom: 4,
    originX: 0,
    originY: 0,
    documentWidth: 100,
    documentHeight: 100,
    ...overrides,
  };
}

describe("gridOpacity (UI-VIEW-03, by on-screen pixel size)", () => {
  it("fades in from 3 to 5 CSS pixels per image pixel at a device pixel ratio of 1", () => {
    expect(gridOpacity(1, 1)).toBe(0);
    expect(gridOpacity(2, 1)).toBe(0);
    expect(gridOpacity(3, 1)).toBe(0);
    expect(gridOpacity(3.5, 1)).toBeCloseTo(0.125);
    expect(gridOpacity(4, 1)).toBeCloseTo(0.25);
    expect(gridOpacity(5, 1)).toBeCloseTo(0.5);
    expect(gridOpacity(6, 1)).toBeCloseTo(0.5);
    expect(gridOpacity(64, 1)).toBeCloseTo(0.5);
  });

  it("measures in CSS pixels, so denser displays need a higher device zoom", () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      expect(gridOpacity(2 * dpr, dpr)).toBe(0);
      expect(gridOpacity(3 * dpr, dpr)).toBe(0);
      expect(gridOpacity(4 * dpr, dpr)).toBeCloseTo(0.25);
      expect(gridOpacity(5 * dpr, dpr)).toBeCloseTo(0.5);
    }
    // 200 % on a 2x display is one CSS pixel per image pixel: no grid.
    expect(gridOpacity(2, 2)).toBe(0);
    expect(gridOpacity(4, 1.5)).toBe(0);
    // 400 % on a 2x display is two CSS pixels per image pixel: still no grid.
    expect(gridOpacity(4, 2)).toBe(0);
  });

  it("does not depend on the image size", () => {
    const viewport = { width: 1600, height: 1000 };
    for (const dpr of [1, 1.5, 2]) {
      for (const size of [16, 1000, 12000, 40000]) {
        const doc = { width: size, height: size };
        for (const zoom of [1, 2, 3].map((css) => css * dpr)) {
          const fixed = viewLayout({ mode: "fixed", zoom, originX: 0, originY: 0 }, doc, viewport);
          expect(gridOpacity(fixed.zoom, dpr)).toBe(0);
        }
        const fixed = viewLayout(
          { mode: "fixed", zoom: 4 * dpr, originX: 0, originY: 0 },
          doc,
          viewport,
        );
        expect(gridOpacity(fixed.zoom, dpr)).toBeCloseTo(0.25);
      }
    }
  });
});

describe("gridLines", () => {
  it("places a line at every pixel boundary of the image on screen", () => {
    const lines = gridLines(
      layout({ originX: 10, originY: 10, documentWidth: 3, documentHeight: 3 }),
      {
        width: 100,
        height: 100,
      },
    );
    expect(lines.x).toEqual([10, 14, 18, 22]);
    expect(lines.y).toEqual([10, 14, 18, 22]);
    expect(lines.area).toEqual({ left: 10, top: 10, right: 22, bottom: 22 });
  });

  it("keeps only the boundaries inside the viewport when the image is scrolled", () => {
    const lines = gridLines(layout({ originX: -6, documentWidth: 100 }), { width: 20, height: 20 });
    expect(lines.x).toEqual([2, 6, 10, 14, 18]);
    expect(lines.area.left).toBe(0);
    expect(lines.area.right).toBe(20);
  });
});

describe("rulerScale (UI-VIEW-04)", () => {
  it("uses 1, 2 and 5 steps for pixels, halving then dividing by 5", () => {
    expect(rulerScale("Pixel", 1, 1, 1)).toEqual({ major: 100, minor: 5, decimals: 0 });
  });

  it("halves inches from the step that keeps major ticks apart", () => {
    const scale = rulerScale("Inch", 1 / 300, 1, 1);
    expect(scale.major).toBe(0.25);
    expect(scale.minor).toBeCloseTo(0.03125);
    expect(scale.decimals).toBe(2);
  });

  it("divides centimeters into 2 and then 5", () => {
    const scale = rulerScale("Centimeter", 2.54 / 96, 1, 1);
    expect(scale.major).toBe(2);
    expect(scale.minor).toBeCloseTo(0.2);
    expect(scale.decimals).toBe(0);
  });

  it("scales the spacing limits by the device pixel ratio", () => {
    const at2x = rulerScale("Pixel", 1, 1, 2);
    expect(at2x.major).toBe(200);
  });
});

describe("rulerTicks", () => {
  it("labels the major ticks with the unit value", () => {
    const scale = { major: 100, minor: 50, decimals: 0 };
    const ticks = rulerTicks(scale, 1, 1, 0, 200);
    expect(ticks.map((tick) => tick.position)).toEqual([0, 50, 100, 150, 200]);
    expect(ticks.filter((tick) => tick.major).map((tick) => tick.label)).toEqual([
      "0",
      "100",
      "200",
    ]);
  });

  it("follows the image origin and skips ticks outside the ruler", () => {
    const scale = { major: 100, minor: 50, decimals: 0 };
    const ticks = rulerTicks(scale, 1, 2, 30, 200);
    expect(ticks.map((tick) => tick.position)).toEqual([30, 130]);
    expect(ticks.map((tick) => tick.major)).toEqual([true, false]);
  });
});

describe("visibleImageRect", () => {
  const layout: ViewLayout = {
    mode: "fixed",
    zoom: 2,
    originX: -100,
    originY: 50,
    documentWidth: 400,
    documentHeight: 300,
  };

  it("is the image part the view shows, in whole image pixels", () => {
    expect(visibleImageRect(layout, { width: 301, height: 200 })).toEqual({
      x: 50,
      y: 0,
      width: 151,
      height: 75,
    });
  });

  it("is undefined without a layout or when nothing is on screen", () => {
    expect(visibleImageRect(undefined, { width: 10, height: 10 })).toBeUndefined();
    expect(
      visibleImageRect({ ...layout, originY: 500 }, { width: 300, height: 200 }),
    ).toBeUndefined();
  });
});
