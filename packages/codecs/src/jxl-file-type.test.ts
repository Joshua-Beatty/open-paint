// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { init as initJxlEncoder } from "@jsquash/jxl/encode.js";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { defaultSaveToken, findOpenFileType } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { DecodeError } from "./errors";
import { EXIF_TAG_ARTIST, EXIF_TAG_ORIENTATION, exifFromAsciiTags, exifOrientation } from "./exif";
import { documentOf, loadWith, pattern, pixelsOf, saveWith } from "./file-type-test-helpers";
import { builtinFileTypeRegistry } from "./file-types";
import { jxlFileType } from "./jxl-file-type";
import { jxlSaveOptions } from "./jxl-options";
import { tiffWithShorts } from "./test-fixtures";

const TEXT = new TextEncoder();

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
  // Node cannot fetch the encoder's WASM URL, so the test instantiates it from its bytes (the browser fetches it).
  const encoderPath = createRequire(import.meta.url).resolve("@jsquash/jxl/codec/enc/jxl_enc.wasm");
  const encoderModule = new WebAssembly.Module(await readFile(encoderPath));
  await initJxlEncoder({
    instantiateWasm: (
      imports: WebAssembly.Imports,
      callback: (instance: WebAssembly.Instance) => void,
    ) => {
      const instance = new WebAssembly.Instance(encoderModule, imports);
      callback(instance);
      return instance.exports;
    },
  });
});

const LOSSLESS = { lossless: true };

/** A smooth gradient with a transparent corner, which lossy coding can represent closely. */
function gradient(width: number, height: number): Surface {
  const surface = new Surface(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      surface.data[at] = x * 4;
      surface.data[at + 1] = y * 5;
      surface.data[at + 2] = (x + y) * 2;
      surface.data[at + 3] = x < 4 && y < 4 ? 0 : 255;
    }
  }
  return surface;
}

/**
 * The mean absolute error of the color channels over the opaque pixels. A transparent pixel's color is
 * not part of the image, so it is left out.
 */
function opaqueColorError(expected: Uint8ClampedArray, actual: number[]): number {
  let total = 0;
  let count = 0;
  for (let at = 0; at < expected.length; at += 4) {
    if (expected[at + 3] !== 255) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      total += Math.abs((expected[at + channel] ?? 0) - (actual[at + channel] ?? 0));
      count += 1;
    }
  }
  return total / count;
}

describe("JPEG XL file type (FMT-REG-02 row 4, FMT-OPT-JXL-01)", () => {
  const type = jxlFileType();

  it("is registered after JPEG and before AVIF, and opens and saves .jxl", () => {
    const registry = builtinFileTypeRegistry();
    const ids = registry.list().map((entry) => entry.id);
    expect(ids.indexOf("jxl")).toBe(ids.indexOf("jpeg") + 1);
    expect(ids.indexOf("avif")).toBe(ids.indexOf("jxl") + 1);
    expect(findOpenFileType(registry, ".JXL")?.id).toBe("jxl");
    expect(type.saveExtensions).toEqual([".jxl"]);
    expect(type.mimeTypes).toEqual(["image/jxl"]);
    expect(type.capabilities.supportsLayers).toBe(false);
    expect(type.capabilities.supportsSaving).toBe(true);
    expect(type.capabilities.supportsCancellation).toBe(true);
  });

  it("defaults to quality 90, effort 7, lossy, with metadata kept", () => {
    expect(jxlSaveOptions(defaultSaveToken(type))).toEqual({
      quality: 90,
      lossless: false,
      effort: 7,
      removeMetadata: false,
    });
    expect(type.isLossless(defaultSaveToken(type))).toBe(false);
    expect(type.isLossless({ lossless: true })).toBe(true);
  });

  it("clamps quality and effort to their ranges", () => {
    expect(jxlSaveOptions({ quality: 140, effort: 0 })).toMatchObject({ quality: 100, effort: 1 });
    expect(jxlSaveOptions({ quality: -5, effort: 12 })).toMatchObject({ quality: 0, effort: 9 });
  });

  it("writes a JPEG XL container with the file type box", async () => {
    const bytes = await saveWith(type, documentOf(pattern(8, 8, () => 255)));
    expect(Array.from(bytes.subarray(0, 12))).toEqual([
      0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a,
    ]);
    expect(new TextDecoder().decode(bytes.subarray(16, 20))).toBe("ftyp");
  });

  it("round-trips the pixels exactly when lossless, including alpha", async () => {
    const surface = pattern(37, 23, (x, y) => ((x + y) % 4 === 0 ? 0 : 255));
    const token = { ...defaultSaveToken(type), ...LOSSLESS };
    const loaded = await loadWith(type, await saveWith(type, documentOf(surface), token));
    expect(loaded.width).toBe(37);
    expect(loaded.height).toBe(23);
    expect(pixelsOf(loaded)).toEqual(Array.from(surface.data));
  });

  it("keeps lossy pixels close to the original, with transparency preserved", async () => {
    const surface = gradient(64, 48);
    const loaded = await loadWith(type, await saveWith(type, documentOf(surface)));
    expect(loaded.width).toBe(64);
    expect(loaded.height).toBe(48);
    const decoded = pixelsOf(loaded);
    expect(opaqueColorError(surface.data, decoded)).toBeLessThan(3);
    expect(decoded[3]).toBeLessThan(32);
    expect(decoded[(47 * 64 + 63) * 4 + 3]).toBeGreaterThan(223);
  });

  it("writes smaller files at lower quality, and quality 100 is closer to the original", async () => {
    const surface = gradient(64, 48);
    const low = await saveWith(type, documentOf(surface), {
      ...defaultSaveToken(type),
      quality: 20,
    });
    const high = await saveWith(type, documentOf(surface), {
      ...defaultSaveToken(type),
      quality: 95,
    });
    expect(low.length).toBeLessThan(high.length);
    const lowError = opaqueColorError(surface.data, pixelsOf(await loadWith(type, low)));
    const highError = opaqueColorError(surface.data, pixelsOf(await loadWith(type, high)));
    expect(highError).toBeLessThan(lowError);
  });

  it("ignores quality when lossless is on, so the bytes do not change", async () => {
    const surface = gradient(32, 32);
    const a = await saveWith(type, documentOf(surface), {
      ...defaultSaveToken(type),
      ...LOSSLESS,
      quality: 10,
    });
    const b = await saveWith(type, documentOf(surface), {
      ...defaultSaveToken(type),
      ...LOSSLESS,
      quality: 100,
    });
    expect(a).toEqual(b);
  });

  it("accepts every effort from 1 to 9 and decodes each result", async () => {
    const surface = gradient(24, 16);
    for (let effort = 1; effort <= 9; effort += 1) {
      const loaded = await loadWith(
        type,
        await saveWith(type, documentOf(surface), { ...defaultSaveToken(type), effort }),
      );
      expect([loaded.width, loaded.height]).toEqual([24, 16]);
    }
  });

  it("keeps EXIF and XMP unless Remove metadata is on", async () => {
    const exif = exifFromAsciiTags([{ tag: EXIF_TAG_ARTIST, text: TEXT.encode("Josh") }]);
    const xmp = "<x:xmpmeta xmlns:x='adobe:ns:meta/'/>";
    const surface = pattern(8, 8, () => 255);
    const file = documentOf(surface, {
      metadata: { ...(exif === undefined ? {} : { exif }), xmp: [xmp], user: {} },
    });

    const kept = await loadWith(type, await saveWith(type, file));
    expect(kept.metadata.exif).toEqual(exif);
    expect(kept.metadata.xmp).toEqual([xmp]);

    const removed = await loadWith(
      type,
      await saveWith(type, file, { ...defaultSaveToken(type), removeMetadata: true }),
    );
    expect(removed.metadata.exif).toBeUndefined();
    expect(removed.metadata.xmp).toEqual([]);
  });

  it("removes the EXIF orientation tag on load without turning the pixels again", async () => {
    const surface = pattern(6, 4, () => 255);
    const file = documentOf(surface, {
      metadata: { exif: tiffWithShorts([[EXIF_TAG_ORIENTATION, 6]]), xmp: [], user: {} },
    });
    const loaded = await loadWith(
      type,
      await saveWith(type, file, { ...defaultSaveToken(type), ...LOSSLESS }),
    );
    expect(exifOrientation(loaded.metadata.exif)).toBeUndefined();
    expect(loaded.width).toBe(6);
    expect(loaded.height).toBe(4);
    expect(pixelsOf(loaded)).toEqual(Array.from(surface.data));
  });

  it("encodes a one-pixel image in either direction", async () => {
    const token = { ...defaultSaveToken(type), ...LOSSLESS };
    const loaded = await loadWith(
      type,
      await saveWith(type, documentOf(pattern(1, 4, () => 255)), token),
    );
    expect([loaded.width, loaded.height]).toEqual([1, 4]);
  });

  it("stops before writing when the progress reporter cancels the save", async () => {
    const codec = await type.loadCodec();
    const writes: Uint8Array[] = [];
    const cancel = () => {
      throw new Error("canceled");
    };
    await expect(
      codec.save(
        documentOf(gradient(8, 8)),
        {
          write: async (chunk) => {
            writes.push(chunk);
          },
        },
        defaultSaveToken(type),
        cancel,
      ),
    ).rejects.toThrow("canceled");
    expect(writes).toEqual([]);
  });

  it("refuses bytes that are not a JPEG XL", async () => {
    await expect(loadWith(type, TEXT.encode("not an image"))).rejects.toBeInstanceOf(DecodeError);
  });
});
