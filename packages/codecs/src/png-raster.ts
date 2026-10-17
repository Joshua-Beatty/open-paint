import { decode_png } from "@openpaint/cpu";
import { DecodeError } from "./errors";

/** A PNG's pixels in straight RGBA8, top row first, before any color conversion. */
export interface PngPixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/**
 * Decodes a PNG to straight RGBA8 in WASM (WEB-FILE-07). The color engine then converts the pixels from
 * an embedded profile (FMT-META-03). The browser's decoder is not used, so every PNG decodes the same way.
 */
export function decodePngPixels(bytes: Uint8Array): PngPixels {
  let raster: ReturnType<typeof decode_png>;
  try {
    raster = decode_png(bytes);
  } catch (cause) {
    throw new DecodeError("The image could not be decoded.", cause);
  }
  try {
    return { width: raster.width, height: raster.height, pixels: raster.pixels };
  } finally {
    raster.free();
  }
}
