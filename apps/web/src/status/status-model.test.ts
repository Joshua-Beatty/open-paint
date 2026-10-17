import { DEFAULT_RESOLUTION, Selection } from "@openpaint/document";
import { MAX_ZOOM, MIN_ZOOM, type ViewLayout } from "@openpaint/engine";
import { t } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import {
  cursorText,
  formatMeasure,
  imagePixelAt,
  imageSizeText,
  measureUnit,
  menuUnitOf,
  parseZoomEntry,
  selectionAngle,
  selectionText,
  zoomFromSliderValue,
  zoomPercent,
  zoomSliderValue,
} from "./status-model";

const layout: ViewLayout = {
  mode: "fixed",
  zoom: 2,
  originX: 10,
  originY: 0,
  documentWidth: 100,
  documentHeight: 50,
};

describe("units", () => {
  it("reads the stored unit and falls back to pixels", () => {
    expect(measureUnit("Inch")).toBe("Inch");
    expect(measureUnit("Centimeter")).toBe("Centimeter");
    expect(measureUnit("Furlong")).toBe("Pixel");
    expect(measureUnit(undefined)).toBe("Pixel");
  });

  it("maps units to the View menu's checkmark names", () => {
    expect(menuUnitOf("Pixel")).toBe("pixels");
    expect(menuUnitOf("Inch")).toBe("inches");
    expect(menuUnitOf("Centimeter")).toBe("centimeters");
  });

  it("formats whole pixels and two decimals for physical units", () => {
    expect(formatMeasure(3, "Pixel")).toBe("3");
    expect(formatMeasure(2.5, "Pixel")).toBe("3");
    expect(formatMeasure(1 / 3, "Inch")).toBe("0.33");
    expect(formatMeasure(2, "Centimeter")).toBe("2");
    expect(formatMeasure(Number.NaN, "Inch")).toBe("0");
    expect(formatMeasure(-0, "Inch")).toBe("0");
  });
});

describe("zoom entry (UI-SB-03)", () => {
  it("removes % and spaces, then divides by 100", () => {
    expect(parseZoomEntry("50%")).toBe(0.5);
    expect(parseZoomEntry(" 200 % ")).toBe(2);
    expect(parseZoomEntry("12.5")).toBe(0.125);
  });

  it("rejects empty, zero, negative, non-numeric and infinite input", () => {
    for (const text of ["", "%", " ", "0", "0%", "-5", "abc", "Infinity"]) {
      expect(parseZoomEntry(text)).toBeUndefined();
    }
  });

  it("shows the whole percent of a ratio", () => {
    expect(zoomPercent(1 / 3)).toBe(33);
    expect(zoomPercent(2)).toBe(200);
    expect(zoomPercent(MIN_ZOOM)).toBe(1);
  });
});

describe("zoom slider", () => {
  it("spans the zoom range on a logarithmic scale", () => {
    expect(zoomSliderValue(MIN_ZOOM)).toBe(0);
    expect(zoomSliderValue(MAX_ZOOM)).toBe(1000);
    expect(zoomSliderValue(1)).toBe(500);
    expect(zoomSliderValue(MIN_ZOOM / 10)).toBe(0);
  });

  it("maps a slider position back to a zoom ratio", () => {
    expect(zoomFromSliderValue(0)).toBeCloseTo(MIN_ZOOM);
    expect(zoomFromSliderValue(500)).toBeCloseTo(1);
    expect(zoomFromSliderValue(1000)).toBeCloseTo(MAX_ZOOM);
  });
});

describe("cursor position", () => {
  it("maps a device point to the image pixel under it", () => {
    expect(imagePixelAt(layout, { x: 10, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(imagePixelAt(layout, { x: 10 + 199, y: 99 })).toEqual({ x: 99, y: 49 });
  });

  it("is undefined outside the image", () => {
    expect(imagePixelAt(layout, { x: 9, y: 0 })).toBeUndefined();
    expect(imagePixelAt(layout, { x: 10 + 200, y: 0 })).toBeUndefined();
    expect(imagePixelAt(layout, { x: 10, y: -1 })).toBeUndefined();
  });

  it("formats the pixel in the chosen unit", () => {
    expect(cursorText({ x: 3, y: 4 }, DEFAULT_RESOLUTION, "Pixel", t)).toBe("3, 4");
    expect(cursorText({ x: 96, y: 48 }, DEFAULT_RESOLUTION, "Inch", t)).toBe("1, 0.5");
  });
});

describe("image size", () => {
  it("shows the size in pixels and in physical units", () => {
    expect(imageSizeText(8192, 8192, DEFAULT_RESOLUTION, "Pixel", t)).toBe("8192 × 8192");
    expect(imageSizeText(8192, 8192, DEFAULT_RESOLUTION, "Inch", t)).toBe("85.33 × 85.33");
    expect(imageSizeText(96, 96, { unit: "centimeter", x: 37.8, y: 37.8 }, "Centimeter", t)).toBe(
      "2.54 × 2.54",
    );
  });
});

describe("selection readout (UI-SB-02)", () => {
  it("gives the top left, the bounding size and the true area in pixels", () => {
    const selection = Selection.all({ width: 10, height: 20 });
    expect(selectionText(selection, DEFAULT_RESOLUTION, "Pixel", t)).toBe(
      "Selection top left: 0px, 0px. Bounding rectangle size: 10px × 20px. Area: 200 pixels square",
    );
  });

  it("uses singular unit names for a unit area", () => {
    const selection = Selection.all({ width: 1, height: 1 });
    expect(selectionText(selection, DEFAULT_RESOLUTION, "Pixel", t)).toContain(
      "Area: 1 pixel square",
    );
  });

  it("converts lengths and area with the document resolution", () => {
    const selection = Selection.all({ width: 10, height: 20 });
    expect(selectionText(selection, DEFAULT_RESOLUTION, "Inch", t)).toBe(
      "Selection top left: 0in, 0in. Bounding rectangle size: 0.1in × 0.21in. Area: 0.02 inches square",
    );
  });

  it("adds the angle of a rotated pending transform", () => {
    const selection = Selection.all({ width: 10, height: 20 }).transform({
      a: 0,
      b: 1,
      c: -1,
      d: 0,
      e: 0,
      f: 0,
    });
    expect(selectionAngle(selection)).toBeCloseTo(90);
    expect(selectionText(selection, DEFAULT_RESOLUTION, "Pixel", t)).toContain(
      "Bounding rectangle size: 20px × 10px",
    );
    expect(selectionText(selection, DEFAULT_RESOLUTION, "Pixel", t)).toMatch(/\. Angle: 90°$/);
  });

  it("adds no angle for a selection that only scales or moves", () => {
    const selection = Selection.all({ width: 10, height: 20 }).transform({
      a: 2,
      b: 0,
      c: 0,
      d: 1,
      e: 5,
      f: 0,
    });
    expect(selectionAngle(selection)).toBeUndefined();
    expect(selectionText(selection, DEFAULT_RESOLUTION, "Pixel", t)).not.toContain("Angle");
  });
});
