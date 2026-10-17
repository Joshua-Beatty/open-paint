import { decode_bmp, encode_bmp } from "@openpaint/cpu";
import type { PngImage } from "./png-encoder";
import type { DecodedRaster } from "./raster-document";

/** The container parts of a BMP that do not depend on the pixels. */
export interface BmpContainer {
  /** The sRGB profile, embedded only when "Embed color profiles in BMP" is on. Empty writes none. */
  readonly icc: Uint8Array;
  /** Pixels per meter for the header. Zero on either axis writes none. */
  readonly pixelsPerMeter: { readonly x: number; readonly y: number };
}

/** Writes a BMP from a prepared image (the WASM encoder). */
export function encodeBmpImage(image: PngImage, container: BmpContainer): Uint8Array {
  return encode_bmp(
    image.width,
    image.height,
    image.pixels,
    image.depth,
    image.palette,
    container.icc,
    container.pixelsPerMeter.x,
    container.pixelsPerMeter.y,
  );
}

/** Reads a BMP into straight RGBA (the WASM reader, FMT-OPT-BMP-01). */
export function decodeBmpImage(bytes: Uint8Array): DecodedRaster {
  const decoded = decode_bmp(bytes);
  try {
    return {
      width: decoded.width,
      height: decoded.height,
      pixels: decoded.pixels,
      pixelsPerMeter: { x: decoded.pixels_per_meter_x, y: decoded.pixels_per_meter_y },
      icc: decoded.icc,
    };
  } finally {
    decoded.free();
  }
}
