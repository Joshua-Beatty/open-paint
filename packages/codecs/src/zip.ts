/**
 * A ZIP container (PKWARE APPNOTE) for the native format (FMT-NAT-02). The writer stores or deflates
 * entries and switches to ZIP64 records when the archive needs them. The reader locates entries through
 * the central directory, refuses unsafe paths and checks each entry's CRC-32. It has no DOM or Node
 * imports; DEFLATE goes through the platform streams in `zlib.ts`.
 */
import { crc32 } from "./png";
import { deflateRaw, inflateRaw } from "./zlib";

/** A ZIP archive that is malformed, encrypted, multi-volume, unsafe, too large or fails its CRC-32. */
export class ZipError extends Error {
  override readonly name = "ZipError";
}

/** An entry to write. `deflate` compresses it with raw DEFLATE; otherwise it is stored. */
export interface ZipInput {
  readonly path: string;
  readonly data: Uint8Array;
  readonly deflate: boolean;
}

/** One entry of a read archive, from its central directory record. */
export interface ZipEntry {
  readonly path: string;
  /** 0 for stored, 8 for deflated. */
  readonly method: number;
  readonly crc: number;
  /** Uncompressed size in bytes. */
  readonly size: number;
  readonly compressedSize: number;
  /** Offset of the local file header. */
  readonly offset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const ZIP64_EOCD_SIZE = 56;
const ZIP64_LOCATOR_SIZE = 20;
const MAX_COMMENT_SIZE = UINT16_MAX;
/** 1980-01-01 00:00, so the same entries always give the same bytes. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ZipWriteOptions {
  /** Compresses entries that ask for it. Raw DEFLATE, as ZIP stores it. */
  readonly deflate?: (data: Uint8Array) => Promise<Uint8Array>;
  /** Writes ZIP64 records even when the archive does not need them. */
  readonly forceZip64?: boolean;
}

/**
 * Writes an archive with the entries in the given order. ZIP64 records are used when there are
 * 65,535 or more entries, or when an entry or the archive is 4 GiB or larger (APPNOTE 4.3.14).
 */
export async function writeZip(
  entries: readonly ZipInput[],
  options: ZipWriteOptions = {},
): Promise<Uint8Array> {
  const archiveZip64 = options.forceZip64 === true || entries.length >= UINT16_MAX;
  const deflate = options.deflate ?? deflateRaw;
  const prepared = [];
  for (const entry of entries) {
    if (!isSafeEntryPath(entry.path)) throw new ZipError(`Unsafe entry path ${entry.path}.`);
    const body = entry.deflate ? await deflate(entry.data) : entry.data;
    prepared.push({
      name: TEXT_ENCODER.encode(entry.path),
      body,
      method: entry.deflate ? METHOD_DEFLATE : METHOD_STORE,
      crc: crc32(entry.data),
      size: entry.data.byteLength,
    });
  }

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    offset += bytes.byteLength;
  };

  for (const entry of prepared) {
    const zip64 = archiveZip64 || entry.size >= UINT32_MAX || entry.body.byteLength >= UINT32_MAX;
    const localOffset = offset;
    const localExtra = zip64 ? zip64Extra([entry.size, entry.body.byteLength]) : new Uint8Array(0);
    const version = zip64 ? VERSION_ZIP64 : VERSION_DEFAULT;
    push(
      record(LOCAL_HEADER_SIZE + entry.name.byteLength + localExtra.byteLength, (view, out) => {
        view.setUint32(0, SIG_LOCAL, true);
        view.setUint16(4, version, true);
        view.setUint16(6, FLAG_UTF8, true);
        view.setUint16(8, entry.method, true);
        view.setUint16(10, DOS_TIME, true);
        view.setUint16(12, DOS_DATE, true);
        view.setUint32(14, entry.crc, true);
        view.setUint32(18, zip64 ? UINT32_MAX : entry.body.byteLength, true);
        view.setUint32(22, zip64 ? UINT32_MAX : entry.size, true);
        view.setUint16(26, entry.name.byteLength, true);
        view.setUint16(28, localExtra.byteLength, true);
        out.set(entry.name, LOCAL_HEADER_SIZE);
        out.set(localExtra, LOCAL_HEADER_SIZE + entry.name.byteLength);
      }),
    );
    push(entry.body);

    const centralExtra = zip64
      ? zip64Extra([entry.size, entry.body.byteLength, localOffset])
      : new Uint8Array(0);
    central.push(
      record(CENTRAL_HEADER_SIZE + entry.name.byteLength + centralExtra.byteLength, (view, out) => {
        view.setUint32(0, SIG_CENTRAL, true);
        view.setUint16(4, version, true);
        view.setUint16(6, version, true);
        view.setUint16(8, FLAG_UTF8, true);
        view.setUint16(10, entry.method, true);
        view.setUint16(12, DOS_TIME, true);
        view.setUint16(14, DOS_DATE, true);
        view.setUint32(16, entry.crc, true);
        view.setUint32(20, zip64 ? UINT32_MAX : entry.body.byteLength, true);
        view.setUint32(24, zip64 ? UINT32_MAX : entry.size, true);
        view.setUint16(28, entry.name.byteLength, true);
        view.setUint16(30, centralExtra.byteLength, true);
        view.setUint16(32, 0, true);
        view.setUint16(34, 0, true);
        view.setUint16(36, 0, true);
        view.setUint32(38, 0, true);
        view.setUint32(42, zip64 ? UINT32_MAX : localOffset, true);
        out.set(entry.name, CENTRAL_HEADER_SIZE);
        out.set(centralExtra, CENTRAL_HEADER_SIZE + entry.name.byteLength);
      }),
    );
  }

  const centralOffset = offset;
  for (const header of central) push(header);
  const centralSize = offset - centralOffset;

  if (archiveZip64) {
    const zip64EndOffset = offset;
    push(
      record(ZIP64_EOCD_SIZE, (view) => {
        view.setUint32(0, SIG_ZIP64_EOCD, true);
        view.setBigUint64(4, BigInt(ZIP64_EOCD_SIZE - 12), true);
        view.setUint16(12, VERSION_ZIP64, true);
        view.setUint16(14, VERSION_ZIP64, true);
        view.setUint32(16, 0, true);
        view.setUint32(20, 0, true);
        view.setBigUint64(24, BigInt(prepared.length), true);
        view.setBigUint64(32, BigInt(prepared.length), true);
        view.setBigUint64(40, BigInt(centralSize), true);
        view.setBigUint64(48, BigInt(centralOffset), true);
      }),
    );
    push(
      record(ZIP64_LOCATOR_SIZE, (view) => {
        view.setUint32(0, SIG_ZIP64_LOCATOR, true);
        view.setUint32(4, 0, true);
        view.setBigUint64(8, BigInt(zip64EndOffset), true);
        view.setUint32(16, 1, true);
      }),
    );
  }

  const count = archiveZip64 ? UINT16_MAX : prepared.length;
  push(
    record(EOCD_SIZE, (view) => {
      view.setUint32(0, SIG_EOCD, true);
      view.setUint16(4, 0, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, count, true);
      view.setUint16(10, count, true);
      view.setUint32(12, archiveZip64 ? UINT32_MAX : centralSize, true);
      view.setUint32(16, archiveZip64 ? UINT32_MAX : centralOffset, true);
      view.setUint16(20, 0, true);
    }),
  );
  return concat(parts, offset);
}

/**
 * An archive read from its central directory. Entries are in archive order (by local header
 * offset). The directory is checked on open, and data is verified when it is read.
 */
export class ZipArchive {
  readonly entries: readonly ZipEntry[];
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array, entries: readonly ZipEntry[]) {
    this.#bytes = bytes;
    this.entries = entries;
  }

  /** Parses the central directory. Throws ZipError when the bytes are not a readable archive. */
  static open(bytes: Uint8Array): ZipArchive {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEndRecord(bytes, view);
    let entryCount = view.getUint16(eocd + 10, true);
    let centralSize = view.getUint32(eocd + 12, true);
    let centralOffset = view.getUint32(eocd + 16, true);
    if (
      eocd >= ZIP64_LOCATOR_SIZE &&
      view.getUint32(eocd - ZIP64_LOCATOR_SIZE, true) === SIG_ZIP64_LOCATOR
    ) {
      const end = readUint64(view, eocd - ZIP64_LOCATOR_SIZE + 8);
      if (
        end + ZIP64_EOCD_SIZE > bytes.byteLength ||
        view.getUint32(end, true) !== SIG_ZIP64_EOCD
      ) {
        throw new ZipError("The ZIP64 end record is missing.");
      }
      entryCount = readUint64(view, end + 32);
      centralSize = readUint64(view, end + 40);
      centralOffset = readUint64(view, end + 48);
    } else if (entryCount === UINT16_MAX || centralOffset === UINT32_MAX) {
      throw new ZipError("The archive uses ZIP64 records without a locator.");
    }
    if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
      throw new ZipError("Multi-volume archives are not supported.");
    }
    if (centralOffset + centralSize > bytes.byteLength) {
      throw new ZipError("The central directory is outside the archive.");
    }
    const entries = readCentralDirectory(bytes, view, centralOffset, centralSize, entryCount);
    entries.sort((a, b) => a.offset - b.offset);
    return new ZipArchive(bytes, entries);
  }

  /** The entry with this path, if the archive has one. */
  find(path: string): ZipEntry | undefined {
    return this.entries.find((entry) => entry.path === path);
  }

  /**
   * The verified bytes of an entry. Throws ZipError when the entry is larger than `maxBytes`, when its
   * data is malformed, when inflating it would exceed its declared size, or when its CRC-32 fails.
   */
  async read(entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
    if (entry.size > maxBytes) throw new ZipError(`Entry ${entry.path} is larger than allowed.`);
    const view = new DataView(this.#bytes.buffer, this.#bytes.byteOffset, this.#bytes.byteLength);
    if (entry.offset + LOCAL_HEADER_SIZE > this.#bytes.byteLength) {
      throw new ZipError(`Entry ${entry.path} starts outside the archive.`);
    }
    if (view.getUint32(entry.offset, true) !== SIG_LOCAL) {
      throw new ZipError(`Entry ${entry.path} has no local header.`);
    }
    const dataStart =
      entry.offset +
      LOCAL_HEADER_SIZE +
      view.getUint16(entry.offset + 26, true) +
      view.getUint16(entry.offset + 28, true);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.#bytes.byteLength) throw new ZipError(`Entry ${entry.path} is truncated.`);
    const raw = this.#bytes.subarray(dataStart, dataEnd);
    let data: Uint8Array;
    if (entry.method === METHOD_STORE) {
      if (entry.compressedSize !== entry.size)
        throw new ZipError(`Entry ${entry.path} has a bad size.`);
      data = raw;
    } else {
      try {
        data = await inflateRaw(raw, entry.size);
      } catch (cause) {
        throw new ZipError(`Entry ${entry.path} cannot be inflated.`, { cause });
      }
    }
    if (data.byteLength !== entry.size) throw new ZipError(`Entry ${entry.path} has a bad size.`);
    if (crc32(data) !== entry.crc)
      throw new ZipError(`Entry ${entry.path} fails its CRC-32 check.`);
    return data;
  }
}

/**
 * Whether an entry path is safe to use: relative, `/`-separated, with no empty, `.` or `..` segment,
 * no backslash, no drive letter and no NUL (FMT-NAT-02).
 */
export function isSafeEntryPath(path: string): boolean {
  if (path.length === 0 || path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function findEndRecord(bytes: Uint8Array, view: DataView): number {
  const lowest = Math.max(0, bytes.byteLength - EOCD_SIZE - MAX_COMMENT_SIZE);
  for (let at = bytes.byteLength - EOCD_SIZE; at >= lowest; at -= 1) {
    if (view.getUint32(at, true) === SIG_EOCD) return at;
  }
  throw new ZipError("The file has no ZIP end record.");
}

function readCentralDirectory(
  bytes: Uint8Array,
  view: DataView,
  centralOffset: number,
  centralSize: number,
  entryCount: number,
): ZipEntry[] {
  const end = centralOffset + centralSize;
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let position = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (position + CENTRAL_HEADER_SIZE > end || view.getUint32(position, true) !== SIG_CENTRAL) {
      throw new ZipError("The central directory is malformed.");
    }
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const crc = view.getUint32(position + 16, true);
    const compressed32 = view.getUint32(position + 20, true);
    const size32 = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const disk = view.getUint16(position + 34, true);
    const offset32 = view.getUint32(position + 42, true);
    const nameStart = position + CENTRAL_HEADER_SIZE;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > end) throw new ZipError("The central directory is malformed.");
    if ((flags & FLAG_ENCRYPTED) !== 0) throw new ZipError("Encrypted entries are not supported.");
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipError(`Compression method ${method} is not supported.`);
    }
    if (disk !== 0) throw new ZipError("Multi-volume archives are not supported.");

    let path: string;
    try {
      path = TEXT_DECODER.decode(bytes.subarray(nameStart, extraStart));
    } catch (cause) {
      throw new ZipError("An entry name is not UTF-8.", { cause });
    }
    if (!isSafeEntryPath(path)) throw new ZipError(`Unsafe entry path ${path}.`);
    if (seen.has(path)) throw new ZipError(`Duplicate entry ${path}.`);
    seen.add(path);

    let size = size32;
    let compressedSize = compressed32;
    let offset = offset32;
    let field = extraStart;
    const extraEnd = extraStart + extraLength;
    while (field + 4 <= extraEnd) {
      const id = view.getUint16(field, true);
      const length = view.getUint16(field + 2, true);
      if (id === ZIP64_EXTRA_ID) {
        let at = field + 4;
        if (size32 === UINT32_MAX) {
          size = readUint64(view, at);
          at += 8;
        }
        if (compressed32 === UINT32_MAX) {
          compressedSize = readUint64(view, at);
          at += 8;
        }
        if (offset32 === UINT32_MAX) offset = readUint64(view, at);
      }
      field += 4 + length;
    }
    if (size32 === UINT32_MAX || compressed32 === UINT32_MAX || offset32 === UINT32_MAX) {
      if (!hasZip64Extra(view, extraStart, extraEnd)) {
        throw new ZipError(`Entry ${path} is missing its ZIP64 sizes.`);
      }
    }
    entries.push({ path, method, crc, size, compressedSize, offset });
    position = next;
  }
  return entries;
}

function hasZip64Extra(view: DataView, start: number, end: number): boolean {
  for (let field = start; field + 4 <= end; ) {
    if (view.getUint16(field, true) === ZIP64_EXTRA_ID) return true;
    field += 4 + view.getUint16(field + 2, true);
  }
  return false;
}

function readUint64(view: DataView, at: number): number {
  if (at + 8 > view.byteLength) throw new ZipError("A ZIP64 field is outside the archive.");
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError("A ZIP64 field is too large.");
  return Number(value);
}

function zip64Extra(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(4 + values.length * 8);
  const view = new DataView(out.buffer);
  view.setUint16(0, ZIP64_EXTRA_ID, true);
  view.setUint16(2, values.length * 8, true);
  for (const [index, value] of values.entries()) {
    view.setBigUint64(4 + index * 8, BigInt(value), true);
  }
  return out;
}

function record(size: number, fill: (view: DataView, out: Uint8Array) => void): Uint8Array {
  const out = new Uint8Array(size);
  fill(new DataView(out.buffer), out);
  return out;
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
