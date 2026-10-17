import { defaultCmykProfile } from "./cmyk-profile";
import { convertToSrgb, ProfileError, profileSpace } from "./color-engine";
import type { DecodedRaster } from "./raster-document";

/**
 * Brings decoded pixels into sRGB (FMT-META-03, WEB-COL-01). An embedded RGB or gray profile converts
 * the pixels through the color engine, with the relative colorimetric intent and black-point
 * compensation. A CMYK image converts with its embedded CMYK profile, or the default one. A profile
 * that cannot be used is ignored, the pixels are treated as sRGB, and the caller shows a warning.
 */

/** The catalog key of the warning for an embedded profile that is ignored (FMT-META-03). */
export const PROFILE_IGNORED_WARNING = "file.warning.profileIgnored";

/** Pixels in sRGB, with the catalog keys of the warnings their conversion raised. */
export interface SrgbPixels {
  /** Straight RGBA, 8 bits per channel. */
  readonly pixels: Uint8Array;
  readonly warnings: readonly string[];
}

const RGBA_CHANNELS = 4;
const RGB_CHANNELS = 3;

/** The straight RGBA pixels of a decoded 8-bit image in sRGB. */
export async function srgbPixelsOf(raster: DecodedRaster): Promise<SrgbPixels> {
  const icc = raster.icc;
  if (icc === undefined || icc.length === 0) return { pixels: raster.pixels, warnings: [] };
  const space = await profileSpace(icc);
  if (space !== "rgb" && space !== "gray") return ignoredProfile(raster.pixels);
  try {
    return { pixels: await convertRgbaToSrgb(raster.pixels, 8, icc, space), warnings: [] };
  } catch (cause) {
    if (cause instanceof ProfileError) return ignoredProfile(raster.pixels);
    throw cause;
  }
}

/**
 * The straight RGBA pixels of a CMYK image (8 bits per channel, 255 full ink) in sRGB. The embedded
 * CMYK profile converts them. Without one, the default CMYK profile does, with no warning. When the
 * embedded profile cannot be used, the default converts the pixels and the warning is raised.
 */
export async function cmykPixelsOf(cmyk: Uint8Array, icc?: Uint8Array): Promise<SrgbPixels> {
  if (icc !== undefined && icc.length > 0) {
    try {
      return { pixels: await convertCmyk(cmyk, icc), warnings: [] };
    } catch (cause) {
      if (!(cause instanceof ProfileError)) throw cause;
      return {
        pixels: await convertCmyk(cmyk, defaultCmykProfile()),
        warnings: [PROFILE_IGNORED_WARNING],
      };
    }
  }
  return { pixels: await convertCmyk(cmyk, defaultCmykProfile()), warnings: [] };
}

/**
 * Converts straight RGBA pixels from a profile in the `space` (RGB or gray) into sRGB RGBA. For gray,
 * the red sample of each pixel is the gray level. Alpha is kept, and 16-bit samples are reduced to 8.
 */
export async function convertRgbaToSrgb(
  rgba: Uint8Array,
  bitsPerSample: 8 | 16,
  profile: Uint8Array,
  space: "rgb" | "gray",
): Promise<Uint8Array> {
  const bytes = bitsPerSample / 8;
  const pixelCount = rgba.length / (RGBA_CHANNELS * bytes);
  const channels = space === "rgb" ? RGB_CHANNELS : 1;
  const colors = new Uint8Array(pixelCount * channels * bytes);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    for (let sample = 0; sample < channels * bytes; sample += 1) {
      colors[pixel * channels * bytes + sample] = rgba[pixel * RGBA_CHANNELS * bytes + sample] ?? 0;
    }
  }
  const rgb = await convertToSrgb(profile, { space, bitsPerSample, samples: colors });
  const out = new Uint8Array(pixelCount * RGBA_CHANNELS);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    for (let channel = 0; channel < RGB_CHANNELS; channel += 1) {
      out[pixel * RGBA_CHANNELS + channel] = rgb[pixel * RGB_CHANNELS + channel] ?? 0;
    }
    const alphaAt = pixel * RGBA_CHANNELS * bytes + (RGBA_CHANNELS - 1) * bytes;
    out[pixel * RGBA_CHANNELS + 3] = alphaByte(rgba, alphaAt, bitsPerSample);
  }
  return out;
}

async function convertCmyk(cmyk: Uint8Array, profile: Uint8Array): Promise<Uint8Array> {
  const rgb = await convertToSrgb(profile, { space: "cmyk", bitsPerSample: 8, samples: cmyk });
  const pixelCount = rgb.length / RGB_CHANNELS;
  const out = new Uint8Array(pixelCount * RGBA_CHANNELS);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    for (let channel = 0; channel < RGB_CHANNELS; channel += 1) {
      out[pixel * RGBA_CHANNELS + channel] = rgb[pixel * RGB_CHANNELS + channel] ?? 0;
    }
    out[pixel * RGBA_CHANNELS + 3] = 255;
  }
  return out;
}

function ignoredProfile(pixels: Uint8Array): SrgbPixels {
  return { pixels, warnings: [PROFILE_IGNORED_WARNING] };
}

/** An 8-bit alpha from the sample at `offset`, reduced from 16 bits with rounding (65535 maps to 255). */
function alphaByte(rgba: Uint8Array, offset: number, bitsPerSample: 8 | 16): number {
  if (bitsPerSample === 8) return rgba[offset] ?? 0;
  const wide = (rgba[offset] ?? 0) | ((rgba[offset + 1] ?? 0) << 8);
  return Math.round(wide / 257);
}
