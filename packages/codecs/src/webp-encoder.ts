import { encode } from "@jsquash/webp";
import type { EncodeOptions } from "@jsquash/webp/meta.js";
import type { WebpPreset } from "./webp-options";

/** The WebP encoder settings (FMT-OPT-WEBP-01). The preset applies to lossy output only. */
export interface WebpEncodeSettings {
  readonly quality: number;
  readonly lossless: boolean;
  readonly preset: WebpPreset;
}

/**
 * The libwebp tuning of each preset, the values that `WebPConfigPreset` sets in libwebp's
 * `src/enc/config_enc.c`. The Default preset keeps libwebp's own defaults.
 */
const PRESET_TUNING: Record<WebpPreset, Partial<EncodeOptions>> = {
  default: {},
  picture: { sns_strength: 80, filter_sharpness: 4, filter_strength: 35 },
  photo: { sns_strength: 80, filter_sharpness: 3, filter_strength: 30, preprocessing: 2 },
  drawing: { sns_strength: 25, filter_sharpness: 6, filter_strength: 10 },
  icon: { sns_strength: 0, filter_strength: 0 },
  text: { sns_strength: 0, filter_strength: 0, segments: 2 },
};

/**
 * The libwebp options for one save. Lossless output ignores the preset and the quality, since the
 * tuning fields only shape lossy coding. `exact` keeps the colors of transparent pixels, so a lossless
 * save is lossless for them too.
 */
export function webpEncodeOptions(settings: WebpEncodeSettings): Partial<EncodeOptions> {
  if (settings.lossless) return { lossless: 1, exact: 1 };
  return { lossless: 0, quality: settings.quality, ...PRESET_TUNING[settings.preset] };
}

/**
 * Encodes straight RGBA as a bare WebP bitstream with libwebp (WASM, via `@jsquash/webp`). The codec
 * worker wraps the bitstream with the ICC, EXIF and XMP chunks (see `wrap_webp`).
 */
export async function encodeWebpBitstream(
  width: number,
  height: number,
  rgba: Uint8Array,
  settings: WebpEncodeSettings,
): Promise<Uint8Array> {
  const image = {
    data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    width,
    height,
  } as ImageData;
  const bitstream = await encode(image, webpEncodeOptions(settings));
  return new Uint8Array(bitstream);
}
