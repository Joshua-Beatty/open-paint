/**
 * Signatures of the built-in file types, for content sniffing (FMT-OPEN-02). Each check reads only
 * the bytes its signature needs and never throws. TGA has no signature, so it is not sniffed.
 */

function startsWith(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((value, index) => bytes[offset + index] === value);
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

const BMP_HEADER_SIZES: readonly number[] = [12, 40, 52, 56, 64, 108, 124];

export function isPngBytes(bytes: Uint8Array): boolean {
  return startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

export function isJpegBytes(bytes: Uint8Array): boolean {
  return startsWith(bytes, 0, [0xff, 0xd8, 0xff]);
}

export function isJxlBytes(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, 0, [0xff, 0x0a]) ||
    startsWith(bytes, 0, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])
  );
}

export function isAvifBytes(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, 4, ascii("ftyp")) &&
    (startsWith(bytes, 8, ascii("avif")) || startsWith(bytes, 8, ascii("avis")))
  );
}

export function isWebpBytes(bytes: Uint8Array): boolean {
  return startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP"));
}

export function isDdsBytes(bytes: Uint8Array): boolean {
  return startsWith(bytes, 0, ascii("DDS "));
}

export function isTiffBytes(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])
  );
}

export function isGifBytes(bytes: Uint8Array): boolean {
  return startsWith(bytes, 0, ascii("GIF87a")) || startsWith(bytes, 0, ascii("GIF89a"));
}

/** "BM" plus a known DIB header size at offset 14, since two letters alone are too weak. */
export function isBmpBytes(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, 0, ascii("BM")) || bytes.length < 18) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return BMP_HEADER_SIZES.includes(view.getUint32(14, true));
}

/** A ZIP whose first entry is `mimetype` holding the OpenPaint MIME type (FMT-NAT-02). */
export function isOpaintBytes(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) &&
    startsWith(bytes, 30, ascii("mimetype")) &&
    startsWith(bytes, 38, ascii("image/x-openpaint"))
  );
}
