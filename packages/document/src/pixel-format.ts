/**
 * Storage format of a surface or tile store (ARC-01-05). v1 documents are always RGBA8 with
 * straight alpha, bytes in memory ordered R, G, B, A, matching `ImageData` and `rgba8unorm`
 * (ARC-01-01, DOC-DOC-02).
 */
export type PixelFormat = "rgba8";

export interface PixelFormatInfo {
  readonly bytesPerPixel: number;
  readonly premultiplied: boolean;
}

export const PIXEL_FORMATS: Readonly<Record<PixelFormat, PixelFormatInfo>> = Object.freeze({
  rgba8: Object.freeze({ bytesPerPixel: 4, premultiplied: false }),
});

/** Document color profile carried explicitly by pixel stores (ARC-01-03/03a); sRGB in v1. */
export type ColorProfileId = "srgb";
