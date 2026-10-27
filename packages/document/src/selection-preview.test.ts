import { describe, expect, it } from "vitest";
import { Document } from "./document";
import { rect } from "./geometry";
import { Selection } from "./selection";
import { ellipsePolygon, rectPolygon } from "./selection-polygons";

describe("combineSelection history names", () => {
  it("names the history item with the given name, and Edit Selection by default", () => {
    const doc = Document.createBlank({ width: 16, height: 16 });
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace", "Rectangle Select");
    expect(doc.history.undoName).toBe("Rectangle Select");
    doc.combineSelection([rectPolygon(rect(6, 0, 2, 2))], "union");
    expect(doc.history.undoName).toBe("Edit Selection");
  });
});

describe("previewSelection (DOC-SEL-02 live preview)", () => {
  it("changes the selection without a history item, and restoring it leaves no trace", () => {
    const doc = Document.createBlank({ width: 16, height: 16 });
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    const entries = doc.history.entries.length;
    const undo = doc.history.undoName;
    const before = doc.selection;

    doc.previewSelection(before.combine([rectPolygon(rect(8, 8, 2, 2))], "union"));
    expect(doc.selection.area()).toBe(20);
    expect(doc.history.entries.length).toBe(entries);
    expect(doc.history.undoName).toBe(undo);

    doc.previewSelection(before);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 4, 4));
    expect(doc.history.entries.length).toBe(entries);
  });
});

/** The ring's vertices as points. */
function pointsOf(ring: readonly number[]): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i + 1 < ring.length; i += 2) points.push([ring[i] ?? 0, ring[i + 1] ?? 0]);
  return points;
}

describe("ellipsePolygon (TL-SEL-ELL-01)", () => {
  it("is inscribed in its rectangle, so its area approaches pi times the radii", () => {
    const ring = ellipsePolygon(rect(0, 0, 40, 20));
    const area = new Selection([ring]).area();
    expect(Math.abs(area - Math.PI * 20 * 10) / (Math.PI * 200)).toBeLessThan(0.01);
    expect(new Selection([ring]).bounds()).toEqual(rect(0, 0, 40, 20));
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 5],
    [7, 4],
    [10, 10],
    [41, 21],
    [3, 200],
    [500, 2],
    [1000, 640],
  ])(
    "at %d x %d has its vertices on pixel corners, convex, with no repeats or straight runs",
    (width, height) => {
      const area = rect(3, 5, width, height);
      const points = pointsOf(ellipsePolygon(area));
      expect(points.length).toBeGreaterThanOrEqual(3);
      for (const [x, y] of points) {
        expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
      }
      let sign = 0;
      for (let i = 0; i < points.length; i++) {
        const o = points[i] as [number, number];
        const a = points[(i + 1) % points.length] as [number, number];
        const b = points[(i + 2) % points.length] as [number, number];
        expect(a[0] !== o[0] || a[1] !== o[1]).toBe(true);
        const turn = (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        // Every corner turns the same way: no straight runs, no dents, no self-touching.
        expect(turn).not.toBe(0);
        sign ||= Math.sign(turn);
        expect(Math.sign(turn)).toBe(sign);
      }
      const selection = new Selection([ellipsePolygon(area)]);
      expect(selection.bounds()).toEqual(area);
      const exact = (Math.PI * width * height) / 4;
      if (Math.min(width, height) >= 20) {
        expect(Math.abs(selection.area() - exact) / exact).toBeLessThan(0.02);
      }
    },
  );
});
