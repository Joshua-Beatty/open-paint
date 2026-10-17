// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { init as initAvifDecoder } from "@jsquash/avif/decode.js";
import initWasm from "@openpaint/cpu";
import { defaultSaveToken, findOpenFileType } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { avifFileType, loadAvifFile } from "./avif-file-type";
import { avifIsLossless, avifSaveOptions } from "./avif-options";
import type { AvifDecoded } from "./codec-jobs";
import { DecodeError } from "./errors";
import { documentOf, pattern, pixelsOf, saveWith } from "./file-type-test-helpers";
import { builtinFileTypeRegistry } from "./file-types";
import { srgbIccProfile } from "./srgb-profile";
import { GPS_LATITUDE_REF_TAG, GPS_POINTER_TAG, gpsTiffBlock, subIfdAscii } from "./test-fixtures";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
  // Node cannot fetch the decoder's WASM URL, so the test instantiates it from its bytes (the browser fetches it).
  const decoderPath = createRequire(import.meta.url).resolve(
    "@jsquash/avif/codec/dec/avif_dec.wasm",
  );
  const decoderModule = new WebAssembly.Module(await readFile(decoderPath));
  await initAvifDecoder({
    instantiateWasm: (
      imports: WebAssembly.Imports,
      callback: (instance: WebAssembly.Instance) => void,
    ) => {
      const instance = new WebAssembly.Instance(decoderModule, imports);
      callback(instance);
      return instance.exports;
    },
  });
});

/** The brand of an ISO-BMFF file: the `ftyp` box's major brand, at byte 8. */
function brandOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.subarray(4, 12));
}

/** Decoder output for a file that needs no decoding: blank pixels and the given metadata. */
function decoded(width: number, height: number, overrides: Partial<AvifDecoded> = {}): AvifDecoded {
  const empty = new Uint8Array(0);
  return {
    width,
    height,
    pixels: new Uint8Array(width * height * 4),
    icc: empty,
    exif: empty,
    xmp: empty,
    ...overrides,
  };
}

describe("AVIF file type (FMT-REG-02 row 5, FMT-OPT-AVIF-01)", () => {
  const type = avifFileType();

  it("is registered after JPEG XL and opens and saves .avif", () => {
    const registry = builtinFileTypeRegistry();
    const ids = registry.list().map((entry) => entry.id);
    expect(ids.indexOf("avif")).toBe(ids.indexOf("jxl") + 1);
    expect(findOpenFileType(registry, ".AVIF")?.id).toBe("avif");
    expect(type.saveExtensions).toEqual([".avif"]);
    expect(type.mimeTypes).toEqual(["image/avif"]);
  });

  it("defaults to quality 85, Fast, 4:2:2, lossless alpha and metadata kept", () => {
    expect(avifSaveOptions(defaultSaveToken(type))).toEqual({
      quality: 85,
      lossless: false,
      losslessAlpha: true,
      speed: 8,
      chroma: 1,
      premultipliedAlpha: false,
      removeMetadata: false,
    });
    expect(avifIsLossless(defaultSaveToken(type))).toBe(false);
  });

  it("maps the presets and chroma choices to the encoder's ids", () => {
    expect(avifSaveOptions({ preset: "fast" }).speed).toBe(8);
    expect(avifSaveOptions({ preset: "medium" }).speed).toBe(6);
    expect(avifSaveOptions({ preset: "slow" }).speed).toBe(4);
    expect(avifSaveOptions({ preset: "verySlow" }).speed).toBe(2);
    expect(avifSaveOptions({ chromaSubsampling: "420" }).chroma).toBe(0);
    expect(avifSaveOptions({ chromaSubsampling: "444" }).chroma).toBe(2);
  });

  it("forces lossless alpha and no premultiplication while Lossless is on", () => {
    const options = avifSaveOptions({ lossless: true, losslessAlpha: false, quality: 10 });
    expect(options.losslessAlpha).toBe(true);
    expect(options.lossless).toBe(true);
    expect(avifIsLossless({ lossless: true })).toBe(true);
  });

  it("clamps quality to the encoder's 1 to 100 range", () => {
    expect(avifSaveOptions({ quality: 0 }).quality).toBe(1);
    expect(avifSaveOptions({ quality: 250 }).quality).toBe(100);
  });

  it("can be canceled, and a canceled save writes nothing (FMT-REG-06)", async () => {
    expect(type.capabilities.supportsCancellation).toBe(true);
    const codec = await type.loadCodec();
    const writes: Uint8Array[] = [];
    await expect(
      codec.save(
        documentOf(pattern(8, 8, () => 255)),
        {
          write: async (chunk) => {
            writes.push(chunk);
          },
        },
        defaultSaveToken(type),
        () => {
          throw new Error("canceled");
        },
      ),
    ).rejects.toThrow("canceled");
    expect(writes).toEqual([]);
  });

  it("writes an AVIF container for opaque and transparent images", async () => {
    const opaque = await saveWith(type, documentOf(pattern(24, 16, () => 255)));
    expect(brandOf(opaque)).toBe("ftypavif");
    const transparent = await saveWith(
      type,
      documentOf(pattern(24, 16, (x) => (x % 2 === 0 ? 0 : 255))),
    );
    expect(brandOf(transparent)).toBe("ftypavif");
  });

  it("writes every chroma choice, lossless, and premultiplied output", async () => {
    const file = documentOf(pattern(18, 10, () => 200));
    for (const chromaSubsampling of ["420", "422", "444"]) {
      const bytes = await saveWith(type, file, { ...defaultSaveToken(type), chromaSubsampling });
      expect(brandOf(bytes)).toBe("ftypavif");
    }
    const lossless = await saveWith(type, file, { ...defaultSaveToken(type), lossless: true });
    expect(brandOf(lossless)).toBe("ftypavif");
    const premultiplied = await saveWith(type, file, {
      ...defaultSaveToken(type),
      premultipliedAlpha: true,
    });
    expect(brandOf(premultiplied)).toBe("ftypavif");
  });

  it("writes the sRGB profile as an ICC colr property (FMT-META-05)", async () => {
    const bytes = await saveWith(type, documentOf(pattern(18, 10, () => 200)));
    const icc = srgbIccProfile();
    const at = Buffer.from(bytes).indexOf(Buffer.from(icc));
    expect(at).toBeGreaterThan(8);
    expect(
      Buffer.from(bytes)
        .subarray(at - 8, at - 4)
        .toString("latin1"),
    ).toBe("colr");
    expect(
      Buffer.from(bytes)
        .subarray(at - 4, at)
        .toString("latin1"),
    ).toBe("prof");
  });

  it("decodes lossless AVIF through the WASM decoder within one level per channel (WEB-FILE-07)", async () => {
    const original = documentOf(
      pattern(18, 10, (x, y) => ((x + y) % 3 === 0 ? 0 : 255 - ((x * 7 + y) % 200))),
    );
    const bytes = await saveWith(type, original, { ...defaultSaveToken(type), lossless: true });
    const loaded = await loadAvifFile(bytes);
    expect(loaded.width).toBe(18);
    expect(loaded.height).toBe(10);
    const expected = pixelsOf(original);
    const actual = pixelsOf(loaded);
    expect(actual).toHaveLength(expected.length);
    expect(
      Math.max(...expected.map((value, at) => Math.abs(value - (actual[at] ?? 0)))),
    ).toBeLessThanOrEqual(1);
  });

  it("opens the decoder's pixels as sRGB, without metadata", async () => {
    const loaded = await loadAvifFile(new Uint8Array([0, 0, 0, 0]), async () => decoded(4, 3));
    expect(loaded.width).toBe(4);
    expect(loaded.height).toBe(3);
    expect(loaded.colorProfile).toBe("srgb");
    expect(loaded.layers[0]?.surface.width).toBe(4);
    expect(loaded.metadata.exif).toBeUndefined();
    expect(loaded.metadata.xmp).toEqual([]);
  });

  it("keeps the EXIF GPS block and the XMP packet as container items, and drops them with Remove metadata", async () => {
    const packet = "<x:xmpmeta>avif</x:xmpmeta>";
    const file = documentOf(
      pattern(18, 10, () => 255),
      {
        metadata: { exif: gpsTiffBlock(), xmp: [packet], user: {} },
      },
    );
    const kept = await loadAvifFile(await saveWith(type, file));
    expect(kept.metadata.xmp).toEqual([packet]);
    expect(subIfdAscii(kept.metadata.exif, GPS_POINTER_TAG, GPS_LATITUDE_REF_TAG)).toBe("N");

    const removed = await loadAvifFile(
      await saveWith(type, file, { ...defaultSaveToken(type), removeMetadata: true }),
    );
    expect(removed.metadata.exif).toBeUndefined();
    expect(removed.metadata.xmp).toEqual([]);
  });

  it("opens the pixels without metadata when the decoder returns none", async () => {
    const loaded = await loadAvifFile(new Uint8Array([0, 0, 0, 0]), async () => decoded(4, 3));
    expect(loaded.layers[0]?.surface.height).toBe(3);
    expect(loaded.metadata.exif).toBeUndefined();
    expect(loaded.metadata.xmp).toEqual([]);
  });

  it("reports a decoder failure or an undecodable file as a DecodeError", async () => {
    await expect(
      loadAvifFile(new Uint8Array([1]), async () => {
        throw new Error("unsupported");
      }),
    ).rejects.toBeInstanceOf(DecodeError);
    await expect(loadAvifFile(new Uint8Array([1]))).rejects.toBeInstanceOf(DecodeError);
  });
});
