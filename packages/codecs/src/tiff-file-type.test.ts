// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { defaultSaveToken, findOpenFileType } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { DecodeError } from "./errors";
import { EXIF_TAG_ARTIST, exifAsciiBytes, exifFromAsciiTags } from "./exif";
import {
  documentOf,
  loadWith,
  overWhite,
  pattern,
  pixelsOf,
  saveWith,
} from "./file-type-test-helpers";
import { builtinFileTypeRegistry } from "./file-types";
import { GPS_LATITUDE_REF_TAG, GPS_POINTER_TAG, gpsTiffBlock, subIfdAscii } from "./test-fixtures";
import { loadTiffFile, tiffFileType } from "./tiff-file-type";
import { tiffIsLossless } from "./tiff-options";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/**
 * A one-strip, uncompressed CMYK TIFF written by hand (the writer has no CMYK depth): little-endian,
 * 8 bits per sample, Separated photometric, the four BitsPerSample values out of line, and the ink
 * after them.
 */
function cmykTiff(width: number, height: number, ink: readonly number[]): Uint8Array {
  const shortType = 3;
  const longType = 4;
  const entries: readonly (readonly [tag: number, type: number, count: number, value: number])[] = [
    [256, shortType, 1, width],
    [257, shortType, 1, height],
    [258, shortType, 4, 122],
    [259, shortType, 1, 1],
    [262, shortType, 1, 5],
    [273, longType, 1, 130],
    [277, shortType, 1, 4],
    [278, shortType, 1, height],
    [279, longType, 1, ink.length],
  ];
  const out = new Uint8Array(130 + ink.length);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  view.setUint16(8, entries.length, true);
  for (const [index, [tag, type, count, value]] of entries.entries()) {
    const at = 10 + index * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    if (type === shortType && count === 1) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  }
  for (const [index, bits] of [8, 8, 8, 8].entries()) view.setUint16(122 + index * 2, bits, true);
  out.set(ink, 130);
  return out;
}

/** A surface of a few solid colors, opaque, laid out in stripes. */
function stripes(
  width: number,
  height: number,
  colors: readonly [number, number, number][],
): Surface {
  const surface = new Surface(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = colors[(x + y) % colors.length] ?? [0, 0, 0];
      const at = (y * width + x) * 4;
      surface.data.set([color[0], color[1], color[2], 255], at);
    }
  }
  return surface;
}

describe("TIFF file type", () => {
  const type = tiffFileType();

  it("is registered and opens .tif and .tiff", () => {
    const registry = builtinFileTypeRegistry();
    expect(findOpenFileType(registry, ".TIF")?.id).toBe("tiff");
    expect(findOpenFileType(registry, ".tiff")?.id).toBe("tiff");
    expect(type.saveExtensions).toEqual([".tif", ".tiff"]);
    expect(type.mimeTypes).toEqual(["image/tiff"]);
  });

  it("is lossless only for Auto-detect and 32-bit", () => {
    expect(tiffIsLossless({ ...defaultSaveToken(type), bitDepth: 24 })).toBe(false);
    expect(tiffIsLossless({ ...defaultSaveToken(type), bitDepth: 32 })).toBe(true);
    expect(tiffIsLossless(defaultSaveToken(type))).toBe(true);
  });

  it("round-trips 32-bit pixels exactly, alpha included", async () => {
    const surface = pattern(5, 4, (x, y) => (x * 40 + y * 13) % 256);
    const bytes = await saveWith(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 32,
    });
    const loaded = await loadWith(type, bytes);
    expect([loaded.width, loaded.height]).toEqual([5, 4]);
    expect(pixelsOf(loaded)).toEqual(Array.from(surface.data));
  });

  it("composites a 24-bit save over white", async () => {
    const surface = pattern(4, 3, () => 128);
    const bytes = await saveWith(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 24,
    });
    const pixels = pixelsOf(await loadWith(type, bytes));
    for (let at = 0; at < pixels.length; at += 4) {
      const source = Array.from(surface.data.slice(at, at + 4));
      expect(pixels.slice(at, at + 4)).toEqual([
        overWhite(source[0] ?? 0, 128),
        overWhite(source[1] ?? 0, 128),
        overWhite(source[2] ?? 0, 128),
        255,
      ]);
    }
  });

  it("writes 4-bit and 1-bit palettes that read back exactly", async () => {
    const four = stripes(6, 3, [
      [0, 0, 0],
      [255, 255, 255],
      [200, 30, 10],
      [10, 90, 240],
    ]);
    const bytes = await saveWith(type, documentOf(four), {
      ...defaultSaveToken(type),
      bitDepth: 4,
    });
    expect(pixelsOf(await loadWith(type, bytes))).toEqual(Array.from(four.data));

    const two = stripes(5, 2, [
      [12, 34, 56],
      [250, 240, 230],
    ]);
    const oneBit = await saveWith(type, documentOf(two), {
      ...defaultSaveToken(type),
      bitDepth: 1,
    });
    expect(pixelsOf(await loadWith(type, oneBit))).toEqual(Array.from(two.data));
  });

  it("Auto-detect picks the smallest lossless depth for an opaque two-color image", async () => {
    const surface = stripes(8, 8, [
      [0, 0, 0],
      [255, 255, 255],
    ]);
    const auto = await saveWith(type, documentOf(surface));
    const full = await saveWith(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 32,
    });
    expect(auto.length).toBeLessThan(full.length);
    expect(pixelsOf(await loadWith(type, auto))).toEqual(Array.from(surface.data));
  });

  it("quantizes an image with more colors than a palette holds", async () => {
    const surface = pattern(20, 20, () => 255);
    const bytes = await saveWith(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 8,
    });
    const pixels = pixelsOf(await loadWith(type, bytes));
    const colors = new Set<string>();
    for (let at = 0; at < pixels.length; at += 4) colors.add(pixels.slice(at, at + 3).join(","));
    expect(colors.size).toBeGreaterThan(1);
    expect(colors.size).toBeLessThanOrEqual(256);
  });

  it("keeps the density as a centimeter resolution", async () => {
    const surface = pattern(2, 2, () => 255);
    const file = documentOf(surface, { resolution: { unit: "centimeter", x: 10, y: 20 } });
    const loaded = await loadWith(type, await saveWith(type, file));
    expect(loaded.resolution).toEqual({ unit: "centimeter", x: 10, y: 20 });
  });

  it("writes EXIF text and XMP, unless Remove metadata is on", async () => {
    const surface = pattern(2, 2, () => 255);
    const text = new TextEncoder().encode("Ada");
    const file = documentOf(surface, {
      metadata: {
        exif: exifFromAsciiTags([{ tag: EXIF_TAG_ARTIST, text }]),
        xmp: ["<x:xmpmeta/>"],
        user: {},
      },
    });
    const kept = await loadWith(type, await saveWith(type, file));
    expect(exifAsciiBytes(kept.metadata.exif, EXIF_TAG_ARTIST)).toEqual(text);
    expect(kept.metadata.xmp).toEqual(["<x:xmpmeta/>"]);

    const removed = await loadWith(
      type,
      await saveWith(type, file, { ...defaultSaveToken(type), removeMetadata: true }),
    );
    expect(removed.metadata.exif).toBeUndefined();
    expect(removed.metadata.xmp).toEqual([]);
  });

  it("keeps the EXIF GPS sub-IFD, and drops it with Remove metadata", async () => {
    const file = documentOf(
      pattern(2, 2, () => 255),
      {
        metadata: { exif: gpsTiffBlock(), xmp: [], user: {} },
      },
    );
    const kept = await loadWith(type, await saveWith(type, file));
    expect(subIfdAscii(kept.metadata.exif, GPS_POINTER_TAG, GPS_LATITUDE_REF_TAG)).toBe("N");

    const removed = await loadWith(
      type,
      await saveWith(type, file, { ...defaultSaveToken(type), removeMetadata: true }),
    );
    expect(removed.metadata.exif).toBeUndefined();
  });

  it("converts a CMYK page's ink to sRGB with the default profile (FMT-META-03)", async () => {
    const loaded = await loadTiffFile(cmykTiff(2, 1, [0, 0, 0, 0, 0, 0, 0, 255]));
    const pixels = loaded.layers[0]?.surface.data ?? new Uint8ClampedArray();
    expect(loaded.width).toBe(2);
    for (const [index, expected] of [
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ].entries()) {
      for (const [channel, value] of expected.entries()) {
        expect(Math.abs((pixels[index * 4 + channel] ?? 0) - value)).toBeLessThanOrEqual(3);
      }
    }
  });

  it("refuses bytes that are not a TIFF", async () => {
    await expect(loadTiffFile(new TextEncoder().encode("not a tiff"))).rejects.toBeInstanceOf(
      DecodeError,
    );
  });
});
