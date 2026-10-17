// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { PNG } from "pngjs";
import { beforeAll, describe, expect, it } from "vitest";
import { encodePngImage, type PngContainer, type PngImage } from "./png-encoder";
import { choosePngImage, type PngPipelineOptions } from "./png-pipeline";
import { quantizePalette } from "./quantize";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const NO_CONTAINER: PngContainer = { interlaced: false, xmp: [], pixelsPerMeter: { x: 0, y: 0 } };

/** A smooth gradient with many distinct colors, fully opaque. */
function photo(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(
        [(x * 255) / (width - 1), (y * 255) / (height - 1), ((x + y) * 7) & 255, 255],
        (y * width + x) * 4,
      );
    }
  }
  return data;
}

function colorsOf(rgba: Uint8Array): string[] {
  const colors = new Set<string>();
  for (let i = 0; i < rgba.length; i += 4) colors.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`);
  return [...colors].sort();
}

function paletteOf(palette: Uint8Array): string[] {
  const colors: string[] = [];
  for (let i = 0; i < palette.length; i += 3)
    colors.push(`${palette[i]},${palette[i + 1]},${palette[i + 2]}`);
  return colors.sort();
}

function quantizeRequest(
  rgba: Uint8Array,
  width: number,
  height: number,
  extra: Partial<Parameters<typeof quantizePalette>[0]> = {},
) {
  return {
    width,
    height,
    pixels: rgba,
    capacity: 16,
    transparentEntry: false,
    algorithm: "octree" as const,
    dithering: 7,
    ...extra,
  };
}

describe("quantizePalette (WASM Median Cut and Octree)", () => {
  it.each(["medianCut", "octree"] as const)(
    "%s keeps the palette within the capacity",
    (algorithm) => {
      const rgba = photo(32, 32);
      for (const dithering of [0, 8]) {
        const { palette, indices } = quantizePalette(
          quantizeRequest(rgba, 32, 32, { algorithm, dithering, capacity: 16 }),
        );
        expect(palette.length / 3).toBeGreaterThanOrEqual(1);
        expect(palette.length / 3).toBeLessThanOrEqual(16);
        expect(indices).toHaveLength(32 * 32);
        expect(indices.every((index) => index < palette.length / 3)).toBe(true);
      }
    },
  );

  it.each(["medianCut", "octree"] as const)(
    "%s returns the exact colors when they fit",
    (algorithm) => {
      const colors = [
        [0, 0, 0],
        [255, 0, 0],
        [0, 0, 255],
        [200, 100, 50],
      ];
      const rgba = new Uint8Array(64 * 4);
      for (let i = 0; i < 64; i++) rgba.set([...(colors[(i * 3) % 4] ?? [0, 0, 0]), 255], i * 4);
      const { palette, indices } = quantizePalette(
        quantizeRequest(rgba, 8, 8, { algorithm, dithering: 8 }),
      );
      expect(paletteOf(palette)).toEqual(colors.map((c) => c.join(",")).sort());
      const mapped = new Uint8Array(rgba.length);
      for (let i = 0; i < indices.length; i++) {
        const entry = palette.subarray((indices[i] ?? 0) * 3, (indices[i] ?? 0) * 3 + 3);
        mapped.set([...entry, 255], i * 4);
      }
      expect(colorsOf(mapped)).toEqual(colorsOf(rgba));
    },
  );

  it("leaves transparent pixels out of the palette", () => {
    const rgba = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 255, 0, 255, 0, 255, 0]);
    const { palette } = quantizePalette(
      quantizeRequest(rgba, 2, 2, { transparentEntry: true, capacity: 255 }),
    );
    expect(paletteOf(palette)).toEqual(["0,0,0", "255,255,255"]);
  });

  it("rejects a dithering level outside 0 to 8", () => {
    expect(() => quantizePalette(quantizeRequest(photo(4, 4), 4, 4, { dithering: 9 }))).toThrow();
  });
});

describe("indexed PNG output with the WASM quantizer", () => {
  it("writes a 4-bit PNG whose colors come from a 16-color palette", () => {
    const width = 40;
    const height = 30;
    const source = photo(width, height);
    const encode = (image: PngImage) => encodePngImage(image, NO_CONTAINER);
    const options: PngPipelineOptions = {
      bitDepth: 4,
      quantization: "octree",
      dithering: 7,
      transparencyThreshold: 128,
    };
    const image = choosePngImage(
      new Surface(width, height, new Uint8ClampedArray(source)),
      options,
      {
        progress: () => undefined,
        encode,
        quantize: quantizePalette,
      },
    );
    expect(image.depth).toBe(4);
    const decoded = PNG.sync.read(Buffer.from(encode(image)));
    expect(colorsOf(new Uint8Array(decoded.data)).length).toBeLessThanOrEqual(16);
    let error = 0;
    for (let i = 0; i < source.length; i += 4) {
      for (let c = 0; c < 3; c++)
        error += Math.abs((decoded.data[i + c] ?? 0) - (source[i + c] ?? 0));
    }
    expect(error / (width * height * 3)).toBeLessThan(32);
  });

  it("keeps transparent pixels transparent in 8-bit alpha output", () => {
    const width = 24;
    const height = 16;
    const source = photo(width, height);
    for (let i = 0; i < source.length; i += 4) {
      if ((i / 4) % 3 === 0) source[i + 3] = 0;
    }
    const encode = (image: PngImage) => encodePngImage(image, NO_CONTAINER);
    const image = choosePngImage(
      new Surface(width, height, new Uint8ClampedArray(source)),
      { bitDepth: 8, quantization: "medianCut", dithering: 7, transparencyThreshold: 128 },
      { progress: () => undefined, encode, quantize: quantizePalette },
    );
    expect(image.depth).toBe(8);
    expect(image.palette.length / 3).toBeLessThanOrEqual(256);
    const decoded = PNG.sync.read(Buffer.from(encode(image)));
    for (let i = 0; i < source.length; i += 4) {
      expect(decoded.data[i + 3]).toBe(source[i + 3] === 0 ? 0 : 255);
    }
  });
});
