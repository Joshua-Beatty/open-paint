import { encode } from "@jsquash/jxl";

/** The JPEG XL encoder settings (FMT-OPT-JXL-01). Quality and effort are ignored when lossless is set. */
export interface JxlEncodeSettings {
  readonly quality: number;
  readonly effort: number;
  readonly lossless: boolean;
}

/**
 * Encodes straight RGBA as a bare JPEG XL codestream with libjxl (WASM, via `@jsquash/jxl`). The
 * codestream is not wrapped in a container here: the codec worker adds the EXIF and XMP boxes (see
 * `wrap_jxl`). The encoder runs its multithreaded build in browsers and its single-threaded build in Node.
 */
export async function encodeJxlCodestream(
  width: number,
  height: number,
  rgba: Uint8Array,
  settings: JxlEncodeSettings,
): Promise<Uint8Array> {
  const image = {
    data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    width,
    height,
  } as ImageData;
  const codestream = await encode(image, {
    quality: settings.quality,
    effort: settings.effort,
    lossless: settings.lossless,
  });
  return new Uint8Array(codestream);
}
