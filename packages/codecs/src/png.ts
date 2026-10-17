/**
 * Minimal PNG codec: 8-bit RGBA, non-interlaced, straight alpha. It has no DOM or Node imports, so
 * every runtime shares it. Compression is injected: Node passes zlib, the browser passes the
 * `CompressionStream` helpers in `zlib.ts`.
 */

/** Straight-alpha RGBA8 pixels, row-major, four bytes per pixel. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Compresses raw bytes into a zlib stream (RFC 1950). */
export type Deflate = (data: Uint8Array) => Uint8Array;

/** Compresses raw bytes into a zlib stream (RFC 1950), asynchronously. */
export type AsyncDeflate = (data: Uint8Array) => Promise<Uint8Array>;

/** Decompresses a zlib stream (RFC 1950). */
export type Inflate = (data: Uint8Array) => Promise<Uint8Array>;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = 4;
const COLOR_TYPE_RGBA = 6;
const BIT_DEPTH = 8;
const TEXT = new TextEncoder();

export function encodePng(image: RgbaImage, deflate: Deflate): Uint8Array {
  return assemblePng(image, deflate(scanlines(image)));
}

export async function encodePngAsync(image: RgbaImage, deflate: AsyncDeflate): Promise<Uint8Array> {
  return assemblePng(image, await deflate(scanlines(image)));
}

export async function decodePng(bytes: Uint8Array, inflate: Inflate): Promise<RgbaImage> {
  if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) throw new Error("Not a PNG file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: { width: number; height: number } | undefined;
  const idat: Uint8Array[] = [];
  let offset = SIGNATURE.length;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    const crc = view.getUint32(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== crc) {
      throw new Error(`PNG ${type} chunk CRC mismatch.`);
    }
    offset += length + 12;
    if (type === "IHDR") {
      const info = new DataView(body.buffer, body.byteOffset, body.byteLength);
      header = { width: info.getUint32(0), height: info.getUint32(4) };
      const [depth, colorType, compression, filter, interlace] = body.subarray(8, 13);
      if (
        depth !== BIT_DEPTH ||
        colorType !== COLOR_TYPE_RGBA ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new Error("Only 8-bit non-interlaced RGBA PNGs are supported.");
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!header) throw new Error("PNG has no IHDR chunk.");
  const { width, height } = header;
  const stride = width * CHANNELS;
  const raw = await inflate(concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("PNG pixel data has the wrong size.");

  const data = new Uint8Array(stride * height);
  const blank = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : blank;
    const cur = data.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= CHANNELS ? (cur[i - CHANNELS] ?? 0) : 0;
      const up = prev[i] ?? 0;
      const upLeft = i >= CHANNELS ? (prev[i - CHANNELS] ?? 0) : 0;
      const predictor = predict(filter, left, up, upLeft);
      cur[i] = ((line[i] ?? 0) + predictor) & 0xff;
    }
  }
  return { width, height, data };
}

/** Each row with filter type 0 (None) in front of its pixels. */
function scanlines(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  if (data.length !== width * height * CHANNELS) {
    throw new RangeError(`Image data has ${data.length} bytes; expected ${width * height * 4}.`);
  }
  const stride = width * CHANNELS;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return raw;
}

/** The PNG container around compressed scanlines. The sRGB chunk tags the pixels as sRGB (DOC-CLP-02). */
function assemblePng(image: RgbaImage, compressed: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header[8] = BIT_DEPTH;
  header[9] = COLOR_TYPE_RGBA;
  return concat([
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("sRGB", Uint8Array.of(0)),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4:
      return paeth(left, up, upLeft);
    default:
      throw new Error(`Unknown PNG filter type ${filter}.`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(TEXT.encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
