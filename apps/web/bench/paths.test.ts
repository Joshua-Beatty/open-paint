// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  circlePath,
  cssToImage,
  dragPath,
  imageToCss,
  linePath,
  panPath,
  scribblePath,
  sliderPath,
  sliderSweepPath,
  strokePath,
  visibleImage,
} from "./paths.ts";

const canvas = { x: 100, y: 50, width: 1000, height: 700 };

describe("strokePath", () => {
  it("keeps the full length when it fits, centered on the image's visible part", () => {
    // Fit: 4000 x 3000 at zoom 0.2 is 800 x 600, at (100, 50) inside the canvas.
    const layout = {
      zoom: 0.2,
      originX: 100,
      originY: 50,
      documentWidth: 4000,
      documentHeight: 3000,
    };
    const path = strokePath(canvas, layout, 1, 3000, 300, 40);
    expect(path.points).toHaveLength(301);
    expect(path.imageLength).toBeCloseTo(3000);
    const first = path.points[0];
    const last = path.points.at(-1);
    expect(
      Math.hypot((last?.x ?? 0) - (first?.x ?? 0), (last?.y ?? 0) - (first?.y ?? 0)),
    ).toBeCloseTo(600);
    expect(((first?.x ?? 0) + (last?.x ?? 0)) / 2).toBeCloseTo(100 + 100 + 400);
  });

  it("shortens a stroke that does not fit to the inset diagonal of the canvas", () => {
    const layout = {
      zoom: 1,
      originX: -1500,
      originY: -1150,
      documentWidth: 4000,
      documentHeight: 3000,
    };
    const path = strokePath(canvas, layout, 1, 3000, 300, 50);
    expect(path.imageLength).toBeCloseTo(Math.hypot(900, 600));
    for (const point of path.points) {
      expect(point.x).toBeGreaterThanOrEqual(150 - 1e-9);
      expect(point.x).toBeLessThanOrEqual(1050 + 1e-9);
    }
  });

  it("converts through the device pixel ratio", () => {
    const layout = { zoom: 1, originX: 0, originY: 0, documentWidth: 4000, documentHeight: 3000 };
    const path = strokePath(canvas, layout, 2, 600, 10, 0);
    expect(path.imageLength).toBeCloseTo(600);
    const first = path.points[0];
    const last = path.points.at(-1);
    expect(
      Math.hypot((last?.x ?? 0) - (first?.x ?? 0), (last?.y ?? 0) - (first?.y ?? 0)),
    ).toBeCloseTo(300);
  });
});

describe("panPath", () => {
  it("returns to its start after the given number of moves", () => {
    const path = panPath({ x: 500, y: 400 }, 200, 240);
    expect(path).toHaveLength(241);
    expect(path[0]?.x).toBeCloseTo(500);
    expect(path.at(-1)?.x).toBeCloseTo(500);
    expect(Math.max(...path.map((p) => p.x))).toBeCloseTo(700);
  });
});

describe("sliderPath", () => {
  it("moves evenly from `from` to `to` along the track's middle", () => {
    const path = sliderPath({ x: 0, y: 10, width: 200, height: 20 }, 0.1, 0.5, 4);
    expect(path.map((p) => Math.round(p.x * 1e6) / 1e6)).toEqual([20, 40, 60, 80, 100]);
    expect(path.every((p) => p.y === 20)).toBe(true);
  });
});

describe("sliderSweepPath", () => {
  it("sweeps back and forth between the two fractions from their midpoint", () => {
    const path = sliderSweepPath({ x: 0, y: 10, width: 200, height: 20 }, 0, 1, 2, 4);
    expect(path.map((p) => Math.round(p.x * 1e6) / 1e6)).toEqual([100, 200, 100, 0, 100]);
    expect(path.every((p) => p.y === 20)).toBe(true);
  });
});

describe("circlePath", () => {
  it("circles the center the given number of turns", () => {
    const path = circlePath({ x: 100, y: 100 }, 50, 2, 8);
    expect(path).toHaveLength(9);
    expect(path[0]?.x).toBeCloseTo(150);
    expect(path[1]?.y).toBeCloseTo(150);
    expect(path[2]?.x).toBeCloseTo(50);
    expect(path[4]?.x).toBeCloseTo(150);
    expect(path.at(-1)?.x).toBeCloseTo(150);
  });
});

describe("scribblePath", () => {
  it("stays inside the area and starts and ends at its center", () => {
    const area = { x: 10, y: 20, width: 400, height: 300 };
    const path = scribblePath(area, 240);
    expect(path).toHaveLength(241);
    expect(path[0]).toEqual({ x: 210, y: 170 });
    expect(path.at(-1)?.x).toBeCloseTo(210);
    expect(path.at(-1)?.y).toBeCloseTo(170);
    for (const point of path) {
      expect(point.x).toBeGreaterThanOrEqual(area.x + area.width * 0.1 - 1e-9);
      expect(point.x).toBeLessThanOrEqual(area.x + area.width * 0.9 + 1e-9);
      expect(point.y).toBeGreaterThanOrEqual(area.y + area.height * 0.1 - 1e-9);
      expect(point.y).toBeLessThanOrEqual(area.y + area.height * 0.9 + 1e-9);
    }
  });
});

describe("linePath", () => {
  it("ends at the target without repeating the start", () => {
    expect(linePath({ x: 0, y: 0 }, { x: 10, y: 20 }, 2)).toEqual([
      { x: 5, y: 10 },
      { x: 10, y: 20 },
    ]);
  });
});

describe("cssToImage and imageToCss", () => {
  const layout = { zoom: 0.5, originX: 40, originY: 20, documentWidth: 800, documentHeight: 600 };

  it("are inverses through the zoom, origin and device pixel ratio", () => {
    const image = cssToImage(canvas, layout, 2, { x: 300, y: 250 });
    expect(image).toEqual({ x: (200 * 2 - 40) / 0.5, y: (200 * 2 - 20) / 0.5 });
    const back = imageToCss(canvas, layout, 2, image);
    expect(back.x).toBeCloseTo(300);
    expect(back.y).toBeCloseTo(250);
  });

  it("clip the image's on-screen box to the canvas", () => {
    expect(visibleImage(canvas, layout, 1)).toEqual({ x: 140, y: 70, width: 400, height: 300 });
    const big = { ...layout, zoom: 4 };
    expect(visibleImage(canvas, big, 1)).toEqual({ x: 140, y: 70, width: 960, height: 680 });
  });
});

describe("dragPath", () => {
  it("starts at the press and ends offset by the drag", () => {
    const path = dragPath({ x: 10, y: 20 }, { x: 240, y: 120 }, 240);
    expect(path).toHaveLength(241);
    expect(path[0]).toEqual({ x: 10, y: 20 });
    expect(path.at(-1)?.x).toBeCloseTo(250);
    expect(path.at(-1)?.y).toBeCloseTo(140);
  });
});
