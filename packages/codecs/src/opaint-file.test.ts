// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { OutOfMemoryError, Surface } from "@openpaint/document";
import type { FileDocument } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { OPAINT_WARNINGS, OpaintFormatError, readOpaint, writeOpaint } from "./opaint-file";
import { encodePngAsync } from "./png";
import { linearCurve, matrixProfile } from "./test-profiles";
import { writeZip, ZipArchive, type ZipInput } from "./zip";
import { deflateZlib } from "./zlib";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const TEXT = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const BUDGET = 2 ** 40;
const READ = { memoryBudgetBytes: BUDGET };

function gradient(width: number, height: number, seed: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = (x * 37 + seed) % 256;
      data[at + 1] = (y * 53 + seed) % 256;
      data[at + 2] = (x + y + seed) % 256;
      data[at + 3] = (x * 11 + y * 7 + seed) % 256;
    }
  }
  return new Surface(width, height, data);
}

/** A 4x3 document with three layers, transparent pixels that keep their color, and every metadata kind. */
function sampleFile(): FileDocument {
  const transparent = new Surface(4, 3, new Uint8ClampedArray(4 * 3 * 4));
  for (let i = 0; i < transparent.data.length; i += 4) {
    transparent.data[i] = 10;
    transparent.data[i + 1] = 20;
    transparent.data[i + 2] = 30;
  }
  return {
    width: 4,
    height: 3,
    resolution: { x: 300, y: 300, unit: "inch" },
    colorProfile: "srgb",
    metadata: {
      exif: new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0]),
      xmp: ["<x:xmpmeta>first</x:xmpmeta>", "<x:xmpmeta>second</x:xmpmeta>"],
      iptc: new Uint8Array([0x1c, 0x02, 0x05, 0x00, 0x01, 0x41]),
      user: { "plugin.key": "value", "x-note": "kept" },
    },
    layers: [
      {
        name: "Background",
        visible: true,
        opacity: 255,
        blendMode: 0,
        surface: gradient(4, 3, 1),
        isBackground: true,
      },
      {
        name: "Layer 2",
        visible: false,
        opacity: 128,
        blendMode: 1,
        surface: transparent,
        isBackground: false,
        metadata: { note: "shadow" },
        extras: { "x-vendor-tag": { count: 1, list: [true, null] } },
      },
      {
        name: "Top",
        visible: true,
        opacity: 255,
        blendMode: 0,
        rawBlendMode: 99,
        surface: gradient(4, 3, 7),
        isBackground: false,
      },
    ],
    activeLayer: 1,
    selection: { polygons: [[0.5, 0.25, 3.75, 0.25, 3.75, 2.5, 0.5, 2.5]], quality: "aliased" },
    extras: {
      document: { "x-future": { version: 2 } },
      resolution: { "x-dpi-source": "scanner" },
      metadata: { "x-metadata-note": "keep" },
      entries: { "x-plugin/data.bin": new Uint8Array([1, 2, 3, 4]) },
    },
    thumbnail: gradient(2, 2, 3),
  };
}

/** Reads every entry (CRC-checked) and writes the archive again, with the changes applied. */
async function rebuild(
  bytes: Uint8Array,
  change: (entries: Map<string, Uint8Array>) => void,
): Promise<Uint8Array> {
  const archive = ZipArchive.open(bytes);
  const entries = new Map<string, Uint8Array>();
  for (const entry of archive.entries) entries.set(entry.path, await archive.read(entry, BUDGET));
  change(entries);
  const inputs: ZipInput[] = [...entries].map(([path, data]) => ({
    path,
    data,
    deflate: path !== "mimetype" && !path.startsWith("layers/") && path !== "thumbnail.png",
  }));
  return writeZip(inputs);
}

/** Edits the manifest of a written file. */
async function editManifest(
  bytes: Uint8Array,
  edit: (manifest: Record<string, unknown>) => void,
): Promise<Uint8Array> {
  return rebuild(bytes, (entries) => {
    const manifest = JSON.parse(TEXT_DECODER.decode(entries.get("document.json"))) as Record<
      string,
      unknown
    >;
    edit(manifest);
    entries.set("document.json", TEXT.encode(JSON.stringify(manifest)));
  });
}

/** The text of a written document.json, inflated. */
async function readJson(bytes: Uint8Array): Promise<string> {
  const archive = ZipArchive.open(bytes);
  const entry = archive.find("document.json");
  if (entry === undefined) throw new Error("no document.json");
  return TEXT_DECODER.decode(await archive.read(entry, BUDGET));
}

/** The stored bytes of an entry at a known local header offset. */
function rawEntry(bytes: Uint8Array, offset: number, size: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataStart =
    offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
  return bytes.subarray(dataStart, dataStart + size);
}

async function expectCorrupt(bytes: Uint8Array): Promise<void> {
  const failure = await readOpaint(bytes, READ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(OpaintFormatError);
  expect((failure as OpaintFormatError).reason).toBe("corrupt");
}

describe("native .opaint round trip (FMT-NAT-11)", () => {
  it("reproduces the layers, selection, active layer, metadata and unknown keys", async () => {
    const file = sampleFile();
    const back = await readOpaint(await writeOpaint(file), READ);

    expect(back.width).toBe(4);
    expect(back.height).toBe(3);
    expect(back.resolution).toEqual({ x: 300, y: 300, unit: "inch" });
    expect(back.layers.map((layer) => layer.name)).toEqual(["Background", "Layer 2", "Top"]);
    for (const [index, layer] of back.layers.entries()) {
      const original = file.layers[index];
      if (original === undefined) throw new Error("missing layer");
      expect(layer.surface.data).toEqual(original.surface.data);
      expect(layer.visible).toBe(original.visible);
      expect(layer.opacity).toBe(original.opacity);
      expect(layer.blendMode).toBe(original.blendMode);
      expect(layer.isBackground).toBe(original.isBackground ?? false);
      expect(layer.damaged).toBeUndefined();
    }
    expect(back.layers[1]?.metadata).toEqual({ note: "shadow" });
    expect(back.layers[1]?.extras).toEqual({ "x-vendor-tag": { count: 1, list: [true, null] } });
    expect(back.layers[2]?.rawBlendMode).toBe(99);
    expect(back.layers[2]?.blendMode).toBe(0);
    expect(back.activeLayer).toBe(1);
    expect(back.selection).toEqual(file.selection);
    expect(back.metadata.exif).toEqual(file.metadata.exif);
    expect(back.metadata.xmp).toEqual(file.metadata.xmp);
    expect(back.metadata.iptc).toEqual(file.metadata.iptc);
    expect(back.metadata.user).toEqual(file.metadata.user);
    expect(back.extras).toEqual(file.extras);
    expect(back.warnings).toEqual([]);
    expect(back.dirty).toBeFalsy();
  });

  it("keeps the color of fully transparent pixels exactly", async () => {
    const back = await readOpaint(await writeOpaint(sampleFile()), READ);
    expect(back.layers[1]?.surface.data.slice(0, 4)).toEqual(
      new Uint8ClampedArray([10, 20, 30, 0]),
    );
  });

  it("writes the package in the recommended order with the expected entries", async () => {
    const bytes = await writeOpaint(sampleFile());
    const archive = ZipArchive.open(bytes);
    expect(archive.entries.map((entry) => entry.path)).toEqual([
      "mimetype",
      "document.json",
      "thumbnail.png",
      "metadata/exif.bin",
      "metadata/xmp.xml",
      "metadata/xmp-1.xml",
      "metadata/iptc.bin",
      "metadata/custom.json",
      "x-plugin/data.bin",
      "layers/0.png",
      "layers/1.png",
      "layers/2.png",
    ]);
    expect(TEXT_DECODER.decode(rawEntry(bytes, 0, 17).slice(0, 17))).toBe("image/x-openpaint");
  });

  it("writes a manifest with the version fields, layer paths and the unknown keys", async () => {
    const manifest = JSON.parse(await readJson(await writeOpaint(sampleFile()))) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      format: "openpaint",
      formatVersion: 1,
      minReaderVersion: 1,
      width: 4,
      height: 3,
      thumbnail: "thumbnail.png",
      activeLayer: 1,
      "x-future": { version: 2 },
      resolution: { x: 300, y: 300, unit: "inch", "x-dpi-source": "scanner" },
      metadata: { "x-metadata-note": "keep", exif: "metadata/exif.bin" },
    });
    expect(manifest.layers).toMatchObject([
      { name: "Background", isBackground: true, src: "layers/0.png" },
      { name: "Layer 2", visible: false, opacity: 128, blendMode: 1, src: "layers/1.png" },
      { name: "Top", blendMode: 99, src: "layers/2.png" },
    ]);
  });

  it("writes each layer as an 8-bit RGBA PNG without color chunks", async () => {
    const bytes = await writeOpaint(sampleFile());
    const layer = ZipArchive.open(bytes).find("layers/0.png");
    if (layer === undefined) throw new Error("no layer");
    const png = rawEntry(bytes, layer.offset, layer.compressedSize);
    expect(png.subarray(12, 16)).toEqual(TEXT.encode("IHDR"));
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    expect(TEXT_DECODER.decode(png)).not.toContain("gAMA");
  });

  it("fits the thumbnail within 256 pixels", async () => {
    const file = { ...sampleFile(), thumbnail: gradient(512, 128, 9) };
    const bytes = await writeOpaint(file);
    const thumbnail = ZipArchive.open(bytes).find("thumbnail.png");
    if (thumbnail === undefined) throw new Error("no thumbnail");
    const png = rawEntry(bytes, thumbnail.offset, thumbnail.compressedSize);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBe(256);
    expect(view.getUint32(20)).toBe(64);
  });

  it("drops an unknown entry whose path the writer uses itself", async () => {
    const file = sampleFile();
    const colliding: FileDocument = {
      ...file,
      extras: { entries: { "layers/0.png": new Uint8Array([0, 1, 2]) } },
    };
    const back = await readOpaint(await writeOpaint(colliding), READ);
    expect(back.layers[0]?.surface.data).toEqual(file.layers[0]?.surface.data);
    expect(back.extras?.entries).toBeUndefined();
  });

  it("reports progress from 0 to 1", async () => {
    const seen: number[] = [];
    await writeOpaint(sampleFile(), (fraction) => seen.push(fraction));
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("leaves out the thumbnail and metadata when there are none", async () => {
    const plain: FileDocument = {
      width: 1,
      height: 1,
      resolution: { x: 96, y: 96, unit: "inch" },
      colorProfile: "srgb",
      metadata: { xmp: [], user: {} },
      layers: [
        {
          name: "Background",
          visible: true,
          opacity: 255,
          blendMode: 0,
          surface: new Surface(1, 1, new Uint8ClampedArray([1, 2, 3, 4])),
          isBackground: true,
        },
      ],
    };
    const bytes = await writeOpaint(plain);
    const archive = ZipArchive.open(bytes);
    expect(archive.find("thumbnail.png")).toBeUndefined();
    expect(archive.entries.map((entry) => entry.path)).toEqual([
      "mimetype",
      "document.json",
      "layers/0.png",
    ]);
    const back = await readOpaint(bytes, READ);
    expect(back.selection).toBeUndefined();
    expect(back.activeLayer).toBe(0);
    expect(back.layers[0]?.surface.data).toEqual(new Uint8ClampedArray([1, 2, 3, 4]));
  });
});

describe("native .opaint validation (FMT-NAT-09)", () => {
  it("refuses bytes that are not a ZIP archive", async () => {
    await expectCorrupt(TEXT.encode("this is not a package"));
  });

  it("refuses a package with another mimetype as not recognized", async () => {
    const bytes = await rebuild(await writeOpaint(sampleFile()), (entries) => {
      entries.set("mimetype", TEXT.encode("image/openraster"));
    });
    const error = await readOpaint(bytes, READ).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(OpaintFormatError);
    expect((error as OpaintFormatError).reason).toBe("unrecognized");
  });

  it("refuses a package without document.json", async () => {
    await expectCorrupt(
      await rebuild(await writeOpaint(sampleFile()), (entries) => entries.delete("document.json")),
    );
  });

  it("refuses document.json that is not JSON, has a BOM, or has the wrong format", async () => {
    const base = await writeOpaint(sampleFile());
    const text = await readJson(base);
    await expectCorrupt(
      await rebuild(base, (entries) => entries.set("document.json", TEXT.encode("{nope"))),
    );
    await expectCorrupt(
      await rebuild(base, (entries) => entries.set("document.json", TEXT.encode(`\uFEFF${text}`))),
    );
    await expectCorrupt(await editManifest(base, (manifest) => (manifest.format = "other")));
  });

  it("refuses a file that needs a newer reader", async () => {
    const bytes = await editManifest(await writeOpaint(sampleFile()), (manifest) => {
      manifest.minReaderVersion = 2;
      manifest.formatVersion = 2;
    });
    const error = await readOpaint(bytes, READ).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect((error as OpaintFormatError).reason).toBe("newerReader");
  });

  it("opens a file written by a newer writer with a notice and keeps its keys", async () => {
    const bytes = await editManifest(await writeOpaint(sampleFile()), (manifest) => {
      manifest.formatVersion = 2;
    });
    const back = await readOpaint(bytes, READ);
    expect(back.warnings).toEqual([OPAINT_WARNINGS.newerVersion]);
    expect(back.extras?.document).toMatchObject({ "x-future": { version: 2 } });
  });

  it("refuses an out-of-range size, a missing layer list and an unsafe layer path", async () => {
    const base = await writeOpaint(sampleFile());
    await expectCorrupt(await editManifest(base, (manifest) => (manifest.width = 0)));
    await expectCorrupt(await editManifest(base, (manifest) => (manifest.layers = [])));
    await expectCorrupt(
      await editManifest(base, (manifest) => {
        const layers = manifest.layers as Record<string, unknown>[];
        layers[0] = { ...layers[0], src: "../escape.png" };
      }),
    );
  });

  it("opens a file whose mimetype is missing, with a warning", async () => {
    const bytes = await rebuild(await writeOpaint(sampleFile()), (entries) =>
      entries.delete("mimetype"),
    );
    const back = await readOpaint(bytes, READ);
    expect(back.warnings).toContain(OPAINT_WARNINGS.mimetype);
    expect(back.layers).toHaveLength(3);
  });

  it("opens a file whose mimetype is compressed, with a warning", async () => {
    const base = await writeOpaint(sampleFile());
    const archive = ZipArchive.open(base);
    const entries = new Map<string, Uint8Array>();
    for (const entry of archive.entries) entries.set(entry.path, await archive.read(entry, BUDGET));
    const bytes = await writeZip(
      [...entries].map(([path, data]) => ({ path, data, deflate: path === "mimetype" })),
    );
    expect(ZipArchive.open(bytes).entries[0]?.method).toBe(8);
    const back = await readOpaint(bytes, READ);
    expect(back.warnings).toEqual([OPAINT_WARNINGS.mimetype]);
  });

  it("clamps opacity and resolution, and reports the resolution", async () => {
    const bytes = await editManifest(await writeOpaint(sampleFile()), (manifest) => {
      const layers = manifest.layers as Record<string, unknown>[];
      layers[1] = { ...layers[1], opacity: 900 };
      layers[0] = { ...layers[0], opacity: -4 };
      manifest.resolution = { x: 1e9, y: 96, unit: "inch" };
    });
    const back = await readOpaint(bytes, READ);
    expect(back.layers.map((layer) => layer.opacity)).toEqual([0, 255, 255]);
    expect(back.resolution.x).toBe(65_536);
    expect(back.warnings).toEqual([OPAINT_WARNINGS.resolution]);
  });

  it("truncates a long layer name to 256 characters without a warning", async () => {
    const bytes = await editManifest(await writeOpaint(sampleFile()), (manifest) => {
      const layers = manifest.layers as Record<string, unknown>[];
      layers[0] = { ...layers[0], name: "n".repeat(300) };
    });
    const back = await readOpaint(bytes, READ);
    expect(back.layers[0]?.name).toBe("n".repeat(256));
    expect(back.warnings).toEqual([]);
  });

  it("keeps an unknown blend mode for the next save until the user changes it", async () => {
    const bytes = await writeOpaint(sampleFile());
    const back = await readOpaint(bytes, READ);
    expect(back.layers[2]?.blendMode).toBe(0);
    const again = JSON.parse(await readJson(await writeOpaint({ ...back }))) as {
      layers: { blendMode: number }[];
    };
    expect(again.layers[2]?.blendMode).toBe(99);
  });

  it("falls back to the top layer and ignores a malformed selection, with a warning", async () => {
    const bytes = await editManifest(await writeOpaint(sampleFile()), (manifest) => {
      manifest.activeLayer = 42;
      manifest.selection = { polygons: [[1, 2]] };
    });
    const back = await readOpaint(bytes, READ);
    expect(back.activeLayer).toBe(2);
    expect(back.selection).toBeUndefined();
    expect(back.warnings).toEqual([OPAINT_WARNINGS.selection]);
  });

  it("refuses a load whose layers exceed the memory budget before decoding", async () => {
    await expect(
      readOpaint(await writeOpaint(sampleFile()), { memoryBudgetBytes: 16 }),
    ).rejects.toBeInstanceOf(OutOfMemoryError);
  });

  it("refuses a package with more entries than its layers allow", async () => {
    const base = await writeOpaint(sampleFile());
    const bytes = await rebuild(base, (entries) => {
      for (let i = 0; i < 1025; i += 1) entries.set(`x-extra/${i}.bin`, new Uint8Array([i % 256]));
    });
    await expectCorrupt(bytes);
  });
});

describe("damaged layers and entries (FMT-NAT-09)", () => {
  it("loads a layer whose picture is not a PNG transparent and flags it", async () => {
    const bytes = await rebuild(await writeOpaint(sampleFile()), (entries) => {
      entries.set("layers/1.png", TEXT.encode("not a png"));
    });
    const back = await readOpaint(bytes, READ);
    expect(back.layers.map((layer) => layer.damaged ?? false)).toEqual([false, true, false]);
    expect(back.layers[1]?.surface.data.every((byte) => byte === 0)).toBe(true);
    expect(back.layers[1]?.name).toBe("Layer 2");
    expect(back.layers[1]?.visible).toBe(false);
    expect(back.dirty).toBe(true);
  });

  it("flags a layer whose PNG has the wrong size", async () => {
    const small = await encodePngAsync(
      { width: 2, height: 2, data: new Uint8Array(16) },
      deflateZlib,
    );
    const bytes = await rebuild(await writeOpaint(sampleFile()), (entries) => {
      entries.set("layers/0.png", small);
    });
    const back = await readOpaint(bytes, READ);
    expect(back.layers[0]?.damaged).toBe(true);
  });

  it("flags a layer whose stored bytes fail their CRC-32", async () => {
    const bytes = (await writeOpaint(sampleFile())).slice();
    const layer = ZipArchive.open(bytes).find("layers/2.png");
    if (layer === undefined) throw new Error("no layer");
    const dataStart = layer.offset + 30 + "layers/2.png".length;
    bytes[dataStart + 60] = (bytes[dataStart + 60] ?? 0) ^ 0xff;
    const back = await readOpaint(bytes, READ);
    expect(back.layers[2]?.damaged).toBe(true);
    expect(back.layers[0]?.damaged).toBeUndefined();
  });

  it("skips a damaged optional metadata entry with a warning", async () => {
    const bytes = await rebuild(await writeOpaint(sampleFile()), (entries) => {
      entries.set("metadata/custom.json", TEXT.encode("{broken"));
    });
    const back = await readOpaint(bytes, READ);
    expect(back.metadata.user).toEqual({});
    expect(back.warnings).toEqual([OPAINT_WARNINGS.entrySkipped]);
  });
});

describe("embedded color profile (FMT-NAT-07)", () => {
  it("converts the layers, drops the profile and marks the document dirty", async () => {
    const bytes = await editManifest(await writeOpaint(sampleFile()), (manifest) => {
      manifest.colorProfile = { path: "profile.icc", name: "linear" };
    });
    const withProfile = await rebuild(bytes, (entries) => {
      entries.set("profile.icc", matrixProfile(linearCurve()));
    });
    const back = await readOpaint(withProfile, READ);
    expect(back.warnings).toEqual([OPAINT_WARNINGS.profileConverted]);
    expect(back.dirty).toBe(true);
    expect(back.colorProfile).toBe("srgb");
    expect(back.layers[0]?.surface.data).not.toEqual(sampleFile().layers[0]?.surface.data);
  });

  it("treats an unusable profile as sRGB with a warning", async () => {
    const bytes = await editManifest(await writeOpaint(sampleFile()), (manifest) => {
      manifest.colorProfile = { path: "profile.icc" };
    });
    const withProfile = await rebuild(bytes, (entries) => {
      entries.set("profile.icc", TEXT.encode("not an ICC profile"));
    });
    const back = await readOpaint(withProfile, READ);
    expect(back.warnings).toEqual([OPAINT_WARNINGS.profileIgnored]);
    expect(back.dirty).toBeFalsy();
    expect(back.layers[0]?.surface.data).toEqual(sampleFile().layers[0]?.surface.data);
  });
});
