import { describe, expect, it } from "vitest";
import { rgba8, TRANSPARENT } from "./color";
import { rect } from "./geometry";
import { Surface } from "./surface";

const RED = rgba8(255, 0, 0);
const BLUE = rgba8(0, 0, 255, 128);

/** Surface whose pixel at (x, y) is (x, y, x + y, 255). */
function gradient(w: number, h: number): Surface {
  const s = new Surface(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) s.setPixel(x, y, rgba8(x, y, x + y));
  return s;
}

describe("Surface", () => {
  it("stores tightly packed straight-alpha RGBA bytes", () => {
    const s = new Surface(3, 2);
    expect(s.format).toBe("rgba8");
    expect(s.byteLength).toBe(24);
    expect(s.stride).toBe(12);
    s.setPixel(2, 1, rgba8(10, 20, 30, 40));
    expect([...s.data.subarray(20, 24)]).toEqual([10, 20, 30, 40]);
    expect(s.getPixel(2, 1)).toEqual(rgba8(10, 20, 30, 40));
  });

  it("validates size and supplied data", () => {
    expect(() => new Surface(-1, 2)).toThrow(RangeError);
    expect(() => new Surface(1.5, 2)).toThrow(RangeError);
    expect(() => new Surface(2, 2, new Uint8ClampedArray(15))).toThrow(RangeError);
    expect(new Surface(0, 0).byteLength).toBe(0);
  });

  it("ignores out-of-range pixel access", () => {
    const s = new Surface(2, 2);
    s.setPixel(-1, 0, RED);
    s.setPixel(2, 0, RED);
    expect(s.isTransparent()).toBe(true);
    expect(s.getPixel(5, 5)).toEqual(TRANSPARENT);
  });

  it("fills a clipped rectangle", () => {
    const s = new Surface(4, 4);
    expect(s.fill(BLUE, rect(2, -1, 5, 2))).toEqual(rect(2, 0, 2, 1));
    expect(s.getPixel(2, 0)).toEqual(BLUE);
    expect(s.getPixel(3, 0)).toEqual(BLUE);
    expect(s.getPixel(1, 0)).toEqual(TRANSPARENT);
    expect(s.getPixel(2, 1)).toEqual(TRANSPARENT);
    s.fill(RED);
    expect(s.getPixel(0, 3)).toEqual(RED);
  });

  it("clones independently", () => {
    const s = gradient(2, 2);
    const c = s.clone();
    c.setPixel(0, 0, RED);
    expect(s.getPixel(0, 0)).toEqual(rgba8(0, 0, 0));
  });

  it("copies between surfaces with clipping on both sides", () => {
    const src = gradient(4, 4);
    const dst = new Surface(3, 3);
    expect(dst.copyFrom(src, rect(-1, 1, 3, 3), 1, 0)).toEqual(rect(2, 0, 1, 3));
    expect(dst.getPixel(2, 0)).toEqual(src.getPixel(0, 1));
    expect(dst.getPixel(2, 2)).toEqual(src.getPixel(0, 3));
    expect(dst.getPixel(1, 0)).toEqual(TRANSPARENT);
  });

  it.each([
    [1, 1],
    [-1, -1],
    [2, 0],
    [0, -2],
  ])("copies overlapping regions within itself (offset %i,%i)", (ox, oy) => {
    const s = gradient(6, 6);
    const expected = s.clone();
    expected.copyFrom(s.clone(), rect(1, 1, 4, 4), 1 + ox, 1 + oy);
    s.copyFrom(s, rect(1, 1, 4, 4), 1 + ox, 1 + oy);
    expect(s.data).toEqual(expected.data);
  });

  it("rejects fractional rectangles", () => {
    const s = new Surface(2, 2);
    expect(() => s.fill(RED, rect(0.5, 0, 1, 1))).toThrow(RangeError);
    expect(() => s.copyFrom(s, s.bounds, 0.5, 0)).toThrow(RangeError);
  });
});
