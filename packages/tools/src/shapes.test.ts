import { describe, expect, it } from "vitest";
import {
  dragBox,
  isDegenerateBox,
  regularPolygon,
  type ShapeParams,
  shapeRings,
  starPolygon,
  substituteShapePath,
} from "./shapes";

const PARAMS: ShapeParams = { radius: 10, tailX: 0.25, tailY: 1.25 };
const RECTANGLE = "M 0,0 L 1,0 L 1,1 L 0,1 Z";

/** The area of a ring by the shoelace formula, in square pixels. */
function area(ring: readonly { readonly x: number; readonly y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a === undefined || b === undefined) continue;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

describe("substituteShapePath", () => {
  const box = { x: 0, y: 0, width: 200, height: 100 };

  it("takes plain tokens as they are", () => {
    expect(substituteShapePath("L {tailX},{tailY}", box, PARAMS)).toBe("L 0.250000000,1.250000000");
  });

  it("turns a pixel length into a unit length per axis, clamped to half the shorter side", () => {
    expect(substituteShapePath("{radius.x} {radius.y}", box, PARAMS)).toBe(
      "0.050000000 0.100000000",
    );
    expect(substituteShapePath("{radius.x}", box, { radius: 500 })).toBe("0.250000000");
  });

  it("takes the complement with the 1- prefix", () => {
    expect(substituteShapePath("{1-radius.x} {1-tailY}", box, PARAMS)).toBe(
      "0.950000000 -0.250000000",
    );
  });

  it("throws for a token with no value", () => {
    expect(() => substituteShapePath("{missing}", box, PARAMS)).toThrow('"missing"');
  });
});

describe("shapeRings", () => {
  it("maps a unit path into the box, in pixels", () => {
    const rings = shapeRings(RECTANGLE, { x: 10, y: 20, width: 30, height: 40 }, PARAMS);
    expect(rings).toEqual([
      [
        { x: 10, y: 20 },
        { x: 40, y: 20 },
        { x: 40, y: 60 },
        { x: 10, y: 60 },
      ],
    ]);
  });

  it("returns nothing for a box with no area", () => {
    expect(shapeRings(RECTANGLE, { x: 0, y: 0, width: 0, height: 5 }, PARAMS)).toEqual([]);
  });

  it("draws an ellipse arc whose area is close to pi a b", () => {
    const path = "M 0,0.5 A 0.5 0.5 0 0 1 1,0.5 A 0.5 0.5 0 0 1 0,0.5 Z";
    const [ring] = shapeRings(path, { x: 0, y: 0, width: 100, height: 50 }, PARAMS);
    expect(ring).toBeDefined();
    const expected = Math.PI * 50 * 25;
    expect(Math.abs(area(ring ?? []) - expected) / expected).toBeLessThan(0.01);
  });

  it("rounds the corners of a rounded rectangle by the radius in pixels", () => {
    const path =
      "M {radius.x},0 L {1-radius.x},0 A {radius.x} {radius.y} 0 0 1 1,{radius.y} L 1,{1-radius.y} " +
      "A {radius.x} {radius.y} 0 0 1 {1-radius.x},1 L {radius.x},1 " +
      "A {radius.x} {radius.y} 0 0 1 0,{1-radius.y} L 0,{radius.y} A {radius.x} {radius.y} 0 0 1 {radius.x},0 Z";
    const [ring] = shapeRings(path, { x: 0, y: 0, width: 100, height: 50 }, { radius: 10 });
    const expected = 100 * 50 - (4 - Math.PI) * 10 * 10;
    expect(Math.abs(area(ring ?? []) - expected) / expected).toBeLessThan(0.01);
    for (const point of ring ?? []) {
      expect(point.x).toBeGreaterThanOrEqual(-1e-9);
      expect(point.x).toBeLessThanOrEqual(100 + 1e-9);
      expect(point.y).toBeGreaterThanOrEqual(-1e-9);
      expect(point.y).toBeLessThanOrEqual(50 + 1e-9);
    }
  });

  it("places the callout tail tip at its handle position", () => {
    const path = "M 0,0 L 1,0 L 1,1 L 0.35,1 L {tailX},{tailY} L 0.15,1 L 0,1 Z";
    const [ring] = shapeRings(path, { x: 10, y: 10, width: 100, height: 50 }, PARAMS);
    expect(ring).toContainEqual({ x: 10 + 0.25 * 100, y: 10 + 1.25 * 50 });
  });

  it("draws cubic curves that stay inside the unit square of a heart", () => {
    const path =
      "M 0.5,1 C 0.5,1 0,0.62 0,0.3 C 0,0.12 0.13,0 0.28,0 C 0.39,0 0.46,0.06 0.5,0.14 Z";
    const [ring] = shapeRings(path, { x: 0, y: 0, width: 80, height: 80 }, PARAMS);
    expect(ring?.length).toBeGreaterThan(20);
    for (const point of ring ?? []) {
      expect(point.x).toBeGreaterThanOrEqual(-1e-9);
      expect(point.x).toBeLessThanOrEqual(80 + 1e-9);
      expect(point.y).toBeGreaterThanOrEqual(-1e-9);
      expect(point.y).toBeLessThanOrEqual(80 + 1e-9);
    }
  });

  it("reads repeated coordinates after a command as the same command", () => {
    const [ring] = shapeRings("M 0,0 1,0 1,1 0,1 Z", { x: 0, y: 0, width: 4, height: 4 }, PARAMS);
    expect(ring).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ]);
  });

  it("rejects commands the subset does not support", () => {
    expect(() => shapeRings("M 0,0 l 1,1", { x: 0, y: 0, width: 1, height: 1 }, PARAMS)).toThrow(
      "unsupported command",
    );
  });
});

describe("regularPolygon and starPolygon", () => {
  it("fits a pentagon to the unit square with its natural aspect ratio", () => {
    const pentagon = regularPolygon(5, -90);
    expect(pentagon.path.startsWith("M 0.500000,0.000000 ")).toBe(true);
    expect(pentagon.path.endsWith(" Z")).toBe(true);
    expect(pentagon.aspect).toBeCloseTo(
      (2 * Math.sin((72 * Math.PI) / 180)) / (1 + Math.cos((36 * Math.PI) / 180)),
      6,
    );
  });

  it("gives a hexagon with its vertex up the width-to-height ratio of sqrt(3)/2", () => {
    expect(regularPolygon(6, -90).aspect).toBeCloseTo(Math.sqrt(3) / 2, 6);
  });

  it("alternates outer and inner vertices for a star, with the inner ratio of TL-SHAPE-02", () => {
    const star = starPolygon(5, 0.381966, -90);
    expect(star.path.split(" L ")).toHaveLength(10);
    const rings = shapeRings(star.path, { x: 0, y: 0, width: 100, height: 100 }, PARAMS);
    expect(rings[0]).toHaveLength(10);
  });
});

describe("dragBox", () => {
  const plain = { aspect: 1, constrain: false, fromCenter: false };

  it("spans the drag from the anchor to the point, on whole pixel corners", () => {
    expect(dragBox({ x: 5.4, y: 9.6 }, { x: 25.6, y: 19.2 }, plain)).toEqual({
      left: 5,
      top: 10,
      right: 26,
      bottom: 19,
    });
  });

  it("orders the corners when the drag goes up or to the left", () => {
    expect(dragBox({ x: 20, y: 20 }, { x: 10, y: 5 }, plain)).toEqual({
      left: 10,
      top: 5,
      right: 20,
      bottom: 20,
    });
  });

  it("keeps the aspect ratio under Shift, and grows the box to hold the point", () => {
    const square = dragBox({ x: 5, y: 5 }, { x: 25, y: 15 }, { ...plain, constrain: true });
    expect(square).toEqual({ left: 5, top: 5, right: 25, bottom: 25 });
    const wide = dragBox(
      { x: 0, y: 0 },
      { x: 40, y: 10 },
      { aspect: 2, constrain: true, fromCenter: false },
    );
    expect(wide).toEqual({ left: 0, top: 0, right: 40, bottom: 20 });
  });

  it("makes the anchor the center under Alt", () => {
    expect(dragBox({ x: 15, y: 15 }, { x: 20, y: 20 }, { ...plain, fromCenter: true })).toEqual({
      left: 10,
      top: 10,
      right: 20,
      bottom: 20,
    });
  });

  it("finds a drag with no area degenerate", () => {
    expect(isDegenerateBox(dragBox({ x: 3, y: 3 }, { x: 3, y: 9 }, plain))).toBe(true);
    expect(isDegenerateBox(dragBox({ x: 3, y: 3 }, { x: 4, y: 9 }, plain))).toBe(false);
  });
});
