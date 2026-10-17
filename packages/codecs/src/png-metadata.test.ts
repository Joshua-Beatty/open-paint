// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { readPngMetadata } from "./png-metadata";
import { srgbIccProfile } from "./srgb-profile";
import { deflateZlib } from "./zlib";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const TEXT = new TextEncoder();
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG-shaped byte string with the given chunks. The CRCs are zero, which the reader does not check. */
function fakePng(chunks: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from(SIGNATURE)];
  for (const [kind, body] of chunks) {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, body.length);
    head.set(TEXT.encode(kind), 4);
    parts.push(head, body, new Uint8Array(4));
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The body of an iTXt chunk: keyword, compression flag and method, empty language and translation. */
function itxt(keyword: string, compressed: boolean, text: Uint8Array): Uint8Array {
  const head = [...TEXT.encode(keyword), 0, compressed ? 1 : 0, 0, 0, 0];
  return Uint8Array.from([...head, ...text]);
}

describe("readPngMetadata (FMT-META-01)", () => {
  it("reads the EXIF block and the uncompressed XMP packet", async () => {
    const exif = Uint8Array.from([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0]);
    const bytes = fakePng([
      ["IHDR", new Uint8Array(13)],
      ["eXIf", exif],
      ["iTXt", itxt("XML:com.adobe.xmp", false, TEXT.encode("<x:xmpmeta/>"))],
      ["IDAT", new Uint8Array(0)],
      ["IEND", new Uint8Array(0)],
    ]);
    expect(await readPngMetadata(bytes)).toEqual({ exif, xmp: ["<x:xmpmeta/>"] });
  });

  it("inflates a compressed XMP packet and ignores other iTXt keywords", async () => {
    const compressed = await deflateZlib(TEXT.encode("<x:xmpmeta>packed</x:xmpmeta>"));
    const bytes = fakePng([
      ["iTXt", itxt("Comment", false, TEXT.encode("not xmp"))],
      ["iTXt", itxt("XML:com.adobe.xmp", true, compressed)],
      ["IEND", new Uint8Array(0)],
    ]);
    const metadata = await readPngMetadata(bytes);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toEqual(["<x:xmpmeta>packed</x:xmpmeta>"]);
  });

  it("keeps what it read before a truncated chunk", async () => {
    const bytes = fakePng([["eXIf", Uint8Array.of(1, 2, 3)]]);
    const truncated = bytes.subarray(0, bytes.length - 2);
    expect((await readPngMetadata(truncated)).exif).toBeUndefined();
    expect((await readPngMetadata(bytes)).exif).toEqual(Uint8Array.of(1, 2, 3));
  });
});

describe("srgbIccProfile (FMT-META-05)", () => {
  it("writes a v4.2 RGB profile whose header size matches its length", () => {
    const profile = srgbIccProfile();
    const view = new DataView(profile.buffer);
    expect(view.getUint32(0)).toBe(profile.length);
    expect(view.getUint32(8)).toBe(0x04200000);
    expect(String.fromCharCode(...profile.subarray(12, 16))).toBe("mntr");
    expect(String.fromCharCode(...profile.subarray(16, 20))).toBe("RGB ");
    expect(String.fromCharCode(...profile.subarray(36, 40))).toBe("acsp");
  });

  it("lists every tag inside the profile, with the sRGB red colorant", () => {
    const profile = srgbIccProfile();
    const view = new DataView(profile.buffer);
    const count = view.getUint32(128);
    const tags = new Map<string, { offset: number; size: number }>();
    for (let i = 0; i < count; i++) {
      const at = 132 + i * 12;
      const signature = String.fromCharCode(...profile.subarray(at, at + 4));
      tags.set(signature, { offset: view.getUint32(at + 4), size: view.getUint32(at + 8) });
    }
    for (const signature of ["desc", "wtpt", "rXYZ", "gXYZ", "bXYZ", "rTRC", "gTRC", "bTRC"]) {
      const tag = tags.get(signature);
      expect(tag, signature).toBeDefined();
      expect((tag?.offset ?? 0) + (tag?.size ?? 0)).toBeLessThanOrEqual(profile.length);
    }
    const red = tags.get("rXYZ");
    expect(view.getInt32((red?.offset ?? 0) + 8)).toBe(Math.round(0.4360747 * 65536));
  });
});
