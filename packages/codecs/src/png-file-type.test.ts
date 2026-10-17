// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  type FileCodec,
  type FileDocument,
  findOpenFileType,
  findSaveFileType,
  openFileTypes,
  saveFileTypes,
} from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { DecodeError } from "./errors";
import { builtinFileTypeRegistry } from "./file-types";
import { decodePng, type RgbaImage } from "./png";
import { pngFileType } from "./png-file-type";
import { inflateZlib } from "./zlib";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

async function codecOf(): Promise<FileCodec> {
  return pngFileType().loadCodec();
}

function flatDocument(surface: Surface): FileDocument {
  return {
    width: surface.width,
    height: surface.height,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: { xmp: [], user: {} },
    layers: [{ name: "Background", visible: true, opacity: 255, blendMode: 0, surface }],
  };
}

async function encodeToBytes(surface: Surface): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  await (await codecOf()).save(
    flatDocument(surface),
    {
      write: async (chunk) => {
        chunks.push(new Uint8Array(chunk));
      },
    },
    {},
    () => undefined,
  );
  return new Uint8Array(chunks.flatMap((chunk) => [...chunk]));
}

describe("built-in file types (FMT-REG-01, FMT-REG-07)", () => {
  it("registers PNG with its extensions and capabilities", () => {
    const registry = builtinFileTypeRegistry();
    expect(registry.list().map((type) => type.id)).toEqual([
      "png",
      "jpeg",
      "jxl",
      "avif",
      "webp",
      "dds",
      "tiff",
      "gif",
      "bmp",
      "tga",
      "opaint",
    ]);
    expect(openFileTypes(registry).map((type) => type.id)).toEqual([
      "png",
      "jpeg",
      "jxl",
      "avif",
      "webp",
      "dds",
      "tiff",
      "gif",
      "bmp",
      "tga",
      "opaint",
    ]);
    expect(saveFileTypes(registry).map((type) => type.id)).toEqual([
      "png",
      "jpeg",
      "jxl",
      "avif",
      "webp",
      "tiff",
      "gif",
      "bmp",
      "tga",
      "opaint",
    ]);
    expect(findOpenFileType(registry, ".PNG")?.id).toBe("png");
    expect(findSaveFileType(registry, ".png")?.id).toBe("png");
  });

  it("declares PNG as a lossless flat format without layers (FMT-REG-06)", () => {
    const png = pngFileType();
    expect(png.capabilities.supportsLayers).toBe(false);
    expect(png.capabilities.supportsSaving).toBe(true);
    expect(png.capabilities.supportsLoading).toBe(true);
    expect(png.isLossless({})).toBe(true);
    expect(png.mimeTypes).toEqual(["image/png"]);
  });
});

describe("PNG codec (FMT-SAVE-03)", () => {
  it("writes a PNG that decodes to the same straight-alpha pixels", async () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4,
    ]);
    const bytes = await encodeToBytes(new Surface(2, 2, pixels));

    expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    const decoded: RgbaImage = await decodePng(bytes, inflateZlib);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(decoded.data).toEqual(new Uint8Array(pixels));
  });

  it("loads a PNG through the WASM decoder with the same straight-alpha pixels", async () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4,
    ]);
    const bytes = await encodeToBytes(new Surface(2, 2, pixels));
    const loaded = await (await codecOf()).load({
      byteLength: bytes.length,
      readAll: async () => bytes,
    });
    expect(loaded.width).toBe(2);
    expect(loaded.height).toBe(2);
    expect(loaded.layers[0]?.surface.data).toEqual(pixels);
  });

  it("rejects bytes that are not a PNG as a DecodeError", async () => {
    const codec = await codecOf();
    const source = {
      byteLength: 4,
      readAll: async () => new Uint8Array([1, 2, 3, 4]),
    };
    await expect(codec.load(source)).rejects.toBeInstanceOf(DecodeError);
  });
});
