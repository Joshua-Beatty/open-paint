import type { Resolution } from "@openpaint/document";

/** The metadata a JPEG carries (FMT-META-01), and the facts the color conversion needs (FMT-META-03). */
export interface JpegMetadata {
  /** The first EXIF block (APP1), without the `Exif\0\0` prefix. */
  readonly exif?: Uint8Array;
  /** Distinct XMP packets (APP1), in file order. */
  readonly xmp: readonly string[];
  /** The IPTC-IIM records (APP13, 8BIM resource 0x0404). */
  readonly iptc?: Uint8Array;
  /** The JFIF density, when it gives a physical unit. */
  readonly resolution?: Resolution;
  /** The embedded ICC profile, assembled from its APP2 chunks in order. */
  readonly icc?: Uint8Array;
  /** The number of components in the frame: 1 gray, 3 YCbCr or RGB, 4 CMYK or YCCK. */
  readonly components?: number;
}

const TEXT = new TextDecoder("utf-8");
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP13 = 0xed;
const EXIF_HEADER = "Exif\0\0";
const JFIF_HEADER = "JFIF\0";
const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";
const ICC_HEADER = "ICC_PROFILE\0";
const PHOTOSHOP_HEADER = "Photoshop 3.0\0";
const IPTC_RESOURCE_ID = 0x0404;
const JFIF_UNIT_INCH = 1;
const JFIF_UNIT_CENTIMETER = 2;
const SOF_FIRST = 0xc0;
const SOF_LAST = 0xcf;
/** The markers in the SOF range that are not frame headers (DHT, JPG and DAC). */
const NOT_FRAME_MARKERS = [0xc4, 0xc8, 0xcc];
const FRAME_COMPONENTS_AT = 5;

/**
 * Reads the EXIF, XMP and IPTC segments, the JFIF density, the ICC profile and the component count of a
 * JPEG file. The scan stops at the start of the image data. A truncated segment ends the scan, and what
 * was read so far is kept.
 */
export function readJpegMetadata(bytes: Uint8Array): JpegMetadata {
  const xmp: string[] = [];
  const iccChunks: { sequence: number; data: Uint8Array }[] = [];
  let exif: Uint8Array | undefined;
  let iptc: Uint8Array | undefined;
  let resolution: Resolution | undefined;
  let components: number | undefined;
  for (const { marker, body } of segmentsOf(bytes)) {
    if (marker === APP0 && startsWith(body, JFIF_HEADER)) resolution ??= jfifResolution(body);
    if (marker === APP1 && startsWith(body, EXIF_HEADER)) exif ??= body.slice(EXIF_HEADER.length);
    if (marker === APP1 && startsWith(body, XMP_HEADER)) {
      const packet = TEXT.decode(body.subarray(XMP_HEADER.length));
      if (!xmp.includes(packet)) xmp.push(packet);
    }
    if (marker === APP2 && startsWith(body, ICC_HEADER) && body.length > ICC_HEADER.length + 1) {
      iccChunks.push({
        sequence: body[ICC_HEADER.length] ?? 0,
        data: body.subarray(ICC_HEADER.length + 2),
      });
    }
    if (marker === APP13 && startsWith(body, PHOTOSHOP_HEADER)) {
      iptc ??= iptcResource(body.subarray(PHOTOSHOP_HEADER.length));
    }
    if (isFrameMarker(marker) && components === undefined) {
      components = body[FRAME_COMPONENTS_AT];
    }
  }
  const icc = assembleIcc(iccChunks);
  return {
    ...(exif === undefined ? {} : { exif }),
    xmp,
    ...(iptc === undefined ? {} : { iptc }),
    ...(resolution === undefined ? {} : { resolution }),
    ...(icc === undefined ? {} : { icc }),
    ...(components === undefined ? {} : { components }),
  };
}

function isFrameMarker(marker: number): boolean {
  return marker >= SOF_FIRST && marker <= SOF_LAST && !NOT_FRAME_MARKERS.includes(marker);
}

/** The profile bytes of the APP2 chunks, in their sequence order, or undefined when there are none. */
function assembleIcc(
  chunks: readonly { sequence: number; data: Uint8Array }[],
): Uint8Array | undefined {
  if (chunks.length === 0) return undefined;
  const ordered = [...chunks].sort((a, b) => a.sequence - b.sequence);
  const total = ordered.reduce((sum, chunk) => sum + chunk.data.length, 0);
  const icc = new Uint8Array(total);
  let at = 0;
  for (const chunk of ordered) {
    icc.set(chunk.data, at);
    at += chunk.data.length;
  }
  return icc;
}

/** The application segments before the image data, as marker and body. */
function* segmentsOf(bytes: Uint8Array): Generator<{ marker: number; body: Uint8Array }> {
  if (bytes[0] !== 0xff || bytes[1] !== SOI) return;
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1] ?? 0;
    if (marker === SOS || marker === EOI) return;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) return;
    yield { marker, body: bytes.subarray(offset + 4, end) };
    offset = end;
  }
}

function startsWith(body: Uint8Array, header: string): boolean {
  for (let index = 0; index < header.length; index += 1) {
    if (body[index] !== header.charCodeAt(index)) return false;
  }
  return true;
}

/** The JFIF density, or undefined when it gives only an aspect ratio. */
function jfifResolution(body: Uint8Array): Resolution | undefined {
  const units = body[JFIF_HEADER.length + 2];
  const x = ((body[JFIF_HEADER.length + 3] ?? 0) << 8) | (body[JFIF_HEADER.length + 4] ?? 0);
  const y = ((body[JFIF_HEADER.length + 5] ?? 0) << 8) | (body[JFIF_HEADER.length + 6] ?? 0);
  if (x === 0 || y === 0) return undefined;
  if (units === JFIF_UNIT_INCH) return { unit: "inch", x, y };
  if (units === JFIF_UNIT_CENTIMETER) return { unit: "centimeter", x, y };
  return undefined;
}

/** The data of the IPTC 8BIM resource in a Photoshop block, or undefined when there is none. */
function iptcResource(blocks: Uint8Array): Uint8Array | undefined {
  let offset = 0;
  while (offset + 12 <= blocks.length && startsWith(blocks.subarray(offset), "8BIM")) {
    const id = ((blocks[offset + 4] ?? 0) << 8) | (blocks[offset + 5] ?? 0);
    const nameLength = blocks[offset + 6] ?? 0;
    const nameField = nameLength + 1 + ((nameLength + 1) % 2);
    const sizeAt = offset + 6 + nameField;
    if (sizeAt + 4 > blocks.length) return undefined;
    const size = new DataView(blocks.buffer, blocks.byteOffset + sizeAt, 4).getUint32(0);
    const start = sizeAt + 4;
    if (start + size > blocks.length) return undefined;
    if (id === IPTC_RESOURCE_ID) return blocks.slice(start, start + size);
    offset = start + size + (size % 2);
  }
  return undefined;
}
