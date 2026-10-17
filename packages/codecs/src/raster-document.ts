import {
  DEFAULT_RESOLUTION,
  MAX_RESOLUTION,
  MIN_RESOLUTION,
  type Resolution,
  Surface,
} from "@openpaint/document";
import type { FileDocument } from "@openpaint/extension-api";

/** Decoded pixels from a WASM reader: straight RGBA, top row first, and the header's density. */
export interface DecodedRaster {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly pixelsPerMeter: { readonly x: number; readonly y: number };
  /** The embedded ICC profile (BMP), when the header carries one. */
  readonly icc?: Uint8Array;
  /** The TGA author and comment fields, when the file has an extension area. */
  readonly author?: Uint8Array;
  readonly comment?: Uint8Array;
  /** The XMP packet, when the file carries one (GIF). */
  readonly xmp?: Uint8Array;
}

const CENTIMETERS_PER_METER = 100;
const TEXT_DECODER = new TextDecoder();

/** A one-layer document for a decoded raster, as the flat formats open (FMT-META-01). */
export function rasterDocument(raster: DecodedRaster, resolution: Resolution): FileDocument {
  const surface = new Surface(raster.width, raster.height, new Uint8ClampedArray(raster.pixels));
  const xmp =
    raster.xmp !== undefined && raster.xmp.length > 0 ? [TEXT_DECODER.decode(raster.xmp)] : [];
  return {
    width: raster.width,
    height: raster.height,
    resolution,
    colorProfile: "srgb",
    metadata: { xmp, user: {} },
    layers: [{ name: "Background", visible: true, opacity: 255, blendMode: 0, surface }],
  };
}

/** The surface's straight RGBA bytes as a view over its pixels, for the WASM encoders. */
export function straightRgba(surface: Surface): Uint8Array {
  return new Uint8Array(surface.data.buffer, surface.data.byteOffset, surface.data.byteLength);
}

/**
 * The resolution a header's pixels per meter give, in centimeters. A header with no density gives
 * the document default. Values are clamped to the document's resolution range (DOC-DOC-03).
 */
export function resolutionFromPixelsPerMeter(pixelsPerMeter: {
  readonly x: number;
  readonly y: number;
}): Resolution {
  if (pixelsPerMeter.x <= 0 || pixelsPerMeter.y <= 0) return DEFAULT_RESOLUTION;
  const perCentimeter = (value: number) =>
    Math.min(MAX_RESOLUTION, Math.max(MIN_RESOLUTION, value / CENTIMETERS_PER_METER));
  return {
    unit: "centimeter",
    x: perCentimeter(pixelsPerMeter.x),
    y: perCentimeter(pixelsPerMeter.y),
  };
}
