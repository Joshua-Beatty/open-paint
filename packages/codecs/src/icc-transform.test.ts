// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultCmykProfile } from "./cmyk-profile";
import {
  cmykPixelsOf,
  convertRgbaToSrgb,
  PROFILE_IGNORED_WARNING,
  srgbPixelsOf,
} from "./icc-transform";
import type { DecodedRaster } from "./raster-document";
import { srgbIccProfile } from "./srgb-profile";
import { gammaCurve, grayProfile, linearCurve, matrixProfile, tableCurve } from "./test-profiles";

/** The sRGB encoding of a linear value, rounded to 8 bits (FMT-META-03's target). */
function encodeSrgb(linear: number): number {
  const encoded = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function rasterOf(pixels: readonly number[], icc?: Uint8Array): DecodedRaster {
  return {
    width: pixels.length / 4,
    height: 1,
    pixels: new Uint8Array(pixels),
    pixelsPerMeter: { x: 0, y: 0 },
    icc,
  };
}

describe("embedded profiles on open (FMT-META-03)", () => {
  it("keeps the pixels when there is no profile", async () => {
    const raster = rasterOf([10, 20, 30, 255]);
    expect(await srgbPixelsOf(raster)).toEqual({ pixels: raster.pixels, warnings: [] });
  });

  it("keeps the pixels of an sRGB profile", async () => {
    const raster = rasterOf([10, 20, 30, 255], srgbIccProfile());
    const result = await srgbPixelsOf(raster);
    expect(Array.from(result.pixels)).toEqual([10, 20, 30, 255]);
    expect(result.warnings).toEqual([]);
  });

  it("converts a linear RGB profile to sRGB and keeps alpha", async () => {
    const raster = rasterOf(
      [128, 128, 128, 200, 0, 0, 0, 0, 255, 255, 255, 255],
      matrixProfile(linearCurve()),
    );
    expect(Array.from((await srgbPixelsOf(raster)).pixels)).toEqual([
      188, 188, 188, 200, 0, 0, 0, 0, 255, 255, 255, 255,
    ]);
  });

  it("applies a gamma curve before the sRGB encoding", async () => {
    const gamma = Math.round(2.2 * 65536) / 65536;
    const raster = rasterOf([100, 150, 200, 255], matrixProfile(gammaCurve(2.2)));
    const expected = [100, 150, 200].map((value) => encodeSrgb((value / 255) ** gamma));
    const pixels = (await srgbPixelsOf(raster)).pixels;
    for (const [index, value] of expected.entries()) {
      expect(Math.abs((pixels[index] ?? 0) - value)).toBeLessThanOrEqual(1);
    }
  });

  it("reads a table curve as a lookup over the encoded values", async () => {
    const raster = rasterOf([128, 128, 128, 255], matrixProfile(tableCurve([0, 65535])));
    expect(Array.from((await srgbPixelsOf(raster)).pixels).slice(0, 3)).toEqual([188, 188, 188]);
  });

  it("accepts 16-bit RGBA samples and reduces them to 8 bits", async () => {
    const rgba16 = new Uint16Array([0x8080, 0x8080, 0x8080, 0xffff]);
    const pixels = await convertRgbaToSrgb(
      new Uint8Array(rgba16.buffer),
      16,
      matrixProfile(linearCurve()),
      "rgb",
    );
    expect(Array.from(pixels)).toEqual([188, 188, 188, 255]);
  });

  it("converts gray through its tone curve, using the red sample", async () => {
    const raster = rasterOf([128, 128, 128, 90], grayProfile(linearCurve()));
    expect(Array.from((await srgbPixelsOf(raster)).pixels)).toEqual([188, 188, 188, 90]);
  });

  it("ignores a profile it cannot use, warns, and treats the pixels as sRGB", async () => {
    const junk = rasterOf([1, 2, 3, 4], new Uint8Array([1, 2, 3]));
    expect(await srgbPixelsOf(junk)).toEqual({
      pixels: junk.pixels,
      warnings: [PROFILE_IGNORED_WARNING],
    });
  });

  it("ignores a CMYK profile on RGB pixels, with a warning", async () => {
    const raster = rasterOf([1, 2, 3, 4], defaultCmykProfile());
    expect(await srgbPixelsOf(raster)).toEqual({
      pixels: raster.pixels,
      warnings: [PROFILE_IGNORED_WARNING],
    });
  });
});

describe("CMYK on open (FMT-META-03)", () => {
  const ink = (c: number, m: number, y: number, k: number) => new Uint8Array([c, m, y, k]);
  const near = (actual: readonly number[], expected: readonly number[]) => {
    for (const [index, value] of expected.entries()) {
      expect(Math.abs((actual[index] ?? 0) - value)).toBeLessThanOrEqual(3);
    }
  };

  it("converts no ink to white and full black ink to black with the default profile", async () => {
    const result = await cmykPixelsOf(new Uint8Array([...ink(0, 0, 0, 0), ...ink(0, 0, 0, 255)]));
    near(Array.from(result.pixels.subarray(0, 4)), [255, 255, 255, 255]);
    near(Array.from(result.pixels.subarray(4, 8)), [0, 0, 0, 255]);
    expect(result.warnings).toEqual([]);
  });

  it("converts each process ink to its complementary sRGB color", async () => {
    const samples = new Uint8Array([
      ...ink(255, 0, 0, 0),
      ...ink(0, 255, 0, 0),
      ...ink(0, 0, 255, 0),
    ]);
    const result = await cmykPixelsOf(samples);
    near(Array.from(result.pixels.subarray(0, 4)), [0, 255, 255, 255]);
    near(Array.from(result.pixels.subarray(4, 8)), [255, 0, 255, 255]);
    near(Array.from(result.pixels.subarray(8, 12)), [255, 255, 0, 255]);
  });

  it("uses an embedded CMYK profile without a warning", async () => {
    const samples = ink(255, 0, 0, 0);
    const embedded = await cmykPixelsOf(samples, defaultCmykProfile());
    const fallback = await cmykPixelsOf(samples);
    expect(Array.from(embedded.pixels)).toEqual(Array.from(fallback.pixels));
    expect(embedded.warnings).toEqual([]);
  });

  it("falls back to the default profile and warns when the embedded profile is not usable", async () => {
    const samples = ink(255, 0, 0, 0);
    const result = await cmykPixelsOf(samples, srgbIccProfile());
    expect(Array.from(result.pixels)).toEqual(Array.from((await cmykPixelsOf(samples)).pixels));
    expect(result.warnings).toEqual([PROFILE_IGNORED_WARNING]);
  });
});
