import { decode_gif, encode_gif } from "@openpaint/cpu";
import type { PngImage } from "./png-encoder";
import type { DecodedRaster } from "./raster-document";

/** The container parts of a GIF that do not depend on the pixels. */
export interface GifContainer {
  /** One XMP packet, in an application extension. Empty writes none. */
  readonly xmp: Uint8Array;
}

/**
 * Writes a GIF frame from a prepared 8-bit image (the WASM encoder). The transparent entry, when the
 * pipeline added one, is the palette entry whose alpha is 0.
 */
export function encodeGifImage(image: PngImage, container: GifContainer): Uint8Array {
  const transparent = image.alpha.indexOf(0);
  return encode_gif(
    image.width,
    image.height,
    image.pixels,
    image.palette,
    transparent < 0 ? undefined : transparent,
    container.xmp,
  );
}

/**
 * Reads the first frame of a GIF into straight RGBA (the WASM reader, FMT-META-04), with the XMP packet
 * of its application extension (FMT-META-01).
 */
export function decodeGifImage(bytes: Uint8Array): DecodedRaster {
  const decoded = decode_gif(bytes);
  try {
    return {
      width: decoded.width,
      height: decoded.height,
      pixels: decoded.pixels,
      pixelsPerMeter: { x: 0, y: 0 },
      xmp: decoded.xmp,
    };
  } finally {
    decoded.free();
  }
}
