import { Surface } from "@openpaint/document";
import jpeg from "jpeg-js";

/** A little-endian TIFF block whose IFD0 holds one SHORT entry per (tag, value) pair. */
export function tiffWithShorts(entries: readonly [tag: number, value: number][]): Uint8Array {
  const ifdLength = 2 + entries.length * 12 + 4;
  const bytes = new Uint8Array(new ArrayBuffer(8 + ifdLength));
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49, 0x2a, 0x00], 0);
  view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag, value], index) => {
    const at = 10 + index * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, 3, true);
    view.setUint32(at + 4, 1, true);
    view.setUint16(at + 8, value, true);
  });
  view.setUint32(8 + 2 + entries.length * 12, 0, true);
  return bytes;
}

/** The IFD0 pointer to the GPS sub-IFD (FMT-META-05), and GPSLatitudeRef in that sub-IFD. */
export const GPS_POINTER_TAG = 0x8825;
export const GPS_LATITUDE_REF_TAG = 0x0001;

/** A little-endian TIFF block whose IFD0 points to a GPS sub-IFD that holds GPSLatitudeRef "N". */
export function gpsTiffBlock(): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49, 0x2a, 0x00], 0);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, GPS_POINTER_TAG, true);
  view.setUint16(12, 4, true);
  view.setUint32(14, 1, true);
  view.setUint32(18, 26, true);
  view.setUint32(22, 0, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, GPS_LATITUDE_REF_TAG, true);
  view.setUint16(30, 2, true);
  view.setUint32(32, 2, true);
  bytes.set([0x4e, 0x00], 36);
  view.setUint32(40, 0, true);
  return bytes;
}

/**
 * The ASCII value of `tag` in the sub-IFD that IFD0 points to with `pointer`, without its NUL. Undefined
 * when the block, the pointer or the tag is absent. Values are read as the block holds them (little-endian).
 */
export function subIfdAscii(
  exif: Uint8Array | undefined,
  pointer: number,
  tag: number,
): string | undefined {
  if (exif === undefined) return undefined;
  const view = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const ifd0 = view.getUint32(4, true);
  const count = view.getUint16(ifd0, true);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd0 + 2 + index * 12;
    if (view.getUint16(entry, true) !== pointer) continue;
    const sub = view.getUint32(entry + 8, true);
    const subCount = view.getUint16(sub, true);
    for (let subIndex = 0; subIndex < subCount; subIndex += 1) {
      const at = sub + 2 + subIndex * 12;
      if (view.getUint16(at, true) !== tag) continue;
      const length = view.getUint32(at + 4, true);
      const start = length <= 4 ? at + 8 : view.getUint32(at + 8, true);
      return String.fromCharCode(...exif.subarray(start, start + length - 1));
    }
  }
  return undefined;
}

/** A JPEG made of the given APP segments (marker and body), an empty scan and the end marker. */
export function jpegWithSegments(
  segments: readonly { marker: number; body: Uint8Array }[],
): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  for (const { marker, body } of segments) {
    const length = body.length + 2;
    parts.push(0xff, marker, length >> 8, length & 0xff, ...body);
  }
  parts.push(0xff, 0xda, 0x00, 0x02, 0xff, 0xd9);
  return new Uint8Array(parts);
}

/** The JFIF APP0 body with the given units and density. */
export function jfifBody(units: number, x: number, y: number): Uint8Array {
  return new Uint8Array([
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    1,
    1,
    units,
    x >> 8,
    x & 0xff,
    y >> 8,
    y & 0xff,
    0,
    0,
  ]);
}

/** Decodes a JPEG with `jpeg-js`, an independent decoder, into an RGBA surface. */
export async function decodeWithJpegJs(blob: Blob): Promise<Surface> {
  const decoded = jpeg.decode(new Uint8Array(await blob.arrayBuffer()), {
    useTArray: true,
    formatAsRGBA: true,
  });
  return new Surface(decoded.width, decoded.height, new Uint8ClampedArray(decoded.data));
}
