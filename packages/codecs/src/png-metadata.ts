import { inflateZlib } from "./zlib";

/** The metadata a PNG carries: one EXIF block (eXIf), the XMP packets (iTXt) and an ICC profile (iCCP). */
export interface PngMetadata {
  readonly exif?: Uint8Array;
  readonly xmp: readonly string[];
  readonly icc?: Uint8Array;
}

const SIGNATURE_LENGTH = 8;
const XMP_KEYWORD = "XML:com.adobe.xmp";
const TEXT = new TextDecoder("utf-8");

/**
 * Reads the EXIF and XMP chunks of a PNG file (FMT-META-01). The pixels are not decoded here. A
 * truncated chunk ends the scan, and the metadata read so far is kept.
 */
export async function readPngMetadata(bytes: Uint8Array): Promise<PngMetadata> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const xmp: string[] = [];
  let exif: Uint8Array | undefined;
  let icc: Uint8Array | undefined;
  let offset = SIGNATURE_LENGTH;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const kind = TEXT.decode(bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length || kind === "IEND") break;
    const body = bytes.subarray(start, end);
    if (kind === "eXIf") exif = body.slice();
    if (kind === "iCCP") icc = await iccProfile(body);
    if (kind === "iTXt") {
      const packet = await xmpPacket(body);
      if (packet !== undefined) xmp.push(packet);
    }
    offset = end + 4;
  }
  return {
    xmp,
    ...(exif === undefined ? {} : { exif }),
    ...(icc === undefined ? {} : { icc }),
  };
}

/**
 * The profile of an iCCP chunk: a keyword, a compression method byte (0 is zlib), then the zlib stream.
 * A stream that does not inflate is passed on as it is. The color engine then refuses it, so the
 * profile is ignored with a warning (FMT-META-03).
 */
async function iccProfile(body: Uint8Array): Promise<Uint8Array | undefined> {
  const keywordEnd = body.indexOf(0);
  if (keywordEnd < 0 || body[keywordEnd + 1] !== 0) return undefined;
  const compressed = body.subarray(keywordEnd + 2);
  try {
    return await inflateZlib(compressed);
  } catch {
    return compressed.slice();
  }
}

/** The text of an iTXt chunk that holds an XMP packet, or undefined for any other keyword. */
async function xmpPacket(body: Uint8Array): Promise<string | undefined> {
  const keywordEnd = body.indexOf(0);
  if (keywordEnd < 0 || TEXT.decode(body.subarray(0, keywordEnd)) !== XMP_KEYWORD) return undefined;
  const compressed = body[keywordEnd + 1] === 1;
  const languageEnd = body.indexOf(0, keywordEnd + 3);
  if (languageEnd < 0) return undefined;
  const translatedEnd = body.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) return undefined;
  const text = body.subarray(translatedEnd + 1);
  return TEXT.decode(compressed ? await inflateZlib(text) : text);
}
