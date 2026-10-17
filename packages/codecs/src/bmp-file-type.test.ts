// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { convertResolution, DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  type ByteSource,
  defaultSaveToken,
  type FileDocument,
  type FileTypeDescriptor,
  findOpenFileType,
} from "@openpaint/extension-api";
import type { PropertyValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeBmpImage } from "./bmp-encoder";
import { bmpFileType, loadBmpFile } from "./bmp-file-type";
import { bmpIsLossless, bmpSaveOptions } from "./bmp-options";
import { DecodeError } from "./errors";
import { builtinFileTypeRegistry } from "./file-types";
import type { PngImage } from "./png-encoder";
import { srgbIccProfile } from "./srgb-profile";
import { linearCurve, matrixProfile } from "./test-profiles";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** A surface whose pixels differ, with the given alpha pattern. */
function pattern(width: number, height: number, alpha: (x: number, y: number) => number): Surface {
  const surface = new Surface(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      surface.data[at] = (x * 37) % 256;
      surface.data[at + 1] = (y * 53) % 256;
      surface.data[at + 2] = ((x + y) * 11) % 256;
      surface.data[at + 3] = alpha(x, y);
    }
  }
  return surface;
}

function documentOf(surface: Surface, extra: Partial<FileDocument> = {}): FileDocument {
  return {
    width: surface.width,
    height: surface.height,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: { xmp: [], user: {} },
    layers: [{ name: "Background", visible: true, opacity: 255, blendMode: 0, surface }],
    ...extra,
  };
}

/** Saves through the type's codec, the way the save flow does. */
async function save(
  type: FileTypeDescriptor,
  file: FileDocument,
  token: PropertyValues = defaultSaveToken(type),
): Promise<Uint8Array> {
  const codec = await type.loadCodec();
  const chunks: Uint8Array[] = [];
  await codec.save(
    file,
    {
      write: async (chunk) => {
        chunks.push(chunk);
      },
    },
    token,
    () => undefined,
  );
  const written = chunks[0];
  if (written === undefined) throw new Error("the codec wrote nothing");
  return written;
}

async function load(type: FileTypeDescriptor, bytes: Uint8Array): Promise<FileDocument> {
  const codec = await type.loadCodec();
  const source: ByteSource = { byteLength: bytes.length, readAll: async () => bytes };
  return codec.load(source);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The bit count field of the BMP header. */
function bitCount(bytes: Uint8Array): number {
  return view(bytes).getUint16(28, true);
}

function pixelsOf(file: FileDocument): Uint8Array {
  return new Uint8Array(file.layers[0]?.surface.data.buffer ?? new ArrayBuffer(0));
}

/** The composite of a color over white, as FMT-QNT-03 gives it. */
function overWhite(color: number, alpha: number): number {
  return Math.floor((color * alpha + 255 * (255 - alpha) + 127) / 255);
}

describe("BMP file type", () => {
  const type = bmpFileType();

  it("is registered after JPEG and opens .bmp, .dib and .rle", () => {
    const registry = builtinFileTypeRegistry();
    expect(findOpenFileType(registry, ".BMP")?.id).toBe("bmp");
    expect(findOpenFileType(registry, ".dib")?.id).toBe("bmp");
    expect(findOpenFileType(registry, ".rle")?.id).toBe("bmp");
    expect(type.saveExtensions).toEqual([".bmp"]);
    expect(type.mimeTypes).toEqual(["image/bmp"]);
  });

  it("round-trips 32-bit pixels exactly, alpha included", async () => {
    const surface = pattern(5, 4, (x, y) => (x * 40 + y * 13) % 256);
    const bytes = await save(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 32,
    });
    expect(bitCount(bytes)).toBe(32);
    expect(view(bytes).getUint32(14, true)).toBe(124);
    const loaded = await load(type, bytes);
    expect(pixelsOf(loaded)).toEqual(new Uint8Array(surface.data.buffer));
  });

  it("writes a BITMAPINFOHEADER for 24-bit and no profile by default", async () => {
    const surface = pattern(3, 3, () => 255);
    const bytes = await save(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 24,
    });
    expect(bitCount(bytes)).toBe(24);
    expect(view(bytes).getUint32(14, true)).toBe(40);
    const loaded = await load(type, bytes);
    expect(pixelsOf(loaded)).toEqual(new Uint8Array(surface.data.buffer));
  });

  it("composites 24-bit and indexed output over white (FMT-QNT-03)", async () => {
    const surface = pattern(2, 2, () => 128);
    const bytes = await save(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 24,
    });
    const loaded = await load(type, bytes);
    const pixel = loaded.layers[0]?.surface.data ?? new Uint8ClampedArray();
    expect([pixel[4], pixel[5], pixel[6], pixel[7]]).toEqual([
      overWhite(37, 128),
      overWhite(0, 128),
      overWhite(11, 128),
      255,
    ]);
  });

  it("writes 1-bit indices exactly for an image with two colors", async () => {
    const surface = pattern(7, 3, () => 255);
    for (let i = 0; i < surface.data.length; i += 4) {
      const two = (i / 4) % 2 === 0;
      surface.data[i] = two ? 0 : 255;
      surface.data[i + 1] = 0;
      surface.data[i + 2] = 0;
    }
    const oneBit = await save(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 1,
    });
    expect(bitCount(oneBit)).toBe(1);
    expect(pixelsOf(await load(type, oneBit))).toEqual(new Uint8Array(surface.data.buffer));
  });

  it("auto-detect keeps 32-bit for images with partial alpha", async () => {
    const surface = pattern(4, 4, (x) => (x === 0 ? 100 : 255));
    const bytes = await save(type, documentOf(surface));
    expect(bitCount(bytes)).toBe(32);
  });

  it("auto-detect picks 24-bit for opaque images with more than 256 colors", async () => {
    const surface = pattern(32, 32, () => 255);
    const bytes = await save(type, documentOf(surface));
    expect(bitCount(bytes)).toBe(24);
  });

  it("quantizes to an 8-bit palette when 8-bit is chosen for many colors", async () => {
    const surface = pattern(32, 32, () => 255);
    const bytes = await save(type, documentOf(surface), { ...defaultSaveToken(type), bitDepth: 8 });
    expect(bitCount(bytes)).toBe(8);
    const loaded = await load(type, bytes);
    expect(loaded.width).toBe(32);
    expect(loaded.layers[0]?.surface.data.length).toBe(32 * 32 * 4);
  });

  it("embeds the sRGB profile only when the setting is on", async () => {
    const surface = pattern(3, 3, () => 255);
    const token = { ...defaultSaveToken(type), bitDepth: 24 };
    const withProfile = await save(
      bmpFileType(() => true),
      documentOf(surface),
      token,
    );
    expect(view(withProfile).getUint32(14, true)).toBe(124);
    const profileLength = view(withProfile).getUint32(14 + 116, true);
    expect(profileLength).toBeGreaterThan(0);
    const withoutProfile = await save(
      bmpFileType(() => false),
      documentOf(surface),
      token,
    );
    expect(view(withoutProfile).getUint32(14, true)).toBe(40);
    expect(withoutProfile.length).toBeLessThan(withProfile.length);
  });

  it("reads and writes the density in dots per inch", async () => {
    const surface = pattern(3, 3, () => 255);
    const file = documentOf(surface, { resolution: { unit: "inch", x: 300, y: 300 } });
    const bytes = await save(type, file, { ...defaultSaveToken(type), bitDepth: 24 });
    const loaded = await load(type, bytes);
    expect(loaded.resolution.unit).toBe("centimeter");
    expect(convertResolution(loaded.resolution, "inch").x).toBeCloseTo(300, 0);
  });

  it("uses the default resolution when the header has no density", async () => {
    const bytes = await save(type, documentOf(pattern(2, 2, () => 255)), {
      ...defaultSaveToken(type),
      bitDepth: 24,
    });
    const undensed = bytes.slice();
    undensed.fill(0, 14 + 24, 14 + 32);
    expect((await loadBmpFile(undensed)).resolution).toEqual(DEFAULT_RESOLUTION);
  });

  it("refuses bytes that are not a BMP", async () => {
    await expect(loadBmpFile(new TextEncoder().encode("not an image"))).rejects.toBeInstanceOf(
      DecodeError,
    );
  });

  it("converts an embedded RGB profile to sRGB on open, and keeps an sRGB one", async () => {
    const image: PngImage = {
      width: 2,
      height: 1,
      depth: 32,
      pixels: new Uint8Array([37, 0, 11, 255, 0, 0, 0, 255]),
      palette: new Uint8Array(0),
      alpha: new Uint8Array(0),
    };
    const density = { x: 0, y: 0 };
    const linear = await loadBmpFile(
      encodeBmpImage(image, { icc: matrixProfile(linearCurve()), pixelsPerMeter: density }),
    );
    const encode = (value: number) => {
      const linear = value / 255;
      const encoded = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255);
    };
    expect(Array.from(linear.layers[0]?.surface.data ?? [])).toEqual([
      encode(37),
      0,
      encode(11),
      255,
      0,
      0,
      0,
      255,
    ]);
    const srgb = await loadBmpFile(
      encodeBmpImage(image, { icc: srgbIccProfile(), pixelsPerMeter: density }),
    );
    expect(Array.from(srgb.layers[0]?.surface.data ?? [])).toEqual([37, 0, 11, 255, 0, 0, 0, 255]);
  });

  it("is lossless only for Auto-detect and 32-bit", () => {
    expect(bmpIsLossless({ ...defaultSaveToken(type), bitDepth: 0 })).toBe(true);
    expect(bmpIsLossless({ ...defaultSaveToken(type), bitDepth: 32 })).toBe(true);
    expect(bmpIsLossless({ ...defaultSaveToken(type), bitDepth: 8 })).toBe(false);
    expect(type.isLossless({ ...defaultSaveToken(type), bitDepth: 24 })).toBe(false);
  });

  it("starts from the schema defaults", () => {
    expect(bmpSaveOptions(defaultSaveToken(type))).toEqual({
      bitDepth: 0,
      quantization: "octree",
      dithering: 7,
      removeMetadata: false,
    });
  });
});
