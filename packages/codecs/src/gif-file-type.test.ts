// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { defaultSaveToken, findOpenFileType } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { DecodeError } from "./errors";
import {
  documentOf,
  loadWith,
  overWhite,
  pattern,
  pixelsOf,
  saveWith,
} from "./file-type-test-helpers";
import { builtinFileTypeRegistry } from "./file-types";
import { gifFileType, loadGifFile } from "./gif-file-type";
import { gifSaveOptions } from "./gif-options";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const XMP_IDENTIFIER = new TextEncoder().encode("XMP DataXMP");

/** Whether `needle` appears in `haystack`. */
function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return haystack.some((_, start) =>
    needle.every((byte, offset) => haystack[start + offset] === byte),
  );
}

describe("GIF file type", () => {
  const type = gifFileType();

  it("is registered and opens and saves .gif", () => {
    const registry = builtinFileTypeRegistry();
    expect(findOpenFileType(registry, ".GIF")?.id).toBe("gif");
    expect(type.saveExtensions).toEqual([".gif"]);
    expect(type.mimeTypes).toEqual(["image/gif"]);
    expect(type.isLossless(defaultSaveToken(type))).toBe(false);
  });

  it("round-trips an image with 256 colors or fewer exactly", async () => {
    const surface = new Surface(4, 2);
    const colors = [
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [9, 99, 199],
    ];
    for (let pixel = 0; pixel < 8; pixel += 1) {
      const color = colors[pixel % colors.length] ?? [0, 0, 0];
      surface.data.set([...color, 255], pixel * 4);
    }
    const loaded = await loadWith(type, await saveWith(type, documentOf(surface)));
    expect([loaded.width, loaded.height]).toEqual([4, 2]);
    expect(pixelsOf(loaded)).toEqual(Array.from(surface.data));
  });

  it("keeps transparent pixels transparent and blends partly transparent ones toward white", async () => {
    const surface = new Surface(4, 1);
    surface.data.set([10, 20, 30, 0], 0);
    surface.data.set([10, 20, 30, 255], 4);
    surface.data.set([10, 20, 30, 200], 8);
    surface.data.set([10, 20, 30, 100], 12);
    const pixels = pixelsOf(await loadWith(type, await saveWith(type, documentOf(surface))));
    expect(pixels[3]).toBe(0);
    expect(pixels.slice(4, 8)).toEqual([10, 20, 30, 255]);
    expect(pixels.slice(8, 12)).toEqual([
      overWhite(10, 200),
      overWhite(20, 200),
      overWhite(30, 200),
      255,
    ]);
    expect(pixels[15]).toBe(0);
  });

  it("quantizes an image with more colors than a palette holds", async () => {
    const surface = pattern(20, 20, () => 255);
    const pixels = pixelsOf(await loadWith(type, await saveWith(type, documentOf(surface))));
    const colors = new Set<string>();
    for (let at = 0; at < pixels.length; at += 4) colors.add(pixels.slice(at, at + 3).join(","));
    expect(colors.size).toBeGreaterThan(1);
    expect(colors.size).toBeLessThanOrEqual(256);
  });

  it("writes the XMP packet in an application extension, unless Remove metadata is on", async () => {
    const surface = pattern(2, 2, () => 255);
    const file = documentOf(surface, {
      metadata: { xmp: ["<x:xmpmeta/>"], user: {} },
    });
    expect(contains(await saveWith(type, file), XMP_IDENTIFIER)).toBe(true);
    const removed = await saveWith(type, file, {
      ...defaultSaveToken(type),
      removeMetadata: true,
    });
    expect(contains(removed, XMP_IDENTIFIER)).toBe(false);
  });

  it("reads the XMP packet back on open, and drops it with Remove metadata", async () => {
    const packet = `<x:xmpmeta>${"gif ".repeat(120)}</x:xmpmeta>`;
    const file = documentOf(
      pattern(2, 2, () => 255),
      { metadata: { xmp: [packet], user: {} } },
    );
    const kept = await loadWith(type, await saveWith(type, file));
    expect(kept.metadata.xmp).toEqual([packet]);

    const removed = await loadWith(
      type,
      await saveWith(type, file, { ...defaultSaveToken(type), removeMetadata: true }),
    );
    expect(removed.metadata.xmp).toEqual([]);
  });

  it("uses the palette options of the save token", () => {
    const options = gifSaveOptions(defaultSaveToken(type));
    expect(options).toEqual({
      transparencyThreshold: 128,
      quantization: "octree",
      dithering: 7,
      removeMetadata: false,
    });
  });

  it("refuses bytes that are not a GIF", () => {
    expect(() => loadGifFile(new TextEncoder().encode("not a gif"))).toThrow(DecodeError);
  });
});
