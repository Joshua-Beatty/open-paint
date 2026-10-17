// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { PNG } from "pngjs";
import { beforeAll, describe, expect, it } from "vitest";
import { encodePngImage, type PngContainer, type PngImage } from "./png-encoder";
import { choosePngImage, PngPaletteError, type PngPipelineOptions } from "./png-pipeline";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const NO_CONTAINER: PngContainer = { interlaced: false, xmp: [], pixelsPerMeter: { x: 0, y: 0 } };
const AUTO: PngPipelineOptions = {
  bitDepth: 0,
  quantization: "octree",
  dithering: 7,
  transparencyThreshold: 128,
};

/** Runs the pipeline and writes the PNG, the same way the codec does. */
function save(
  surface: Surface,
  options: Partial<PngPipelineOptions> = {},
  container: PngContainer = NO_CONTAINER,
): Uint8Array {
  const encode = (image: PngImage) => encodePngImage(image, container);
  const image = choosePngImage(
    surface,
    { ...AUTO, ...options },
    { progress: () => undefined, encode },
  );
  return encode(image);
}

function pixelsOf(
  width: number,
  height: number,
  fill: (x: number, y: number) => number[],
): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(fill(x, y), (y * width + x) * 4);
    }
  }
  return new Surface(width, height, data);
}

/** Many opaque colors: more than 256 distinct values. */
function gradient(width: number, height: number): Surface {
  return pixelsOf(width, height, (x, y) => [(x * 7) & 255, (y * 5) & 255, (x * y) & 255, 255]);
}

/** Three opaque colors, in a pattern. */
function threeColors(width: number, height: number): Surface {
  const palette = [
    [200, 30, 40, 255],
    [10, 120, 230, 255],
    [250, 250, 20, 255],
  ];
  return pixelsOf(width, height, (x, y) => palette[(x + y) % 3] ?? [0, 0, 0, 255]);
}

/** Straight alpha over white, rounded half up (FMT-QNT-03). */
function overWhite(color: number, alpha: number): number {
  return Math.floor((color * alpha + 255 * (255 - alpha) + 127) / 255);
}

/** The chunk types of a PNG, in file order. */
function chunksOf(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kinds: string[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    kinds.push(String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)));
    offset += length + 12;
  }
  return kinds;
}

/** The IHDR fields that the tests check: bit depth, color type and interlace method. */
function headerOf(bytes: Uint8Array): { depth: number; colorType: number; interlace: number } {
  return { depth: bytes[24] ?? 0, colorType: bytes[25] ?? 0, interlace: bytes[28] ?? 0 };
}

function decodeRgba(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

describe("PNG output depths (FMT-OPT-PNG-01)", () => {
  it("writes 32-bit RGBA that decodes to the same straight-alpha pixels", () => {
    const surface = pixelsOf(3, 2, (x, y) => [x * 40, y * 90, 17, (x + y) * 60]);
    const bytes = save(surface, { bitDepth: 32 });
    expect(headerOf(bytes)).toEqual({ depth: 8, colorType: 6, interlace: 0 });
    expect(decodeRgba(bytes).data).toEqual(new Uint8Array(surface.data));
  });

  it("composites partly transparent pixels over white for 24-bit RGB", () => {
    const surface = pixelsOf(2, 1, () => [0, 100, 255, 128]);
    const bytes = save(surface, { bitDepth: 24 });
    expect(headerOf(bytes)).toEqual({ depth: 8, colorType: 2, interlace: 0 });
    expect([...decodeRgba(bytes).data.subarray(0, 4)]).toEqual([
      overWhite(0, 128),
      overWhite(100, 128),
      overWhite(255, 128),
      255,
    ]);
  });

  it("writes an exact indexed palette at 4 bits with no alpha", () => {
    const surface = threeColors(5, 4);
    const bytes = save(surface, { bitDepth: 4 });
    expect(headerOf(bytes)).toEqual({ depth: 4, colorType: 3, interlace: 0 });
    expect(decodeRgba(bytes).data).toEqual(new Uint8Array(surface.data));
  });

  it("gives the same pixels for interlaced and sequential output", () => {
    const surface = gradient(13, 9);
    const plain = decodeRgba(save(surface, { bitDepth: 32 }));
    const interlaced = save(surface, { bitDepth: 32 }, { ...NO_CONTAINER, interlaced: true });
    expect(headerOf(interlaced).interlace).toBe(1);
    expect(decodeRgba(interlaced).data).toEqual(plain.data);
  });

  it("writes exact opaque colors at 8 bits, and a 1-bit alpha palette when a pixel is not opaque", () => {
    const opaque = threeColors(4, 4);
    expect(decodeRgba(save(opaque, { bitDepth: 8 })).data).toEqual(new Uint8Array(opaque.data));

    const withAlpha = pixelsOf(4, 4, (x, y) =>
      x === 0 && y === 0 ? [9, 9, 9, 0] : [200, 30, 40, 255],
    );
    const bytes = save(withAlpha, { bitDepth: 8 });
    expect(headerOf(bytes)).toEqual({ depth: 8, colorType: 3, interlace: 0 });
    expect(chunksOf(bytes)).toContain("tRNS");
    expect([...decodeRgba(bytes).data.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it("applies the transparency threshold at 8 bits: below it transparent, at or above it blended", () => {
    const surface = pixelsOf(
      3,
      1,
      (x) =>
        [
          [255, 0, 0, 200],
          [0, 0, 255, 100],
          [40, 40, 40, 20],
        ][x] ?? [0, 0, 0, 0],
    );
    const decoded = decodeRgba(save(surface, { bitDepth: 8, transparencyThreshold: 128 }));
    expect([...decoded.data]).toEqual([
      overWhite(255, 200),
      overWhite(0, 200),
      overWhite(0, 200),
      255,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
  });
});

describe("palette limits and the quantizer hook (FMT-QNT-01 step 5)", () => {
  it("fails a lossy indexed palette when no quantizer is available", () => {
    expect(() => save(gradient(8, 8), { bitDepth: 4 })).toThrow(PngPaletteError);
  });

  it("uses the palette the quantizer returns, within the capacity of the depth", () => {
    const requests: { capacity: number; transparentEntry: boolean; algorithm: string }[] = [];
    const image = choosePngImage(
      gradient(8, 8),
      { ...AUTO, bitDepth: 4, quantization: "medianCut" },
      {
        progress: () => undefined,
        encode: (candidate) => encodePngImage(candidate, NO_CONTAINER),
        quantize: (request) => {
          requests.push({
            capacity: request.capacity,
            transparentEntry: request.transparentEntry,
            algorithm: request.algorithm,
          });
          return {
            palette: new Uint8Array(16 * 3),
            indices: new Uint8Array(request.width * request.height),
          };
        },
      },
    );
    expect(requests).toEqual([{ capacity: 16, transparentEntry: false, algorithm: "medianCut" }]);
    expect(image.depth).toBe(4);
    expect(image.palette.length).toBe(48);
  });

  it("gives the 8-bit alpha palette one entry less for the transparent color", () => {
    const surface = pixelsOf(20, 20, (x, y) => [x * 12, y * 12, 0, x === 0 ? 0 : 255]);
    const capacities: number[] = [];
    choosePngImage(
      surface,
      { ...AUTO, bitDepth: 8 },
      {
        progress: () => undefined,
        encode: (candidate) => encodePngImage(candidate, NO_CONTAINER),
        quantize: (request) => {
          capacities.push(request.capacity);
          return {
            palette: new Uint8Array(255 * 3),
            indices: new Uint8Array(request.width * request.height),
          };
        },
      },
    );
    expect(capacities).toEqual([255]);
  });
});

describe("Auto-detect (FMT-QNT-02)", () => {
  it("picks the lowest lossless depth for a large image with two colors", () => {
    const surface = pixelsOf(300, 300, (x) => (x < 150 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    expect(headerOf(save(surface))).toEqual({ depth: 1, colorType: 3, interlace: 0 });
  });

  it("picks 24-bit for an opaque image with more than 256 colors", () => {
    expect(headerOf(save(gradient(300, 300)))).toEqual({ depth: 8, colorType: 2, interlace: 0 });
  });

  it("picks 32-bit when a pixel is partly transparent", () => {
    const surface = pixelsOf(300, 300, (x) => [9, 9, 9, x === 0 ? 100 : 255]);
    expect(headerOf(save(surface))).toEqual({ depth: 8, colorType: 6, interlace: 0 });
  });

  it("writes the smaller of the 4-bit and 24-bit trial encodes for a small image", () => {
    const surface = threeColors(16, 16);
    const auto = save(surface);
    const smaller = Math.min(
      save(surface, { bitDepth: 4 }).length,
      save(surface, { bitDepth: 24 }).length,
    );
    expect(auto.length).toBe(smaller);
    expect(decodeRgba(auto).data).toEqual(new Uint8Array(surface.data));
  });

  it("writes the smaller of the 8-bit-alpha and 32-bit trial encodes for a small binary-alpha image", () => {
    const surface = pixelsOf(16, 16, (x, y) => [x * 10, y * 10, 0, (x + y) % 3 === 0 ? 0 : 255]);
    const smaller = Math.min(
      save(surface, { bitDepth: 8 }).length,
      save(surface, { bitDepth: 32 }).length,
    );
    expect(save(surface).length).toBe(smaller);
  });
});

describe("the PNG container (FMT-META-05, pHYs)", () => {
  it("writes the sRGB iCCP chunk, pHYs and the metadata in chunk order", () => {
    const container: PngContainer = {
      interlaced: false,
      exif: new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0]),
      xmp: [new TextEncoder().encode("<x:xmpmeta/>")],
      pixelsPerMeter: { x: 3780, y: 3780 },
    };
    const bytes = save(gradient(4, 4), { bitDepth: 32 }, container);
    expect(chunksOf(bytes)).toEqual(["IHDR", "iCCP", "pHYs", "eXIf", "iTXt", "IDAT", "IEND"]);
  });
});
