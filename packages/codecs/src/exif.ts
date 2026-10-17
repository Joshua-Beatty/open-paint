/** The EXIF Orientation tag (FMT-META-02). It lives in IFD0 of a TIFF-structured block. */
export const EXIF_TAG_ORIENTATION = 0x0112;

const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const HEADER_LENGTH = 8;
const ENTRY_LENGTH = 12;
const NEXT_IFD_LENGTH = 4;

interface Ifd0 {
  readonly view: DataView;
  readonly littleEndian: boolean;
  /** Offset of the entry count within the block. */
  readonly at: number;
  readonly count: number;
}

/** The byte order and IFD0 of a TIFF-structured block, or undefined when it is malformed. */
function ifd0Of(exif: Uint8Array): Ifd0 | undefined {
  if (exif.length < HEADER_LENGTH) return undefined;
  const view = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const order = String.fromCharCode(exif[0] ?? 0, exif[1] ?? 0);
  if (order !== "II" && order !== "MM") return undefined;
  const littleEndian = order === "II";
  if (view.getUint16(2, littleEndian) !== 42) return undefined;
  const at = view.getUint32(4, littleEndian);
  if (at + 2 > exif.length) return undefined;
  const count = view.getUint16(at, littleEndian);
  if (at + 2 + count * ENTRY_LENGTH + NEXT_IFD_LENGTH > exif.length) return undefined;
  return { view, littleEndian, at, count };
}

/** The offset of the IFD0 entry for `tag`, or -1 when it is absent. */
function entryOffset(ifd: Ifd0, tag: number): number {
  for (let index = 0; index < ifd.count; index += 1) {
    const offset = ifd.at + 2 + index * ENTRY_LENGTH;
    if (ifd.view.getUint16(offset, ifd.littleEndian) === tag) return offset;
  }
  return -1;
}

/** The Artist tag (IFD0), written to the TGA author field. */
export const EXIF_TAG_ARTIST = 0x013b;
/** The ImageDescription tag (IFD0), written to the TGA comment field. */
export const EXIF_TAG_IMAGE_DESCRIPTION = 0x010e;

/**
 * The bytes of an IFD0 ASCII entry, up to its terminating NUL. Empty when the tag is absent or is not
 * ASCII. Values of four bytes or fewer sit inside the entry, and longer ones are at an offset.
 */
export function exifAsciiBytes(exif: Uint8Array | undefined, tag: number): Uint8Array {
  if (exif === undefined) return new Uint8Array(0);
  const ifd = ifd0Of(exif);
  if (ifd === undefined) return new Uint8Array(0);
  const offset = entryOffset(ifd, tag);
  if (offset < 0 || ifd.view.getUint16(offset + 2, ifd.littleEndian) !== TYPE_ASCII) {
    return new Uint8Array(0);
  }
  const count = ifd.view.getUint32(offset + 4, ifd.littleEndian);
  const at = count <= 4 ? offset + 8 : ifd.view.getUint32(offset + 8, ifd.littleEndian);
  if (at + count > exif.length) return new Uint8Array(0);
  const text = exif.subarray(at, at + count);
  const end = text.indexOf(0);
  return end < 0 ? text : text.subarray(0, end);
}

/**
 * A little-endian EXIF block whose IFD0 holds the given ASCII tags, sorted by tag. Empty texts are
 * left out, and the result is undefined when none is left. The TGA reader uses it to put the author
 * and comment fields back into the document's metadata.
 */
export function exifFromAsciiTags(
  entries: readonly { readonly tag: number; readonly text: Uint8Array }[],
): Uint8Array | undefined {
  const present = entries.filter((entry) => entry.text.length > 0).sort((a, b) => a.tag - b.tag);
  if (present.length === 0) return undefined;
  const ifdEnd = HEADER_LENGTH + 2 + present.length * ENTRY_LENGTH + NEXT_IFD_LENGTH;
  const spill = present.reduce(
    (sum, entry) => sum + (entry.text.length + 1 > 4 ? entry.text.length + 2 : 0),
    0,
  );
  const out = new Uint8Array(new ArrayBuffer(ifdEnd + spill));
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0], 0);
  view.setUint32(4, HEADER_LENGTH, true);
  view.setUint16(HEADER_LENGTH, present.length, true);
  let spillAt = ifdEnd;
  for (const [index, entry] of present.entries()) {
    const at = HEADER_LENGTH + 2 + index * ENTRY_LENGTH;
    const count = entry.text.length + 1;
    view.setUint16(at, entry.tag, true);
    view.setUint16(at + 2, TYPE_ASCII, true);
    view.setUint32(at + 4, count, true);
    if (count <= 4) {
      out.set(entry.text, at + 8);
    } else {
      view.setUint32(at + 8, spillAt, true);
      out.set(entry.text, spillAt);
      spillAt += count + (count & 1);
    }
  }
  return out;
}

/** The Orientation tag value (1 to 8), or undefined when the tag is absent or not a SHORT. */
export function exifOrientation(exif: Uint8Array | undefined): number | undefined {
  if (exif === undefined) return undefined;
  const ifd = ifd0Of(exif);
  if (ifd === undefined) return undefined;
  const offset = entryOffset(ifd, EXIF_TAG_ORIENTATION);
  if (offset < 0 || ifd.view.getUint16(offset + 2, ifd.littleEndian) !== TYPE_SHORT) {
    return undefined;
  }
  return ifd.view.getUint16(offset + 8, ifd.littleEndian);
}

/**
 * A copy of the block without the IFD0 entry for `tag`. The later entries move up over the removed
 * one. The data they point to stays where it is, since entries address it by offset.
 */
export function removeExifTag(exif: Uint8Array, tag: number): Uint8Array {
  const ifd = ifd0Of(exif);
  if (ifd === undefined) return exif;
  const offset = entryOffset(ifd, tag);
  if (offset < 0) return exif;
  const entriesEnd = ifd.at + 2 + ifd.count * ENTRY_LENGTH;
  const out = exif.slice();
  out.copyWithin(offset, offset + ENTRY_LENGTH, entriesEnd + NEXT_IFD_LENGTH);
  new DataView(out.buffer).setUint16(ifd.at, ifd.count - 1, ifd.littleEndian);
  return out;
}
