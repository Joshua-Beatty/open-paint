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

describe("ellipsePolygon (TL-SEL-ELL-01)", () => {
  it("is inscribed in its rectangle, so its area approaches pi times the radii", () => {
    const ring = ellipsePolygon(rect(0, 0, 40, 20));
    const area = new Selection([ring]).area();
    expect(Math.abs(area - Math.PI * 20 * 10) / (Math.PI * 200)).toBeLessThan(0.01);
    expect(new Selection([ring]).bounds()).toEqual(rect(0, 0, 40, 20));
  });
});
