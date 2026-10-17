import { isEmptyRect, rect, Surface } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import { averageColor, sampleArea, sampleSizeOf } from "./color-sample";

const IMAGE = rect(0, 0, 32, 32);

describe("sampleSizeOf (TL-OPT-PICKER)", () => {
  it("maps each sampling choice to its square side, and a single pixel by default", () => {
    expect(sampleSizeOf("PointSample")).toBe(1);
    expect(sampleSizeOf("Average3x3")).toBe(3);
    expect(sampleSizeOf("Average5x5")).toBe(5);
    expect(sampleSizeOf("Average11x11")).toBe(11);
    expect(sampleSizeOf("Average31x31")).toBe(31);
    expect(sampleSizeOf("Average51x51")).toBe(51);
    expect(sampleSizeOf(undefined)).toBe(1);
    expect(sampleSizeOf("Average7x7")).toBe(1);
  });
});

describe("sampleArea (TL-PICK-01)", () => {
  it("centers the square on the pixel under the point", () => {
    expect(sampleArea(10.7, 4.2, 3, IMAGE)).toEqual(rect(9, 3, 3, 3));
    expect(sampleArea(10, 4, 1, IMAGE)).toEqual(rect(10, 4, 1, 1));
  });

  it("clips the square to the image", () => {
    expect(sampleArea(0, 0, 5, IMAGE)).toEqual(rect(0, 0, 3, 3));
    expect(sampleArea(31, 31, 5, IMAGE)).toEqual(rect(29, 29, 3, 3));
  });

  it("is empty when the square misses the image", () => {
    expect(isEmptyRect(sampleArea(-10, -10, 3, IMAGE))).toBe(true);
    expect(isEmptyRect(sampleArea(40, 4, 1, IMAGE))).toBe(true);
  });
});

describe("averageColor (TL-PICK-01)", () => {
  it("returns a single pixel unchanged", () => {
    const pixel = new Surface(1, 1, new Uint8ClampedArray([200, 100, 50, 128]));
    expect(averageColor(pixel)).toEqual({ r: 200, g: 100, b: 50, a: 128 });
  });

  it("averages the premultiplied colors, so a clear pixel does not darken the average", () => {
    const pair = new Surface(2, 1, new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]));
    expect(averageColor(pair)).toEqual({ r: 255, g: 0, b: 0, a: 128 });
  });

  it("averages opaque pixels per channel", () => {
    const row = new Surface(
      3,
      1,
      new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]),
    );
    expect(averageColor(row)).toEqual({ r: 170, g: 0, b: 85, a: 255 });
  });

  it("is clear black when no pixel is visible", () => {
    const clear = new Surface(2, 1, new Uint8ClampedArray([255, 255, 255, 0, 9, 9, 9, 0]));
    expect(averageColor(clear)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});
