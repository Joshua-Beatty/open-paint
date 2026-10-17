import { decode_tga, encode_tga } from "@openpaint/cpu";
import type { PngImage } from "./png-encoder";
import type { DecodedRaster } from "./raster-document";

/** The TGA header fields and extension area that do not depend on the pixels. */
export interface TgaContainer {
  /** Run-length packets per scanline (FMT-OPT-TGA-01). */
  readonly rle: boolean;
  /** The author field, ASCII, up to 40 bytes. Empty leaves it blank. */
  readonly author: Uint8Array;
  /** The comment field, ASCII, written as up to four lines of 80 bytes. */
  readonly comment: Uint8Array;
  /** Month, day, year, hour, minute and second of the save. */
  readonly date: readonly number[];
}

/** Writes a TGA 2.0 file from a prepared 24 or 32-bit image (the WASM encoder). */
export function encodeTgaImage(image: PngImage, container: TgaContainer): Uint8Array {
  return encode_tga(
    image.width,
    image.height,
    image.pixels,
    image.depth,
    container.rle,
    container.author,
    container.comment,
    Uint16Array.from(container.date),
  );
}

/** Reads a TGA into straight RGBA (the WASM reader, FMT-OPT-TGA-01). */
export function decodeTgaImage(bytes: Uint8Array): DecodedRaster {
  const decoded = decode_tga(bytes);
  try {
    return {
      width: decoded.width,
      height: decoded.height,
      pixels: decoded.pixels,
      pixelsPerMeter: { x: 0, y: 0 },
      author: decoded.author,
      comment: decoded.comment,
    };
  } finally {
    decoded.free();
  }
}
