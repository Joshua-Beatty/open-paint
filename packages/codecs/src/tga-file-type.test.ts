// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  type ByteSource,
  defaultSaveToken,
  type FileDocument,
  type FileTypeDescriptor,
  findOpenFileType,
} from "@openpaint/extension-api";
import type { PropertyValues } from "@openpaint/properties";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DecodeError } from "./errors";
import {
  EXIF_TAG_ARTIST,
  EXIF_TAG_IMAGE_DESCRIPTION,
  exifAsciiBytes,
  exifFromAsciiTags,
} from "./exif";
import { builtinFileTypeRegistry } from "./file-types";
import { loadTgaFile, tgaFileType } from "./tga-file-type";
import { tgaIsLossless } from "./tga-options";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A surface with long runs and varied pixels, so RLE packets of both kinds appear. */
function pattern(width: number, height: number, alpha: (x: number, y: number) => number): Surface {
  const surface = new Surface(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const run = y < 2;
      surface.data[at] = run ? 9 : (x * 37) % 256;
      surface.data[at + 1] = run ? 9 : (y * 53) % 256;
      surface.data[at + 2] = run ? 9 : ((x + y) * 11) % 256;
      surface.data[at + 3] = alpha(x, y);
    }
  }
  return surface;
}

function documentOf(
  surface: Surface,
  metadata: FileDocument["metadata"] = { xmp: [], user: {} },
): FileDocument {
  return {
    width: surface.width,
    height: surface.height,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata,
    layers: [{ name: "Background", visible: true, opacity: 255, blendMode: 0, surface }],
  };
}

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

/** The offset of the extension area, from the footer. */
function extensionAt(bytes: Uint8Array): number {
  return view(bytes).getUint32(bytes.length - 26, true);
}

/** An EXIF block whose IFD0 holds one ASCII tag, the way a photo's Artist tag is laid out. */
function exifWithAscii(tag: number, text: string): Uint8Array {
  const data = new TextEncoder().encode(`${text}\0`);
  const bytes = new Uint8Array(26 + data.length);
  const out = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49, 0x2a, 0], 0);
  out.setUint32(4, 8, true);
  out.setUint16(8, 1, true);
  out.setUint16(10, tag, true);
  out.setUint16(12, 2, true);
  out.setUint32(14, data.length, true);
  out.setUint32(18, 26, true);
  out.setUint32(22, 0, true);
  bytes.set(data, 26);
  return bytes;
}

describe("TGA file type", () => {
  const type = tgaFileType();

  it("opens and saves .tga", () => {
    expect(findOpenFileType(builtinFileTypeRegistry(), ".TGA")?.id).toBe("tga");
    expect(type.saveExtensions).toEqual([".tga"]);
    expect(type.mimeTypes).toEqual(["image/x-tga"]);
  });

  it("round-trips 32-bit RLE pixels exactly, alpha included", async () => {
    const surface = pattern(9, 5, (x, y) => (x * 29 + y * 7) % 256);
    const bytes = await save(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 32,
      rle: true,
    });
    expect(bytes[2]).toBe(10);
    expect(bytes[16]).toBe(32);
    const loaded = await load(type, bytes);
    expect(loaded.width).toBe(9);
    expect(loaded.layers[0]?.surface.data).toEqual(surface.data);
  });

  it("round-trips 32-bit raw pixels exactly", async () => {
    const surface = pattern(4, 3, (x) => 60 + x * 50);
    const bytes = await save(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 32,
      rle: false,
    });
    expect(bytes[2]).toBe(2);
    expect((await load(type, bytes)).layers[0]?.surface.data).toEqual(surface.data);
  });

  it("round-trips 24-bit RLE as opaque pixels", async () => {
    const surface = pattern(6, 4, () => 255);
    const bytes = await save(type, documentOf(surface), {
      ...defaultSaveToken(type),
      bitDepth: 24,
      rle: true,
    });
    expect(bytes[16]).toBe(24);
    expect((await load(type, bytes)).layers[0]?.surface.data).toEqual(surface.data);
  });

  it("auto-detect writes 24-bit for opaque images and 32-bit when alpha is present", async () => {
    const opaque = await save(type, documentOf(pattern(4, 4, () => 255)));
    expect(opaque[16]).toBe(24);
    const translucent = await save(type, documentOf(pattern(4, 4, (x) => (x === 0 ? 0 : 200))));
    expect(translucent[16]).toBe(32);
  });

  it("writes the author and comment from EXIF, and the software ID and save date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 13, 14, 5, 6));
    const exif = exifWithAscii(0x013b, "Pixel Artist");
    const metadata = { exif, xmp: [], user: {} };
    const bytes = await save(
      type,
      documentOf(
        pattern(2, 2, () => 255),
        metadata,
      ),
      {
        ...defaultSaveToken(type),
        bitDepth: 24,
      },
    );
    const ext = extensionAt(bytes);
    const author = new TextDecoder().decode(bytes.subarray(ext + 2, ext + 43)).split("\0")[0];
    expect(author).toBe("Pixel Artist");
    expect([
      view(bytes).getUint16(ext + 367, true),
      view(bytes).getUint16(ext + 369, true),
    ]).toEqual([10, 13]);
    expect(view(bytes).getUint16(ext + 371, true)).toBe(2026);
    expect(new TextDecoder().decode(bytes.subarray(ext + 426, ext + 435))).toBe("OpenPaint");
    expect(bytes[ext + 494]).toBe(0);
  });

  it("leaves the author and comment blank with Remove metadata", async () => {
    const metadata = { exif: exifWithAscii(0x013b, "Pixel Artist"), xmp: [], user: {} };
    const bytes = await save(
      type,
      documentOf(
        pattern(2, 2, () => 255),
        metadata,
      ),
      {
        ...defaultSaveToken(type),
        bitDepth: 24,
        removeMetadata: true,
      },
    );
    const ext = extensionAt(bytes);
    expect(bytes[ext + 2]).toBe(0);
    expect(bytes[ext + 43]).toBe(0);
  });

  it("reads the author and comment back into the EXIF Artist and ImageDescription tags", async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const comment =
      "A comment long enough to fill more than one of the four 80-byte lines of the extension area.";
    const exif = exifFromAsciiTags([
      { tag: EXIF_TAG_ARTIST, text: encode("Al") },
      { tag: EXIF_TAG_IMAGE_DESCRIPTION, text: encode(comment) },
    ]);
    const bytes = await save(
      type,
      documentOf(
        pattern(2, 2, () => 255),
        { exif, xmp: [], user: {} },
      ),
      { ...defaultSaveToken(type), bitDepth: 24 },
    );
    const loaded = await load(type, bytes);
    expect(exifAsciiBytes(loaded.metadata.exif, EXIF_TAG_ARTIST)).toEqual(encode("Al"));
    expect(exifAsciiBytes(loaded.metadata.exif, EXIF_TAG_IMAGE_DESCRIPTION)).toEqual(
      encode(comment),
    );
  });

  it("opens a TGA with blank author and comment fields without an EXIF block", async () => {
    const bytes = await save(type, documentOf(pattern(2, 2, () => 255)));
    expect((await load(type, bytes)).metadata.exif).toBeUndefined();
  });

  it("loads with the default resolution, since TGA carries no density", async () => {
    const bytes = await save(type, documentOf(pattern(2, 2, () => 255)));
    expect(loadTgaFile(bytes).resolution).toEqual(DEFAULT_RESOLUTION);
  });

  it("refuses bytes that are not a TGA", () => {
    expect(() => loadTgaFile(new TextEncoder().encode("not an image at all"))).toThrow(DecodeError);
  });

  it("is lossless only for Auto-detect and 32-bit", () => {
    expect(tgaIsLossless({ ...defaultSaveToken(type), bitDepth: 0 })).toBe(true);
    expect(tgaIsLossless({ ...defaultSaveToken(type), bitDepth: 32 })).toBe(true);
    expect(tgaIsLossless({ ...defaultSaveToken(type), bitDepth: 24 })).toBe(false);
    expect(type.isLossless(defaultSaveToken(type))).toBe(true);
  });
});
