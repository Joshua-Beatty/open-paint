import { lz4_compress, lz4_decompress } from "@openpaint/cpu";

/** ARC-05-01 / DOC-HIS-02: spilled data is split into 64 KiB chunks, each compressed on its own. */
export const SPILL_CHUNK_BYTES = 64 * 1024;

/** `lz4` is the default; `none` stores chunks raw (DOC-HIS-02 allows "no compression"). */
export type SpillCodec = "lz4" | "none";

const FORMAT_VERSION = 1;
const HEADER_BYTES = 9;
const CHUNK_HEADER_BYTES = 5;
const METHOD_STORED = 0;
const METHOD_LZ4 = 1;

interface EncodedChunk {
  readonly method: number;
  readonly bytes: Uint8Array;
}

/**
 * Encodes `raw` as a self-describing blob: a header (version, raw length, chunk count), then per
 * chunk a stored length, a method byte and the payload. A chunk that LZ4 does not shrink is stored.
 */
export function encodeSpill(raw: Uint8Array, codec: SpillCodec): Uint8Array {
  const chunks: EncodedChunk[] = [];
  for (let start = 0; start < raw.length; start += SPILL_CHUNK_BYTES) {
    const chunk = raw.subarray(start, Math.min(raw.length, start + SPILL_CHUNK_BYTES));
    const packed = codec === "lz4" ? lz4_compress(chunk) : undefined;
    chunks.push(
      packed && packed.length < chunk.length
        ? { method: METHOD_LZ4, bytes: packed }
        : { method: METHOD_STORED, bytes: chunk },
    );
  }

  const total = chunks.reduce(
    (sum, chunk) => sum + CHUNK_HEADER_BYTES + chunk.bytes.length,
    HEADER_BYTES,
  );
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint8(0, FORMAT_VERSION);
  view.setUint32(1, raw.length, true);
  view.setUint32(5, chunks.length, true);
  let at = HEADER_BYTES;
  for (const chunk of chunks) {
    view.setUint32(at, chunk.bytes.length, true);
    view.setUint8(at + 4, chunk.method);
    out.set(chunk.bytes, at + CHUNK_HEADER_BYTES);
    at += CHUNK_HEADER_BYTES + chunk.bytes.length;
  }
  return out;
}

/** Inverse of `encodeSpill`. Throws RangeError on a malformed blob. */
export function decodeSpill(encoded: Uint8Array): Uint8Array {
  if (encoded.length < HEADER_BYTES) throw new RangeError("Spill data is truncated.");
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  if (view.getUint8(0) !== FORMAT_VERSION) throw new RangeError("Unknown spill data version.");
  const rawLength = view.getUint32(1, true);
  const chunkCount = view.getUint32(5, true);
  const out = new Uint8Array(rawLength);

  let at = HEADER_BYTES;
  let written = 0;
  for (let i = 0; i < chunkCount; i++) {
    if (at + CHUNK_HEADER_BYTES > encoded.length) throw new RangeError("Spill data is truncated.");
    const storedLength = view.getUint32(at, true);
    const method = view.getUint8(at + 4);
    const payloadStart = at + CHUNK_HEADER_BYTES;
    const payloadEnd = payloadStart + storedLength;
    if (payloadEnd > encoded.length) throw new RangeError("Spill data is truncated.");
    const payload = encoded.subarray(payloadStart, payloadEnd);
    const rawChunk = Math.min(SPILL_CHUNK_BYTES, rawLength - written);
    if (rawChunk <= 0) throw new RangeError("Spill data has extra chunks.");

    if (method === METHOD_STORED) {
      if (storedLength !== rawChunk) throw new RangeError("Stored chunk has the wrong length.");
      out.set(payload, written);
    } else if (method === METHOD_LZ4) {
      out.set(lz4_decompress(payload, rawChunk), written);
    } else {
      throw new RangeError(`Unknown spill chunk method ${method}.`);
    }
    written += rawChunk;
    at = payloadEnd;
  }

  if (written !== rawLength || at !== encoded.length) {
    throw new RangeError("Spill data does not match its header.");
  }
  return out;
}
