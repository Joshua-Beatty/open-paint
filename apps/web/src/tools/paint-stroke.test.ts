import { isEmptyRect, LayerBlendMode, rect } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import {
  blendValue,
  brushOptionsFor,
  hatchValue,
  selectionCoverage,
  strokeReach,
  strokeRegion,
  type ToolRead,
} from "./paint-stroke";

const BLACK = { r: 0, g: 0, b: 0, a: 255 };
const WHITE = { r: 255, g: 255, b: 255, a: 255 };
const RED = { r: 255, g: 0, b: 0, a: 255 };

/** A tool reader over a plain record of `tools.*` values, keyed by the name under the tree. */
function readerOf(values: Record<string, unknown>): ToolRead {
  return (name) => values[name];
}

describe("option mapping", () => {
  it("maps blend mode names to the layer values and Overwrite to 14", () => {
    expect(blendValue("normal")).toBe(LayerBlendMode.normal);
    expect(blendValue("multiply")).toBe(LayerBlendMode.multiply);
    expect(blendValue("xor")).toBe(LayerBlendMode.xor);
    expect(blendValue("overwrite")).toBe(14);
    expect(blendValue("nonsense")).toBe(LayerBlendMode.normal);
    expect(blendValue(7)).toBe(LayerBlendMode.normal);
  });

  it("gives the hatch pattern only for a Hatch fill, in the order of TL-OPT-FILL", () => {
    expect(hatchValue("Solid", "Cross")).toBe(0);
    expect(hatchValue("Hatch", "Horizontal")).toBe(1);
    expect(hatchValue("Hatch", "BackwardDiagonal")).toBe(4);
    expect(hatchValue("Hatch", "DottedGrid")).toBe(8);
    expect(hatchValue("Hatch", "Unknown")).toBe(0);
  });

  it("reads the Paintbrush options from the tool settings", () => {
    const options = brushOptionsFor(
      readerOf({
        "brush.size": 12,
        "brush.hardness": 0.4,
        "brush.spacing": 0.5,
        "brush.type": "Square",
        inputSmoothing: "Disabled",
        antialiasing: false,
        "brush.pressure": false,
        blendMode: "overwrite",
        "brush.fillType": "Hatch",
        "brush.hatchStyle": "Percent50",
      }),
      "paint",
      RED,
      WHITE,
    );
    expect(options).toEqual({
      size: 12,
      hardness: 0.4,
      spacing: 0.5,
      square: true,
      smooth: false,
      antialias: false,
      pressure: false,
      erase: false,
      blend: 14,
      hatch: 7,
      color: RED,
      background: WHITE,
    });
  });

  it("uses the factory values for missing settings and ignores blend and fill for the Eraser", () => {
    const options = brushOptionsFor(
      readerOf({ "brush.size": Number.NaN, blendMode: "multiply", "brush.fillType": "Hatch" }),
      "erase",
      RED,
      WHITE,
    );
    expect(options).toMatchObject({
      size: 2,
      hardness: 0.75,
      spacing: 0.15,
      square: false,
      smooth: true,
      antialias: true,
      pressure: true,
      erase: true,
      blend: LayerBlendMode.normal,
      hatch: 0,
    });
  });

  it("gives a brush the reach of its radius plus one pixel, and a pencil one pixel", () => {
    const brush = brushOptionsFor(readerOf({ "brush.size": 10 }), "paint", BLACK, WHITE);
    expect(strokeReach({ kind: "brush", options: brush })).toBe(6);
    expect(strokeReach({ kind: "pencil", color: BLACK, blend: 0 })).toBe(1);
  });
});

describe("stroke region and coverage", () => {
  const bounds = rect(0, 0, 40, 30);

  it("covers the samples plus the reach and margin, clipped to the image", () => {
    const region = strokeRegion([{ x: 5, y: 5, pressure: 1 }], 2, bounds);
    // The sample at x = 5 reaches 5 + 2 + 32 = 39 to the right and 5 - 34 = -29 to the left.
    expect(region).toEqual(rect(0, 0, 39, 30));
    const far = strokeRegion([{ x: 200, y: 100, pressure: 1 }], 2, rect(0, 0, 400, 400));
    expect(far).toEqual(rect(200 - 34, 100 - 34, 68, 68));
  });

  it("is empty when the stroke lies wholly off the image", () => {
    expect(isEmptyRect(strokeRegion([{ x: -500, y: -500, pressure: 1 }], 2, bounds))).toBe(true);
  });

  it("is undefined without a selection, and thresholds a pixelated selection", () => {
    const region = rect(0, 0, 2, 1);
    const none = { isEmpty: true, mask: () => new Uint8Array(2) };
    expect(selectionCoverage(none, region, false)).toBeUndefined();
    const partial = { isEmpty: false, mask: () => Uint8Array.from([100, 200]) };
    expect(selectionCoverage(partial, region, false)).toEqual(Uint8Array.from([100, 200]));
    expect(selectionCoverage(partial, region, true)).toEqual(Uint8Array.from([0, 255]));
  });
});
