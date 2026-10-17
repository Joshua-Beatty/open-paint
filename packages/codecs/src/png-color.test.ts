// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import type { FileCodec, FileDocument } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { PROFILE_IGNORED_WARNING } from "./icc-transform";
import { crc32 } from "./png";
import { pngFileType } from "./png-file-type";
import { srgbIccProfile } from "./srgb-profile";
import { linearCurve, matrixProfile } from "./test-profiles";
import { deflateZlib } from "./zlib";

const TEXT = new TextEncoder();

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

async function codecOf(): Promise<FileCodec> {
  return pngFileType().loadCodec();
}

async function encodeToBytes(surface: Surface): Promise<Uint8Array> {
  const document: FileDocument = {
    width: surface.width,
    height: surface.height,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: { xmp: [], user: {} },
    layers: [{ name: "Background", visible: true, opacity: 255, blendMode: 0, surface }],
  };
  const chunks: Uint8Array[] = [];
  await (await codecOf()).save(
    document,
    {
      write: async (chunk) => {
        chunks.push(new Uint8Array(chunk));
      },
    },
    {},
    () => undefined,
  );
  return concat(chunks);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(kind: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(TEXT.encode(kind), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** The PNG with an iCCP chunk holding `profile` in place of its own, compressed as the spec asks. */
async function withProfile(png: Uint8Array, profile: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const compressed = await deflateZlib(profile);
  const body = new Uint8Array(5 + compressed.length);
  body.set(TEXT.encode("ICC"));
  body.set(compressed, 5);
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const kind = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (kind !== "iCCP") parts.push(png.subarray(offset, end));
    if (kind === "IHDR") parts.push(chunk("iCCP", body));
    offset = end;
  }
  return concat(parts);
}

function sourceOf(bytes: Uint8Array) {
  return { byteLength: bytes.length, readAll: async () => bytes };
}

describe("PNG color management on open (FMT-META-03, WEB-COL-01)", () => {
  it("converts pixels with an embedded RGB profile to sRGB through the color engine", async () => {
    const surface = new Surface(1, 1, new Uint8ClampedArray([128, 128, 128, 255]));
    const bytes = await withProfile(await encodeToBytes(surface), matrixProfile(linearCurve()));
    const document = await (await codecOf()).load(sourceOf(bytes));
    expect(Array.from(document.layers[0]?.surface.data ?? [])).toEqual([188, 188, 188, 255]);
    expect(document.warnings).toBeUndefined();
  });

  it("keeps alpha while converting", async () => {
    const surface = new Surface(2, 1, new Uint8ClampedArray([128, 128, 128, 200, 0, 0, 0, 0]));
    const bytes = await withProfile(await encodeToBytes(surface), matrixProfile(linearCurve()));
    const document = await (await codecOf()).load(sourceOf(bytes));
    expect(Array.from(document.layers[0]?.surface.data ?? [])).toEqual([
      188, 188, 188, 200, 0, 0, 0, 0,
    ]);
  });

  it("keeps the pixels of an sRGB profile", async () => {
    const surface = new Surface(1, 1, new Uint8ClampedArray([10, 20, 30, 255]));
    const bytes = await withProfile(await encodeToBytes(surface), srgbIccProfile());
    const document = await (await codecOf()).load(sourceOf(bytes));
    expect(Array.from(document.layers[0]?.surface.data ?? [])).toEqual([10, 20, 30, 255]);
    expect(document.warnings).toBeUndefined();
  });

  it("ignores a profile it cannot use, warns, and keeps the pixels", async () => {
    const surface = new Surface(1, 1, new Uint8ClampedArray([128, 128, 128, 255]));
    const bytes = await withProfile(await encodeToBytes(surface), new Uint8Array([1, 2, 3]));
    const document = await (await codecOf()).load(sourceOf(bytes));
    expect(Array.from(document.layers[0]?.surface.data ?? [])).toEqual([128, 128, 128, 255]);
    expect(document.warnings).toEqual([PROFILE_IGNORED_WARNING]);
  });
});
