import { describe, expect, it } from "vitest";
import {
  expandedCanvasSize,
  formatSelectionOutline,
  imageOutline,
  parseSelectionOutline,
  pasteExceedsCanvas,
  pastePosition,
} from "./clipboard";
import { rect } from "./geometry";
import { Surface } from "./surface";

describe("selection outline format (DOC-CLP-03)", () => {
  it("writes polygons as comma-separated coordinate strings", () => {
    expect(formatSelectionOutline([[0, 0, 4, 0, 0, 4]])).toBe('{"polygonList":["0,0,4,0,0,4"]}');
  });

  it("round-trips fractional and very large values exactly", () => {
    const polygons = [[0.1, 0.2, 1 / 3, -7.25, 1e21, 2 ** -20]];
    expect(parseSelectionOutline(formatSelectionOutline(polygons))).toEqual(polygons);
  });

  it("reads an empty list as an empty selection", () => {
    expect(parseSelectionOutline('{"polygonList":[]}')).toEqual([]);
  });

  it.each([
    ["not JSON", "{polygon"],
    ["a JSON value that is not an object", "[1,2]"],
    ["a missing list", '{"points":[]}'],
    ["a list that is not an array", '{"polygonList":"0,0"}'],
    ["a polygon that is not a string", '{"polygonList":[[0,0]]}'],
    ["an odd coordinate count", '{"polygonList":["0,0,4"]}'],
    ["an empty polygon string", '{"polygonList":[""]}'],
    ["an empty coordinate", '{"polygonList":["0,,4,0"]}'],
    ["a non-finite coordinate", '{"polygonList":["0,0,Infinity,0"]}'],
    ["a non-numeric coordinate", '{"polygonList":["0,0,x,0"]}'],
  ])("rejects %s", (_, text) => {
    expect(parseSelectionOutline(text)).toBeUndefined();
  });
});

describe("expand-canvas decision (DOC-CLP-05)", () => {
  it("flags only images larger than the canvas in some dimension", () => {
    expect(pasteExceedsCanvas({ width: 10, height: 10 }, { width: 10, height: 10 })).toBe(false);
    expect(pasteExceedsCanvas({ width: 10, height: 10 }, { width: 11, height: 4 })).toBe(true);
    expect(pasteExceedsCanvas({ width: 10, height: 10 }, { width: 4, height: 11 })).toBe(true);
  });

  it("expands to the larger size in each dimension", () => {
    expect(expandedCanvasSize({ width: 10, height: 40 }, { width: 25, height: 12 })).toEqual({
      width: 25,
      height: 40,
    });
  });
});

describe("paste placement (DOC-CLP-05)", () => {
  const canvas = { width: 100, height: 80 };
  const image = { width: 20, height: 10 };

  it("returns to the original location when it is visible", () => {
    const at = pastePosition(canvas, image, rect(0, 0, 100, 80), { x: 30, y: 40 });
    expect(at).toEqual({ x: 30, y: 40, reveal: false });
  });

  it("goes to the top-left of the visible part when the original location is hidden", () => {
    const at = pastePosition(canvas, image, rect(50, 20, 40, 40), { x: 5, y: 5 });
    expect(at).toEqual({ x: 50, y: 20, reveal: false });
  });

  it("uses the top-left of the visible part when there is no original location", () => {
    expect(pastePosition(canvas, image, rect(10, 12, 30, 30))).toEqual({
      x: 10,
      y: 12,
      reveal: false,
    });
  });

  it("clamps the position so the image stays on the canvas", () => {
    expect(pastePosition(canvas, image, rect(90, 75, 30, 30))).toEqual({
      x: 80,
      y: 70,
      reveal: false,
    });
  });

  it("starts an image larger than the canvas at the canvas origin", () => {
    expect(
      pastePosition({ width: 10, height: 10 }, { width: 30, height: 30 }, rect(4, 4, 6, 6)),
    ).toEqual({ x: 0, y: 0, reveal: false });
  });

  it("asks for the view to be centred when no part of the canvas is visible", () => {
    expect(pastePosition(canvas, image, rect(200, 200, 10, 10))).toEqual({
      x: 0,
      y: 0,
      reveal: true,
    });
  });
});

describe("pasted outline", () => {
  it("falls back to the bitmap bounds when there is no outline", () => {
    expect(imageOutline({ pixels: new Surface(3, 2) })).toEqual([[0, 0, 3, 0, 3, 2, 0, 2]]);
  });

  it("keeps an outline that was copied", () => {
    expect(imageOutline({ pixels: new Surface(3, 2), outline: [[0, 0, 1, 0, 0, 1]] })).toEqual([
      [0, 0, 1, 0, 0, 1],
    ]);
  });
});
