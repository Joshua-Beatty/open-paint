// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { init as initWebpEncoder } from "@jsquash/webp/encode.js";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { defaultSaveToken, findOpenFileType } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { runCodecJob } from "./codec-jobs";
import { DecodeError } from "./errors";
import { EXIF_TAG_ARTIST, exifFromAsciiTags } from "./exif";
import { documentOf, loadWith, pattern, pixelsOf, saveWith } from "./file-type-test-helpers";
import { builtinFileTypeRegistry } from "./file-types";
import { srgbIccProfile } from "./srgb-profile";
import { webpEncodeOptions } from "./webp-encoder";
import { webpFileType } from "./webp-file-type";
import { webpIsLossless, webpSaveOptions } from "./webp-options";

const TEXT = new TextEncoder();

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
  // Node cannot fetch the encoder's WASM URL, so the test instantiates it from its bytes (the browser fetches it).
  const encoderPath = createRequire(import.meta.url).resolve(
    "@jsquash/webp/codec/enc/webp_enc_simd.wasm",
  );
  const encoderModule = new WebAssembly.Module(await readFile(encoderPath));
  await initWebpEncoder({
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

/** Textured content, which the presets encode differently. */
function texture(width: number, height: number): Surface {
  const surface = new Surface(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = ((x * 73 + y * 151) ^ (x * y * 29)) & 255;
      surface.data.set([v, 255 - v, (v * 3) & 255, 255], (y * width + x) * 4);
    }
  }
  return surface;
}

function psnr(a: number[], b: number[]): number {
  const mse = a.reduce((sum, value, i) => sum + (value - (b[i] ?? 0)) ** 2, 0) / a.length;
  return 10 * Math.log10((255 * 255) / mse);
}

/** Smooth, opaque content: gradients that lossy VP8 keeps close to the source. */
function smooth(width: number, height: number): Surface {
  const surface = new Surface(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      surface.data.set([x * 2, y * 2, 128, 255], (y * width + x) * 4);
    }
  }
  return surface;
}

describe("WebP file type (FMT-REG-02 row 6, FMT-OPT-WEBP-01)", () => {
  const type = webpFileType();

  it("is registered after AVIF and opens and saves .webp", () => {
    const registry = builtinFileTypeRegistry();
    expect(registry.list().map((entry) => entry.id)).toContain("webp");
    expect(findOpenFileType(registry, ".WEBP")?.id).toBe("webp");
    expect(type.saveExtensions).toEqual([".webp"]);
    expect(type.mimeTypes).toEqual(["image/webp"]);
    expect(type.capabilities.supportsLayers).toBe(false);
    expect(type.capabilities.supportsSaving).toBe(true);
  });

  it("defaults to Photo, quality 95, lossy, with metadata kept", () => {
    expect(webpSaveOptions(defaultSaveToken(type))).toEqual({
      preset: "photo",
      quality: 95,
      lossless: false,
      removeMetadata: false,
    });
    expect(webpIsLossless(defaultSaveToken(type))).toBe(false);
    expect(type.isLossless({ ...defaultSaveToken(type), lossless: true })).toBe(true);
  });

  it("clamps quality and falls back on invalid presets", () => {
    const options = webpSaveOptions({ quality: 140, preset: "nonsense" });
    expect(options.quality).toBe(100);
    expect(options.preset).toBe("photo");
  });

  it("writes a RIFF WEBP file", async () => {
    const bytes = await saveWith(type, documentOf(smooth(20, 12)));
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WEBP");
  });

  it("round-trips lossless pixels exactly, including alpha", async () => {
    const surface = pattern(37, 23, (x, y) => ((x + y) % 4 === 0 ? 0 : 255));
    const token = { ...defaultSaveToken(type), lossless: true };
    const loaded = await loadWith(type, await saveWith(type, documentOf(surface), token));
    expect(loaded.width).toBe(37);
    expect(loaded.height).toBe(23);
    expect(pixelsOf(loaded)).toEqual(Array.from(surface.data));
  });

  it("maps each preset to libwebp's tuning, and leaves lossless output untuned", () => {
    expect(webpEncodeOptions({ quality: 95, lossless: false, preset: "default" })).toEqual({
      lossless: 0,
      quality: 95,
    });
    expect(webpEncodeOptions({ quality: 95, lossless: false, preset: "photo" })).toEqual({
      lossless: 0,
      quality: 95,
      sns_strength: 80,
      filter_sharpness: 3,
      filter_strength: 30,
      preprocessing: 2,
    });
    expect(webpEncodeOptions({ quality: 95, lossless: false, preset: "text" })).toEqual({
      lossless: 0,
      quality: 95,
      sns_strength: 0,
      filter_strength: 0,
      segments: 2,
    });
    expect(webpEncodeOptions({ quality: 40, lossless: true, preset: "icon" })).toEqual({
      lossless: 1,
      exact: 1,
    });
  });

  it("writes a different bitstream for each preset", async () => {
    const surface = texture(48, 32);
    const bytesFor = (preset: string) =>
      saveWith(type, documentOf(surface), { ...defaultSaveToken(type), preset });
    const same = (a: Uint8Array, b: Uint8Array) =>
      a.length === b.length && a.every((value, i) => value === b[i]);
    const picture = await bytesFor("picture");
    const icon = await bytesFor("icon");
    const photo = await bytesFor("photo");
    expect(same(picture, icon)).toBe(false);
    expect(same(photo, icon)).toBe(false);
    expect(same(picture, await bytesFor("picture"))).toBe(true);
  });

  it("keeps smooth content close at quality 95", async () => {
    const surface = smooth(64, 48);
    const loaded = await loadWith(type, await saveWith(type, documentOf(surface)));
    expect(psnr(Array.from(surface.data), pixelsOf(loaded))).toBeGreaterThan(40);
  });

  it("writes smaller files at lower quality", async () => {
    const surface = smooth(96, 64);
    const high = await saveWith(type, documentOf(surface), {
      ...defaultSaveToken(type),
      quality: 95,
    });
    const low = await saveWith(type, documentOf(surface), {
      ...defaultSaveToken(type),
      quality: 20,
    });
    expect(low.length).toBeLessThan(high.length);
  });

  it("embeds the sRGB profile, and keeps EXIF and XMP unless Remove metadata is on", async () => {
    const exif = exifFromAsciiTags([{ tag: EXIF_TAG_ARTIST, text: TEXT.encode("Josh") }]);
    const xmp = "<x:xmpmeta xmlns:x='adobe:ns:meta/'/>";
    const file = {
      ...documentOf(smooth(8, 8)),
      metadata: {
        ...documentOf(smooth(8, 8)).metadata,
        ...(exif === undefined ? {} : { exif }),
        xmp: [xmp],
      },
    };
    const bytes = await saveWith(type, file, { ...defaultSaveToken(type), lossless: true });
    const raw = await runCodecJob("decodeWebp", { bytes });
    expect(raw.icc).toEqual(srgbIccProfile());

    const kept = await loadWith(type, bytes);
    expect(kept.metadata.exif).toEqual(exif);
    expect(kept.metadata.xmp).toEqual([xmp]);

    const removed = await loadWith(
      type,
      await saveWith(type, file, {
        ...defaultSaveToken(type),
        lossless: true,
        removeMetadata: true,
      }),
    );
    expect(removed.metadata.exif).toBeUndefined();
    expect(removed.metadata.xmp).toEqual([]);
  });

  it("refuses bytes that are not a WebP", async () => {
    await expect(loadWith(type, TEXT.encode("not an image"))).rejects.toBeInstanceOf(DecodeError);
  });
});
