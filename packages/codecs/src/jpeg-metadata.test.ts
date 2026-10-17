import { describe, expect, it } from "vitest";
import { readJpegMetadata } from "./jpeg-metadata";
import { jfifBody, jpegWithSegments } from "./test-fixtures";

const TEXT = new TextEncoder();
const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";

function segment(marker: number, text: string): { marker: number; body: Uint8Array } {
  return { marker, body: TEXT.encode(text) };
}

/** A Photoshop APP13 body with the given 8BIM resources, as [id, data] pairs. */
function photoshop(resources: readonly [id: number, data: number[]][]): Uint8Array {
  const parts: number[] = [...TEXT.encode("Photoshop 3.0\0")];
  for (const [id, data] of resources) {
    parts.push(...TEXT.encode("8BIM"), id >> 8, id & 0xff, 0, 0);
    parts.push(0, 0, 0, data.length, ...data);
    if (data.length % 2 === 1) parts.push(0);
  }
  return new Uint8Array(parts);
}

describe("readJpegMetadata", () => {
  it("reads the EXIF block without its prefix", () => {
    const exif = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08]);
    const body = new Uint8Array([...TEXT.encode("Exif\0\0"), ...exif]);
    const metadata = readJpegMetadata(jpegWithSegments([{ marker: 0xe1, body }]));
    expect(metadata.exif).toEqual(exif);
    expect(metadata.xmp).toEqual([]);
  });

  it("keeps each distinct XMP packet once, in file order", () => {
    const metadata = readJpegMetadata(
      jpegWithSegments([
        { marker: 0xe1, body: TEXT.encode(`${XMP_HEADER}<a/>`) },
        { marker: 0xe1, body: TEXT.encode(`${XMP_HEADER}<a/>`) },
        { marker: 0xe1, body: TEXT.encode(`${XMP_HEADER}<b/>`) },
      ]),
    );
    expect(metadata.xmp).toEqual(["<a/>", "<b/>"]);
  });

  it("reads the IPTC resource and skips the other 8BIM resources", () => {
    const body = photoshop([
      [0x040c, [9, 9]],
      [0x0404, [1, 2, 3]],
    ]);
    const metadata = readJpegMetadata(jpegWithSegments([{ marker: 0xed, body }]));
    expect(metadata.iptc).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reads a physical JFIF density and ignores an aspect ratio", () => {
    const inches = readJpegMetadata(
      jpegWithSegments([{ marker: 0xe0, body: jfifBody(1, 300, 150) }]),
    );
    expect(inches.resolution).toEqual({ unit: "inch", x: 300, y: 150 });
    const centimeters = readJpegMetadata(
      jpegWithSegments([{ marker: 0xe0, body: jfifBody(2, 118, 118) }]),
    );
    expect(centimeters.resolution).toEqual({ unit: "centimeter", x: 118, y: 118 });
    const ratio = readJpegMetadata(jpegWithSegments([{ marker: 0xe0, body: jfifBody(0, 1, 1) }]));
    expect(ratio.resolution).toBeUndefined();
  });

  it("returns nothing for a file that is not a JPEG", () => {
    expect(readJpegMetadata(TEXT.encode("not a jpeg"))).toEqual({ xmp: [] });
  });

  it("keeps what it read before a truncated segment", () => {
    const exifBody = new Uint8Array([...TEXT.encode("Exif\0\0"), 1, 2]);
    const full = jpegWithSegments([
      { marker: 0xe1, body: exifBody },
      segment(0xe1, `${XMP_HEADER}<a/>`),
    ]);
    const metadata = readJpegMetadata(full.subarray(0, full.length - 12));
    expect(metadata.exif).toEqual(new Uint8Array([1, 2]));
    expect(metadata.xmp).toEqual([]);
    expect(() => readJpegMetadata(full.subarray(0, 9))).not.toThrow();
  });
});
