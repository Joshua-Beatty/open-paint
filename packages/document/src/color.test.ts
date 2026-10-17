import { describe, expect, it } from "vitest";
import {
  colorFromLinear,
  colorsEqual,
  colorToLinear,
  linearToSrgb,
  packRgba8,
  premultiply,
  rgba8,
  srgbToLinear,
  toColorF,
  toColorRgba8,
  unpackRgba8,
  unpremultiply,
} from "./color";

describe("color", () => {
  it("rounds and clamps 8-bit channels, defaulting to opaque", () => {
    expect(rgba8(-5, 127.5, 300)).toEqual({ r: 0, g: 128, b: 255, a: 255 });
    expect(rgba8(1, 2, 3, 4).a).toBe(4);
  });

  it("packs in R, G, B, A memory order", () => {
    const c = rgba8(1, 2, 3, 250);
    const packed = packRgba8(c);
    expect(packed).toBeGreaterThan(0);
    expect([...new Uint8Array(new Uint32Array([packed]).buffer)]).toEqual([1, 2, 3, 250]);
    expect(unpackRgba8(packed)).toEqual(c);
  });

  it("round-trips through float colors", () => {
    const c = rgba8(12, 34, 56, 78);
    expect(colorsEqual(toColorRgba8(toColorF(c)), c)).toBe(true);
    expect(toColorRgba8({ r: 2, g: -1, b: 0.5, a: 1 })).toEqual(rgba8(255, 0, 128, 255));
  });

  it("premultiplies with the same rounding as the Rust kernel", () => {
    expect(premultiply(rgba8(255, 128, 0, 255))).toEqual(rgba8(255, 128, 0, 255));
    expect(premultiply(rgba8(255, 128, 1, 128))).toEqual(rgba8(128, 64, 1, 128));
    expect(premultiply(rgba8(200, 100, 50, 0))).toEqual(rgba8(0, 0, 0, 0));
  });

  it("unpremultiplies back within rounding and maps zero alpha to transparent", () => {
    for (let a = 1; a < 256; a += 17) {
      const c = rgba8(200, 100, 50, a);
      const back = unpremultiply(premultiply(c));
      expect(back.a).toBe(a);
      for (const k of ["r", "g", "b"] as const) {
        expect(Math.abs(back[k] - c[k])).toBeLessThanOrEqual(Math.ceil(255 / a));
      }
    }
    expect(unpremultiply(rgba8(10, 10, 10, 0))).toEqual(rgba8(0, 0, 0, 0));
  });

  it("applies the sRGB transfer function and its inverse", () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214041, 5);
    expect(linearToSrgb(0.002)).toBeCloseTo(0.02584, 5);
    for (let v = 0; v <= 1; v += 0.05) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 10);
    const c = { r: 0.5, g: 0.25, b: 1, a: 0.3 };
    const lin = colorToLinear(c);
    expect(lin.a).toBe(0.3);
    expect(colorFromLinear(lin).g).toBeCloseTo(0.25, 10);
  });
});
