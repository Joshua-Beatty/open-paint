import { describe, expect, it } from "vitest";
import {
  hsvToRgb,
  packRgb,
  rgbToHsv,
  toByte,
  unpackRgb,
  wheelPick,
  wheelPosition,
} from "./color-math";

describe("HSV conversion", () => {
  it("converts the primary and secondary colors", () => {
    expect(rgbToHsv({ r: 1, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 1, b: 0 })).toEqual({ h: 120, s: 1, v: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 1 })).toEqual({ h: 240, s: 1, v: 1 });
    expect(rgbToHsv({ r: 1, g: 1, b: 0 }).h).toBeCloseTo(60, 10);
    expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
  });

  it("wraps negative hues from the red-to-blue sector into [0, 360)", () => {
    expect(rgbToHsv({ r: 1, g: 0, b: 0.5 }).h).toBeCloseTo(330, 10);
  });

  it("round-trips through RGB", () => {
    for (const rgb of [
      { r: 0.2, g: 0.6, b: 0.9 },
      { r: 0.9, g: 0.9, b: 0.1 },
      { r: 0.5, g: 0.5, b: 0.5 },
    ]) {
      const back = hsvToRgb(rgbToHsv(rgb));
      expect(back.r).toBeCloseTo(rgb.r, 10);
      expect(back.g).toBeCloseTo(rgb.g, 10);
      expect(back.b).toBeCloseTo(rgb.b, 10);
    }
  });

  it("accepts hues outside [0, 360)", () => {
    expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual({ r: 1, g: 0, b: 0 });
    expect(hsvToRgb({ h: -120, s: 1, v: 1 }).b).toBeCloseTo(1, 10);
  });
});

describe("packed RGB", () => {
  it("packs channels as 0xRRGGBB and unpacks them again", () => {
    expect(packRgb({ r: 1, g: 0, b: 0 })).toBe(0xff0000);
    expect(packRgb({ r: 0, g: 128 / 255, b: 1 })).toBe(0x0080ff);
    expect(unpackRgb(0x0080ff)).toEqual({ r: 0, g: 128 / 255, b: 1 });
  });

  it("clamps and rounds channels to bytes", () => {
    expect(toByte(1.7)).toBe(255);
    expect(toByte(-0.2)).toBe(0);
    expect(toByte(0.5)).toBe(128);
  });
});

describe("the color wheel", () => {
  it("places hue 0 at 3 o'clock and hue 90 below the centre", () => {
    expect(wheelPosition(0, 1)).toEqual({ x: 1, y: 0 });
    const down = wheelPosition(90, 1);
    expect(down.x).toBeCloseTo(0, 10);
    expect(down.y).toBeCloseTo(1, 10);
  });

  it("picks hue and saturation from an offset, clamping saturation at the rim", () => {
    expect(wheelPick(0.5, 0)).toEqual({ h: 0, s: 0.5 });
    const pick = wheelPick(0, -2);
    expect(pick.h).toBeCloseTo(270, 10);
    expect(pick.s).toBe(1);
  });

  it("is the inverse of its position for points inside the wheel", () => {
    const position = wheelPosition(200, 0.4);
    const pick = wheelPick(position.x, position.y);
    expect(pick.h).toBeCloseTo(200, 10);
    expect(pick.s).toBeCloseTo(0.4, 10);
  });
});
