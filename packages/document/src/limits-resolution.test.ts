import { describe, expect, it } from "vitest";
import { isValidImageDimension, isValidImageSize, MAX_IMAGE_SIZE, WORKSPACE_RECT } from "./limits";
import {
  convertDotsPerUnit,
  convertLength,
  convertResolution,
  DEFAULT_DPCM,
  DEFAULT_RESOLUTION,
  isValidResolution,
  physicalToPixels,
  pixelAreaToPhysical,
  pixelsToPhysical,
} from "./resolution";

describe("canvas size limits (DOC-DOC-01)", () => {
  it("accepts integer sizes in [1, 262144]", () => {
    expect(MAX_IMAGE_SIZE).toBe(262_144);
    expect(isValidImageSize(1, 1)).toBe(true);
    expect(isValidImageSize(262_144, 262_144)).toBe(true);
    expect(isValidImageSize(0, 10)).toBe(false);
    expect(isValidImageSize(10, 262_145)).toBe(false);
    expect(isValidImageDimension(1.5)).toBe(false);
  });

  it("defines the workspace coordinate space", () => {
    expect(WORKSPACE_RECT).toEqual({
      x: -524_288,
      y: -524_288,
      width: 1_048_576,
      height: 1_048_576,
    });
  });
});

describe("resolution (DOC-DOC-03)", () => {
  it("defaults to 96 pixels per inch", () => {
    expect(DEFAULT_RESOLUTION).toEqual({ unit: "inch", x: 96, y: 96 });
    expect(DEFAULT_DPCM).toBeCloseTo(37.7952755905512, 12);
  });

  it("validates the range and the pixel unit", () => {
    expect(isValidResolution({ unit: "inch", x: 0.01, y: 65_536 })).toBe(true);
    expect(isValidResolution({ unit: "centimeter", x: 0.009, y: 1 })).toBe(false);
    expect(isValidResolution({ unit: "inch", x: 1, y: 65_537 })).toBe(false);
    expect(isValidResolution({ unit: "pixel", x: 1, y: 1 })).toBe(true);
    expect(isValidResolution({ unit: "pixel", x: 96, y: 96 })).toBe(false);
  });

  it("converts dots per unit between units, keeping X and Y separate", () => {
    expect(convertDotsPerUnit(96, "inch", "centimeter")).toBeCloseTo(DEFAULT_DPCM, 12);
    expect(convertDotsPerUnit(DEFAULT_DPCM, "centimeter", "inch")).toBeCloseTo(96, 12);
    expect(convertDotsPerUnit(300, "inch", "pixel")).toBe(1);
    expect(convertDotsPerUnit(1, "pixel", "inch")).toBe(96);
    expect(convertResolution({ unit: "inch", x: 254, y: 127 }, "centimeter")).toEqual({
      unit: "centimeter",
      x: 100,
      y: 50,
    });
  });

  it("converts between pixels, physical lengths and areas", () => {
    expect(pixelsToPhysical(192, 96)).toBe(2);
    expect(physicalToPixels(2, 96)).toBe(192);
    expect(convertLength(1, "inch", "centimeter")).toBeCloseTo(2.54, 12);
    expect(convertLength(2.54, "centimeter", "inch")).toBeCloseTo(1, 12);
    expect(pixelAreaToPhysical(96 * 96 * 6, { unit: "inch", x: 96, y: 96 })).toBe(6);
  });
});
