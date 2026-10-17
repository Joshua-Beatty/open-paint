import { crc32, deflateSync, inflateSync } from "node:zlib";
import { decodePng, encodePng, type RgbaImage } from "@openpaint/codecs";
import { describe, expect, it } from "vitest";

const deflate = (data: Uint8Array) => new Uint8Array(deflateSync(data));
const inflate = async (data: Uint8Array) => new Uint8Array(inflateSync(data));

function image(width: number, height: number, seed: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  let state = seed;
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    data[i] = state >>> 16;
  }
  return { width, height, data };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Applies the PNG filter `types[y]` to each row; the decoder must undo it exactly. */
function filterRows(img: RgbaImage, types: readonly number[]): Uint8Array {
  const stride = img.width * 4;
  const raw = new Uint8Array((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    const type = types[y] ?? 0;
    raw[y * (stride + 1)] = type;
    for (let i = 0; i < stride; i++) {
      const x = img.data[y * stride + i] ?? 0;
      const left = i >= 4 ? (img.data[y * stride + i - 4] ?? 0) : 0;
      const up = y > 0 ? (img.data[(y - 1) * stride + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= 4 ? (img.data[(y - 1) * stride + i - 4] ?? 0) : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][type] ?? 0;
      raw[y * (stride + 1) + 1 + i] = (x - predictor) & 0xff;
    }
  }
  return raw;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), 8 + body.length);
  return out;
}

function buildPng(img: RgbaImage, raw: Uint8Array): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(img.width, 0);
  header.writeUInt32BE(img.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

describe("PNG codec", () => {
  it("round-trips straight-alpha RGBA8 pixels", async () => {
    const img = image(7, 5, 42);
    const decoded = await decodePng(encodePng(img, deflate), inflate);
    expect(decoded).toEqual(img);
  });

  it("decodes every PNG filter type", async () => {
    const img = image(9, 5, 7);
    const types = [0, 1, 2, 3, 4];
    const png = buildPng(img, filterRows(img, types));
    expect(await decodePng(png, inflate)).toEqual(img);
  });

  it("rejects files that are not PNGs", async () => {
    await expect(decodePng(new Uint8Array([1, 2, 3, 4]), inflate)).rejects.toThrow("Not a PNG");
  });

  it("rejects a chunk whose CRC does not match", async () => {
    const png = encodePng(image(2, 2, 1), deflate);
    const corrupt = png.slice();
    // The last four bytes are the IEND CRC; flipping one breaks that chunk.
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff;
    await expect(decodePng(corrupt, inflate)).rejects.toThrow("CRC mismatch");
  });

  it("refuses data whose size does not match the image", () => {
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(4) }, deflate)).toThrow(
      "expected 16",
    );
  });
});
