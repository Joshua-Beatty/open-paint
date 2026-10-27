import { rect } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import {
  CornerPath,
  combineModeFor,
  combineModeOf,
  dragRect,
  drawModeOf,
  fixedSizeRect,
  lengthInPixels,
  ratioRect,
  sizeUnitOf,
} from "./select-geometry";

const at = (x: number, y: number) => ({ x, y });
const RESOLUTION = { unit: "inch", x: 96, y: 96 } as const;

describe("combineModeFor (TL-SEL-01)", () => {
  const press = (button: number, modifiers: { ctrl?: boolean; alt?: boolean } = {}) => ({
    button,
    ctrlKey: modifiers.ctrl === true,
    altKey: modifiers.alt === true,
  });

  it("maps the modifier and button pairs, and otherwise uses the toolbar mode", () => {
    expect(combineModeFor(press(0, { ctrl: true }), "replace")).toBe("union");
    expect(combineModeFor(press(0, { alt: true }), "replace")).toBe("exclude");
    expect(combineModeFor(press(2, { ctrl: true }), "replace")).toBe("xor");
    expect(combineModeFor(press(2, { alt: true }), "replace")).toBe("intersect");
    expect(combineModeFor(press(0), "intersect")).toBe("intersect");
    expect(combineModeFor(press(2, { ctrl: true }), "union")).toBe("xor");
    expect(combineModeFor(press(0, { ctrl: true }), "xor")).toBe("union");
  });

  it("reads the Alt modifier of each button as that button's mode", () => {
    expect(combineModeFor(press(2, { alt: true }), "union")).toBe("intersect");
    expect(combineModeFor(press(0, { alt: true }), "union")).toBe("exclude");
  });
});

describe("toolbar choices", () => {
  it("reads the Selection Mode, Draw mode and units choices, with defaults", () => {
    expect(combineModeOf("Xor")).toBe("xor");
    expect(combineModeOf("Exclude")).toBe("exclude");
    expect(combineModeOf(undefined)).toBe("replace");
    expect(drawModeOf("FixedRatio")).toBe("fixedRatio");
    expect(drawModeOf("FixedSize")).toBe("fixedSize");
    expect(drawModeOf("Anything")).toBe("normal");
    expect(sizeUnitOf("Centimeter")).toBe("centimeter");
    expect(sizeUnitOf(undefined)).toBe("pixel");
  });
});

describe("dragRect (TL-SEL-RECT-01)", () => {
  it("spans the floored start and end pixels inclusively", () => {
    expect(dragRect(at(2, 3), at(5, 6), false)).toEqual(rect(2, 3, 4, 4));
  });

  it("grows toward the start when the drag runs up or left", () => {
    expect(dragRect(at(5, 6), at(2, 3), false)).toEqual(rect(2, 3, 4, 4));
  });

  it("constrains to a square with the longer side", () => {
    expect(dragRect(at(2, 2), at(9, 5), true)).toEqual(rect(2, 2, 8, 8));
    expect(dragRect(at(9, 9), at(7, 2), true)).toEqual(rect(2, 2, 8, 8));
  });
});

describe("ratioRect (TL-SEL-RECT-01 Fixed Ratio)", () => {
  it("keeps the width to height ratio, with the drag setting the larger side", () => {
    expect(ratioRect(at(0, 0), at(9, 2), 2)).toEqual(rect(0, 0, 10, 5));
    expect(ratioRect(at(0, 0), at(3, 9), 2)).toEqual(rect(0, 0, 20, 10));
  });
});

describe("fixedSizeRect (TL-SEL-RECT-01 Fixed Size)", () => {
  const canvas = { width: 32, height: 32 };

  it("places the size at the point", () => {
    expect(fixedSizeRect(at(4, 5), 10, 4, canvas)).toEqual(rect(4, 5, 10, 4));
  });

  it("moves the rectangle back inside the image where it would hang over an edge", () => {
    expect(fixedSizeRect(at(28, 30), 10, 4, canvas)).toEqual(rect(22, 28, 10, 4));
  });

  it("rounds the size to whole pixels, at least one pixel", () => {
    expect(fixedSizeRect(at(0, 0), 0.2, 2.6, canvas)).toEqual(rect(0, 0, 1, 3));
  });
});

describe("lengthInPixels", () => {
  it("converts the chosen units to pixels with the document resolution", () => {
    expect(lengthInPixels(400, "pixel", RESOLUTION)).toBe(400);
    expect(lengthInPixels(2, "inch", RESOLUTION)).toBe(192);
    expect(lengthInPixels(2.54, "centimeter", RESOLUTION)).toBeCloseTo(96, 6);
    expect(lengthInPixels(1, "inch", { unit: "centimeter", x: 37.795, y: 37.795 })).toBeCloseTo(
      96,
      0,
    );
  });
});

describe("CornerPath (TL-SEL-LASSO-01, pixel corners)", () => {
  const trace = (samples: readonly [number, number][]) => {
    const path = new CornerPath();
    for (const [x, y] of samples) path.add({ x, y });
    return path.points;
  };

  it("starts at the corner nearest the press", () => {
    expect(trace([[3.4, 7.6]])).toEqual([at(3, 8)]);
  });

  it("draws straight runs at any slope as one edge, between corners", () => {
    const samples: [number, number][] = [];
    for (let i = 0; i <= 40; i++) samples.push([i / 4, i / 8]);
    expect(trace(samples)).toEqual([at(0, 0), at(10, 5)]);
  });

  it("starts a new edge where the pointer turns, and never repeats a corner", () => {
    const samples: [number, number][] = [];
    for (let i = 0; i <= 20; i++) samples.push([i / 2, 0.1]);
    for (let i = 1; i <= 20; i++) samples.push([10 - 0.1, i / 2]);
    const points = trace(samples);
    expect(points).toEqual([at(0, 0), at(10, 0), at(10, 10)]);
  });

  it("moves by whole pixels", () => {
    const path = new CornerPath();
    path.add({ x: 1, y: 1 });
    path.add({ x: 4, y: 1 });
    path.translate(2, -1);
    expect(path.points).toEqual([at(3, 0), at(6, 0)]);
  });
});
