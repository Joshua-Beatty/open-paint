import { describe, expect, it } from "vitest";
import {
  argbHex,
  clampChannel,
  hsvToRgb,
  parseArgbHex,
  parseRgbHex,
  rgbHex,
  rgbToHsv,
  sliderBackground,
  swatchBackground,
  wheelPick,
  wheelPosition,
  wheelSaturationGradient,
} from "./color-math";

const NO_MODIFIERS = { shift: false, ctrl: false, alt: false };

describe("color conversions", () => {
  it("converts primaries and grays to HSV", () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0, a: 255 })).toEqual({ h: 0, s: 100, v: 100 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0, a: 255 })).toEqual({ h: 120, s: 100, v: 100 });
    expect(rgbToHsv({ r: 0, g: 0, b: 255, a: 255 })).toEqual({ h: 240, s: 100, v: 100 });
    expect(rgbToHsv({ r: 128, g: 128, b: 128, a: 255 })).toMatchObject({ s: 0 });
  });

  it("wraps negative hues into [0, 360)", () => {
    const hue = rgbToHsv({ r: 255, g: 0, b: 128, a: 255 }).h;
    expect(hue).toBeGreaterThan(300);
    expect(hue).toBeLessThan(360);
  });

  it("round-trips a grid of RGB values exactly", () => {
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const color = { r, g, b, a: 200 };
          expect(hsvToRgb(rgbToHsv(color), 200)).toEqual(color);
        }
      }
    }
  });

  it("clamps and rounds channels, treating NaN as zero", () => {
    expect(clampChannel(-4)).toBe(0);
    expect(clampChannel(300)).toBe(255);
    expect(clampChannel(12.6)).toBe(13);
    expect(clampChannel(Number.NaN)).toBe(0);
  });
});

describe("hex text", () => {
  it("writes six digits without alpha", () => {
    expect(rgbHex({ r: 0, g: 128, b: 255, a: 10 })).toBe("0080FF");
  });

  it("parses six digits, accepting a leading # and spaces", () => {
    expect(parseRgbHex("#ff8000")).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseRgbHex("  00ff00 ")).toEqual({ r: 0, g: 255, b: 0 });
  });

  it("rejects anything that is not six hex digits", () => {
    expect(parseRgbHex("FFF")).toBeNull();
    expect(parseRgbHex("GG0000")).toBeNull();
    expect(parseRgbHex("FF00001")).toBeNull();
  });

  it("writes and parses AARRGGBB", () => {
    expect(argbHex({ r: 255, g: 0, b: 0, a: 128 })).toBe("80FF0000");
    expect(parseArgbHex("80FF0000")).toEqual({ a: 128, r: 255, g: 0, b: 0 });
    expect(parseArgbHex("FF0000")).toBeNull();
    expect(parseArgbHex("GG000000")).toBeNull();
  });
});

describe("color wheel", () => {
  it("places a color at its hue and saturation with the 1.4 gamma", () => {
    const right = wheelPosition({ h: 0, s: 100, v: 100 });
    expect(right.x).toBeCloseTo(1);
    expect(right.y).toBeCloseTo(0);
    const half = wheelPosition({ h: 90, s: 50, v: 100 });
    expect(half.x).toBeCloseTo(0, 6);
    expect(half.y).toBeCloseTo(0.5 ** (1 / 1.4));
  });

  it("picks back the hue and saturation of a position", () => {
    const hsv = { h: 200, s: 60, v: 70 };
    const position = wheelPosition(hsv);
    const picked = wheelPick(hsv, position.x, position.y, NO_MODIFIERS);
    expect(picked.h).toBeCloseTo(200, 6);
    expect(picked.s).toBeCloseTo(60, 6);
    expect(picked.v).toBe(70);
  });

  it("snaps the hue to 15 degrees with Shift", () => {
    const picked = wheelPick({ h: 0, s: 100, v: 100 }, 0.6, -0.8, {
      ...NO_MODIFIERS,
      shift: true,
    });
    expect(picked.h % 15).toBe(0);
    expect(picked.h).toBe(300);
  });

  it("keeps the radius with Ctrl and the hue with Alt", () => {
    const current = { h: 40, s: 25, v: 90 };
    const locked = wheelPick(current, 0.2, 0.9, { ...NO_MODIFIERS, ctrl: true });
    expect(locked.s).toBe(25);
    expect(locked.h).not.toBe(40);
    const hueLocked = wheelPick(current, 0.2, 0.9, { ...NO_MODIFIERS, alt: true });
    expect(hueLocked.h).toBe(40);
  });

  it("clamps a pointer outside the wheel to its rim", () => {
    expect(wheelPick({ h: 0, s: 0, v: 100 }, 3, 0, NO_MODIFIERS).s).toBe(100);
  });

  it("fades white out toward the rim", () => {
    expect(wheelSaturationGradient(4)).toContain("rgba(255,255,255,1.0000) 0.00%");
    expect(wheelSaturationGradient(4)).toContain("rgba(255,255,255,0.0000) 100.00%");
  });
});

describe("slider and swatch backgrounds", () => {
  const color = { r: 10, g: 20, b: 30, a: 128 };

  it("fades the red channel from zero to full with green and blue held", () => {
    const background = sliderBackground("r", color);
    expect(background).toContain("rgb(0,20,30)");
    expect(background).toContain("rgb(255,20,30)");
  });

  it("draws the hue track from the color's saturation and value", () => {
    const background = sliderBackground("h", { r: 255, g: 0, b: 0, a: 255 });
    expect(background).toContain("rgb(255,0,0)");
    expect(background).toContain("rgb(0,255,0)");
  });

  it("draws the alpha track over a checkerboard", () => {
    expect(sliderBackground("a", color)).toContain("var(--color-checkerboard)");
    expect(swatchBackground(color)).toContain("rgba(10,20,30,0.5020)");
    expect(swatchBackground(color)).toContain("var(--color-checkerboard)");
  });

  it("draws the saturation and value tracks from the other components", () => {
    expect(sliderBackground("s", { r: 255, g: 0, b: 0, a: 255 })).toContain("rgb(255,255,255)");
    expect(sliderBackground("v", { r: 255, g: 0, b: 0, a: 255 })).toContain("rgb(0,0,0)");
  });
});
