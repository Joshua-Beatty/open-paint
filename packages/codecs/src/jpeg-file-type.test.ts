// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import { type FileDocument, findOpenFileType } from "@openpaint/extension-api";
import type { PropertyValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultCmykProfile } from "./cmyk-profile";
import { DecodeError } from "./errors";
import { EXIF_TAG_ORIENTATION, exifOrientation } from "./exif";
import { builtinFileTypeRegistry } from "./file-types";
import { PROFILE_IGNORED_WARNING } from "./icc-transform";
import { jpegFileType, loadJpegFile } from "./jpeg-file-type";
import { readJpegMetadata } from "./jpeg-metadata";
import { jpegSaveOptions } from "./jpeg-options";
import { dotsPerInch, flattenOverWhite } from "./jpeg-save";
import { decodeWithJpegJs, jpegWithSegments, tiffWithShorts } from "./test-fixtures";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function gradient(width: number, height: number, alpha = 255): Surface {
  const surface = new Surface(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      surface.data[at] = Math.round((x * 255) / Math.max(1, width - 1));
      surface.data[at + 1] = Math.round((y * 255) / Math.max(1, height - 1));
      surface.data[at + 2] = 128;
      surface.data[at + 3] = alpha;
    }
  }
  return surface;
}

function flatDocument(surface: Surface, extra: Partial<FileDocument> = {}): FileDocument {
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

async function saveBytes(file: FileDocument, token: PropertyValues = {}): Promise<Uint8Array> {
  const codec = await jpegFileType().loadCodec();
  const chunks: Uint8Array[] = [];
  await codec.save(
    file,
    {
      write: async (chunk) => {
        chunks.push(new Uint8Array(chunk));
      },
    },
    token,
    () => {},
  );
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The mean and the largest difference over the color channels, between two same-size surfaces. */
function channelError(a: Surface, b: Surface): { mean: number; max: number } {
  let sum = 0;
  let max = 0;
  let count = 0;
  for (let at = 0; at < a.data.length; at += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs((a.data[at + channel] ?? 0) - (b.data[at + channel] ?? 0));
      sum += difference;
      max = Math.max(max, difference);
      count += 1;
    }
  }
  return { mean: sum / count, max };
}

function samplingByte(bytes: Uint8Array): number {
  const sof = bytes.findIndex((byte, index) => byte === 0xff && bytes[index + 1] === 0xc0);
  return bytes[sof + 11] ?? 0;
}

describe("JPEG round trips", () => {
  it("keeps the pixels closely at quality 100 with no chroma subsampling", async () => {
    const surface = gradient(48, 32);
    const bytes = await saveBytes(flatDocument(surface), {
      quality: 100,
      chromaSubsampling: "444",
    });
    const loaded = await loadJpegFile(bytes);
    const error = channelError(surface, loaded.layers[0]?.surface as Surface);
    expect(loaded.width).toBe(48);
    expect(loaded.height).toBe(32);
    expect(error.mean).toBeLessThan(1.5);
    expect(error.max).toBeLessThanOrEqual(6);
  });

  it("writes 4:2:0 at quality 95 by default", async () => {
    const surface = gradient(48, 32);
    const bytes = await saveBytes(flatDocument(surface));
    expect(samplingByte(bytes)).toBe(0x22);
    const loaded = await loadJpegFile(bytes);
    expect(channelError(surface, loaded.layers[0]?.surface as Surface).mean).toBeLessThan(4);
  });

  it("writes the chosen chroma subsampling", async () => {
    const surface = gradient(16, 16);
    for (const [choice, expected] of [
      ["444", 0x11],
      ["440", 0x12],
      ["422", 0x21],
      ["420", 0x22],
    ] as const) {
      const bytes = await saveBytes(flatDocument(surface), { chromaSubsampling: choice });
      expect(samplingByte(bytes), choice).toBe(expected);
    }
  });

  it("flattens transparent pixels over white", async () => {
    const bytes = await saveBytes(flatDocument(gradient(16, 16, 0)), { quality: 100 });
    const loaded = await loadJpegFile(bytes);
    const pixels = loaded.layers[0]?.surface.data ?? new Uint8ClampedArray();
    for (let at = 0; at < pixels.length; at += 4) {
      expect(pixels[at] ?? 0).toBeGreaterThanOrEqual(250);
      expect(pixels[at + 2] ?? 0).toBeGreaterThanOrEqual(250);
    }
  });

  it("embeds the sRGB profile and the density, and reads the density back", async () => {
    const bytes = await saveBytes(
      flatDocument(gradient(16, 16), { resolution: { unit: "inch", x: 300, y: 150 } }),
    );
    expect(new TextDecoder().decode(bytes)).toContain("ICC_PROFILE");
    const loaded = await loadJpegFile(bytes);
    expect(loaded.resolution).toEqual({ unit: "inch", x: 300, y: 150 });
  });

  it("keeps EXIF, XMP and IPTC unless Remove metadata is on", async () => {
    const exif = tiffWithShorts([[0x0128, 2]]);
    const iptc = new Uint8Array([0x1c, 0x02, 0x05, 0x41]);
    const metadata = { exif, xmp: ["<x:xmpmeta>kept</x:xmpmeta>"], iptc, user: {} };
    const kept = await loadJpegFile(await saveBytes(flatDocument(gradient(16, 16), { metadata })));
    expect(kept.metadata.exif).toEqual(exif);
    expect(kept.metadata.xmp).toEqual(["<x:xmpmeta>kept</x:xmpmeta>"]);
    expect(kept.metadata.iptc).toEqual(iptc);

    const removed = await loadJpegFile(
      await saveBytes(flatDocument(gradient(16, 16), { metadata }), { removeMetadata: true }),
    );
    expect(removed.metadata.exif).toBeUndefined();
    expect(removed.metadata.xmp).toEqual([]);
    expect(removed.metadata.iptc).toBeUndefined();
  });

  it("keeps the GPS location in EXIF, and Remove metadata strips it", async () => {
    const gpsPointer = 0x8825;
    const exif = tiffWithShorts([[gpsPointer, 1]]);
    const metadata = { exif, xmp: [], user: {} };
    const kept = await loadJpegFile(await saveBytes(flatDocument(gradient(8, 8), { metadata })));
    expect(kept.metadata.exif).toEqual(exif);

    const removed = await loadJpegFile(
      await saveBytes(flatDocument(gradient(8, 8), { metadata }), { removeMetadata: true }),
    );
    expect(removed.metadata.exif).toBeUndefined();
  });

  it("leaves out a metadata item too large for one APP segment", async () => {
    const metadata = { exif: new Uint8Array(70_000), xmp: [], user: {} };
    const loaded = await loadJpegFile(
      await saveBytes(flatDocument(gradient(16, 16), { metadata })),
    );
    expect(loaded.metadata.exif).toBeUndefined();
    expect(loaded.width).toBe(16);
  });

  it("applies the EXIF orientation on load and removes the tag", async () => {
    const metadata = { exif: tiffWithShorts([[EXIF_TAG_ORIENTATION, 6]]), xmp: [], user: {} };
    const loaded = await loadJpegFile(await saveBytes(flatDocument(gradient(4, 2), { metadata })));
    expect([loaded.width, loaded.height]).toEqual([2, 4]);
    expect(exifOrientation(loaded.metadata.exif)).toBeUndefined();
  });
});

describe("loadJpegFile", () => {
  it("reports a file the decoder cannot read as a decode error", async () => {
    await expect(loadJpegFile(jpegWithSegments([]))).rejects.toBeInstanceOf(DecodeError);
    await expect(loadJpegFile(new Uint8Array([0xff, 0xd8, 0x00]))).rejects.toBeInstanceOf(
      DecodeError,
    );
  });

  it("decodes an untagged JPEG in WASM to the same pixels as an independent decoder", async () => {
    const surface = gradient(48, 32);
    const bytes = await saveBytes(flatDocument(surface), {
      quality: 100,
      chromaSubsampling: "444",
    });
    const loaded = await loadJpegFile(bytes);
    const reference = await decodeWithJpegJs(
      new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
    );
    const error = channelError(reference, loaded.layers[0]?.surface as Surface);
    expect(error.mean).toBeLessThan(1);
    expect(error.max).toBeLessThanOrEqual(4);
  });

  it("converts a CMYK JPEG's ink to sRGB with the default profile (FMT-META-03)", async () => {
    const samples = new Uint8Array(2 * 2 * 4);
    const loaded = await loadJpegFile(cmykFrame(), () => ({
      width: 2,
      height: 2,
      channels: 4,
      samples,
    }));
    const pixels = loaded.layers[0]?.surface.data ?? new Uint8ClampedArray();
    expect(Array.from(pixels.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    expect(loaded.warnings).toBeUndefined();
  });

  it("warns and opens the pixels as sRGB when the embedded profile cannot be used", async () => {
    const bytes = jpegWithSegments([iccChunk(new Uint8Array([1, 2, 3, 4])), rgbFrame()]);
    const loaded = await loadJpegFile(bytes, () => ({
      width: 2,
      height: 2,
      channels: 3,
      samples: new Uint8Array(12).fill(90),
    }));
    expect(loaded.warnings).toEqual([PROFILE_IGNORED_WARNING]);
    expect(Array.from(loaded.layers[0]?.surface.data.subarray(0, 4) ?? [])).toEqual([
      90, 90, 90, 255,
    ]);
  });

  it("uses an embedded profile from its APP2 chunks in sequence order", async () => {
    const profile = defaultCmykProfile();
    const half = Math.ceil(profile.length / 2);
    const bytes = jpegWithSegments([
      iccChunk(profile.subarray(half), 2, 2),
      iccChunk(profile.subarray(0, half), 1, 2),
      { marker: 0xc0, body: frameBody(4) },
    ]);
    const decoded = readJpegMetadata(bytes).icc;
    expect(decoded).toEqual(profile);
    const loaded = await loadJpegFile(bytes, () => ({
      width: 2,
      height: 2,
      channels: 4,
      samples: new Uint8Array(16),
    }));
    expect(loaded.warnings).toBeUndefined();
  });
});

/** A 2 x 2 frame with four components (CMYK), and no image data, for the loader's frame check. */
function cmykFrame(): Uint8Array {
  return jpegWithSegments([{ marker: 0xc0, body: frameBody(4) }]);
}

function rgbFrame(): { marker: number; body: Uint8Array } {
  return { marker: 0xc0, body: frameBody(3) };
}

function frameBody(components: number): Uint8Array {
  const body = [8, 0, 2, 0, 2, components];
  for (let component = 1; component <= components; component += 1) body.push(component, 0x11, 0);
  return new Uint8Array(body);
}

/** One APP2 segment of an ICC profile, with its sequence number and chunk count. */
function iccChunk(data: Uint8Array, sequence = 1, count = 1): { marker: number; body: Uint8Array } {
  const header = new TextEncoder().encode("ICC_PROFILE\0");
  const body = new Uint8Array(header.length + 2 + data.length);
  body.set(header, 0);
  body[header.length] = sequence;
  body[header.length + 1] = count;
  body.set(data, header.length + 2);
  return { marker: 0xe2, body };
}

describe("the JPEG file type", () => {
  it("registers the JFIF, JPG, JPEG and JPE extensions, with .jpg saved first", () => {
    const type = jpegFileType();
    expect(type.id).toBe("jpeg");
    expect(type.loadExtensions).toEqual([".jpg", ".jpeg", ".jpe", ".jfif"]);
    expect(type.saveExtensions[0]).toBe(".jpg");
    expect(type.mimeTypes).toEqual(["image/jpeg"]);
    expect(type.isLossless({})).toBe(false);
    expect(type.capabilities.supportsCancellation).toBe(false);
    expect(findOpenFileType(builtinFileTypeRegistry(), ".JFIF")?.id).toBe("jpeg");
  });

  it("defaults to quality 95, 4:2:0 and metadata kept", () => {
    expect(jpegSaveOptions({})).toEqual({
      quality: 95,
      chromaSubsampling: "420",
      removeMetadata: false,
    });
  });

  it("flattens over white and maps pixel density to no density", () => {
    const rgb = flattenOverWhite(new Surface(1, 1, new Uint8ClampedArray([0, 0, 0, 0])));
    expect([...rgb]).toEqual([255, 255, 255]);
    expect(dotsPerInch({ unit: "pixel", x: 1, y: 1 })).toEqual({ x: 0, y: 0 });
  });
});
