// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import {
  findOpenFileType,
  findSaveFileType,
  openFileTypes,
  saveFileTypes,
} from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { ddsFileType, loadDdsFile } from "./dds-file-type";
import { DecodeError } from "./errors";
import { documentOf, loadWith, pattern, pixelsOf } from "./file-type-test-helpers";
import { builtinFileTypeRegistry } from "./file-types";

const TEXT = new TextEncoder();

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** A legacy DDS file: a 128-byte header with the given pixel format, then the level data. */
function legacyDds(
  width: number,
  height: number,
  flags: number,
  fourcc: string,
  bits: number,
  masks: readonly number[],
  data: readonly number[],
): Uint8Array {
  const header = new Uint8Array(128);
  const view = new DataView(header.buffer);
  header.set(TEXT.encode("DDS "), 0);
  view.setUint32(4, 124, true);
  view.setUint32(12, height, true);
  view.setUint32(16, width, true);
  view.setUint32(76, 32, true);
  view.setUint32(80, flags, true);
  header.set(TEXT.encode(fourcc), 84);
  view.setUint32(88, bits, true);
  for (const [i, mask] of masks.entries()) {
    view.setUint32(92 + i * 4, mask >>> 0, true);
  }
  const out = new Uint8Array(header.length + data.length);
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}

describe("DDS file type (FMT-REG-02 row 7, open only)", () => {
  const type = ddsFileType();

  it("is registered after WebP, opens .dds and is not offered for saving", () => {
    const registry = builtinFileTypeRegistry();
    const ids = registry.list().map((entry) => entry.id);
    expect(ids.indexOf("dds")).toBe(ids.indexOf("webp") + 1);
    expect(findOpenFileType(registry, ".DDS")?.id).toBe("dds");
    expect(openFileTypes(registry).map((entry) => entry.id)).toContain("dds");
    expect(saveFileTypes(registry).map((entry) => entry.id)).not.toContain("dds");
    expect(findSaveFileType(registry, ".dds")).toBeUndefined();
    expect(type.saveExtensions).toEqual([]);
    expect(type.capabilities.supportsSaving).toBe(false);
    expect(type.capabilities.supportsLoading).toBe(true);
  });

  it("opens a legacy 32-bit BGRA texture as straight RGBA", async () => {
    const bytes = legacyDds(
      2,
      1,
      0x41,
      "\0\0\0\0",
      32,
      [0xff0000, 0xff00, 0xff, 0xff000000],
      [10, 20, 30, 40, 1, 2, 3, 4],
    );
    const loaded = await loadWith(type, bytes);
    expect(loaded.width).toBe(2);
    expect(loaded.height).toBe(1);
    expect(pixelsOf(loaded)).toEqual([30, 20, 10, 40, 3, 2, 1, 4]);
  });

  it("decodes a BC1 texture block", async () => {
    const bytes = legacyDds(4, 4, 0x4, "DXT1", 0, [0, 0, 0, 0], [0x00, 0xf8, 0, 0, 0, 0, 0, 0]);
    const loaded = await loadWith(type, bytes);
    const expected = Array.from({ length: 16 }, () => [255, 0, 0, 255]).flat();
    expect(pixelsOf(loaded)).toEqual(expected);
  });

  it("refuses bytes that are not a DDS texture", async () => {
    await expect(
      loadWith(type, TEXT.encode("not an image at all, not even close")),
    ).rejects.toBeInstanceOf(DecodeError);
  });

  it("names an unsupported format", async () => {
    const bytes = legacyDds(4, 4, 0x4, "DX11", 0, [0, 0, 0, 0], new Array(16).fill(0));
    await expect(loadDdsFile(bytes)).rejects.toBeInstanceOf(DecodeError);
  });

  it("has no save path", async () => {
    const codec = await type.loadCodec();
    await expect(
      codec.save(
        documentOf(pattern(1, 1, () => 255)),
        { write: async () => undefined },
        {},
        () => undefined,
      ),
    ).rejects.toThrow("cannot be saved");
  });
});
