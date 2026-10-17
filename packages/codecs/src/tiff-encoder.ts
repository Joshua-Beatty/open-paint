import { decode_tiff, encode_tiff } from "@openpaint/cpu";
import type { PngImage } from "./png-encoder";
import type { DecodedRaster } from "./raster-document";

/** The container parts of a TIFF that do not depend on the pixels. */
export interface TiffContainer {
  /** The sRGB profile (the ICC tag). Empty writes none. */
  readonly icc: Uint8Array;
  /** A TIFF-structured EXIF block whose IFD0 entries are copied. Empty writes none. */
  readonly exif: Uint8Array;
  /** One XMP packet. Empty writes none. */
  readonly xmp: Uint8Array;
  /** Pixels per meter for the density tags. Zero on either axis writes none. */
  readonly pixelsPerMeter: { readonly x: number; readonly y: number };
}

/**
 * A decoded TIFF page: its pixels and density, and the metadata held in IFD0. A CMYK page holds CMYK
 * ink in `pixels` (four bytes per pixel) instead of RGBA.
 */
export interface DecodedTiff extends DecodedRaster {
  /** A TIFF-structured EXIF block of the IFD0 entries that are not part of the TIFF structure. */
  readonly exif: Uint8Array;
  /** The XMP packet, or empty when the file has none. */
  readonly xmp: Uint8Array;
  /** True when `pixels` is CMYK ink, which the color engine converts to sRGB (FMT-META-03). */
  readonly cmyk: boolean;
}

/** Writes a TIFF page from a prepared image (the WASM encoder). */
export function encodeTiffImage(image: PngImage, container: TiffContainer): Uint8Array {
  return encode_tiff(
    image.width,
    image.height,
    image.pixels,
    image.depth,
    image.palette,
    container.icc,
    container.pixelsPerMeter.x,
    container.pixelsPerMeter.y,
    container.exif,
    container.xmp,
  );
}

/** Reads the first page of a TIFF into straight RGBA, or CMYK ink for a CMYK page (the WASM reader). */
export function decodeTiffImage(bytes: Uint8Array): DecodedTiff {
  const decoded = decode_tiff(bytes);
  try {
    return {
      width: decoded.width,
      height: decoded.height,
      pixels: decoded.pixels,
      pixelsPerMeter: { x: decoded.pixels_per_meter_x, y: decoded.pixels_per_meter_y },
      icc: decoded.icc,
      exif: decoded.exif,
      xmp: decoded.xmp,
      cmyk: decoded.cmyk,
    };
  } finally {
    decoded.free();
  }
}
