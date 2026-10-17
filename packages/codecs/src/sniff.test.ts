import { sniffFileType } from "@openpaint/extension-api";
import { describe, expect, it } from "vitest";
import { builtinFileTypeRegistry } from "./file-types";

const TEXT = new TextEncoder();

function withBytes(length: number, head: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(head, 0);
  return bytes;
}

/** The first bytes of each built-in format, enough for its signature check. */
function signatures(): Record<string, Uint8Array> {
  const bmp = withBytes(54, [0x42, 0x4d]);
  new DataView(bmp.buffer).setUint32(14, 40, true);
  const opaint = withBytes(64, [0x50, 0x4b, 0x03, 0x04]);
  opaint.set(TEXT.encode("mimetype"), 30);
  opaint.set(TEXT.encode("image/x-openpaint"), 38);
  return {
    png: withBytes(16, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    jpeg: withBytes(16, [0xff, 0xd8, 0xff, 0xe0]),
    jxl: withBytes(16, [0xff, 0x0a]),
    jxlContainer: withBytes(16, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
    avif: withBytes(16, [0, 0, 0, 0x1c, ...TEXT.encode("ftypavif")]),
    avis: withBytes(16, [0, 0, 0, 0x1c, ...TEXT.encode("ftypavis")]),
    webp: withBytes(16, [...TEXT.encode("RIFF"), 0, 0, 0, 0, ...TEXT.encode("WEBP")]),
    dds: withBytes(128, [...TEXT.encode("DDS ")]),
    tiff: withBytes(16, [0x49, 0x49, 0x2a, 0x00]),
    tiffBig: withBytes(16, [0x4d, 0x4d, 0x00, 0x2a]),
    gif: withBytes(16, [...TEXT.encode("GIF89a")]),
    bmp,
    opaint,
  };
}

/** The type each signature belongs to. */
const EXPECTED: Record<string, string> = {
  png: "png",
  jpeg: "jpeg",
  jxl: "jxl",
  jxlContainer: "jxl",
  avif: "avif",
  avis: "avif",
  webp: "webp",
  dds: "dds",
  tiff: "tiff",
  tiffBig: "tiff",
  gif: "gif",
  bmp: "bmp",
  opaint: "opaint",
};

describe("content sniffing (FMT-OPEN-02)", () => {
  const types = builtinFileTypeRegistry().list();

  it("recognizes every built-in signature as its own file type", () => {
    const samples = signatures();
    for (const [sample, typeId] of Object.entries(EXPECTED)) {
      const bytes = samples[sample];
      if (bytes === undefined) throw new Error(`no sample for ${sample}`);
      expect(sniffFileType(types, bytes)?.id, sample).toBe(typeId);
    }
  });

  it("gives every type with a signature a sniff check, and TGA none", () => {
    for (const type of types) {
      if (type.id === "tga") expect(type.sniff).toBeUndefined();
      else expect(type.sniff, type.id).toBeTypeOf("function");
    }
  });

  it("does not recognize text, empty input or a truncated signature", () => {
    expect(sniffFileType(types, TEXT.encode("not an image at all"))).toBeUndefined();
    expect(sniffFileType(types, new Uint8Array(0))).toBeUndefined();
    expect(sniffFileType(types, new Uint8Array([0x89, 0x50, 0x4e]))).toBeUndefined();
  });

  it("needs a plausible DIB header size before it calls a file a bitmap", () => {
    const bmp = signatures().bmp;
    if (bmp === undefined) throw new Error("no bmp sample");
    new DataView(bmp.buffer).setUint32(14, 99, true);
    expect(sniffFileType(types, bmp)).toBeUndefined();
    expect(sniffFileType(types, bmp.subarray(0, 10))).toBeUndefined();
  });

  it("does not take a ZIP without the OpenPaint mimetype for a native file", () => {
    const zip = withBytes(64, [0x50, 0x4b, 0x03, 0x04]);
    zip.set(TEXT.encode("mimetype"), 30);
    zip.set(TEXT.encode("application/epub+zip"), 38);
    expect(sniffFileType(types, zip)).toBeUndefined();
  });
});
