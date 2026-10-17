import type { FileDocument, ProgressReporter } from "@openpaint/extension-api";
import { runCodecJob } from "./codec-jobs";
import { straightRgba } from "./raster-document";
import { srgbIccProfile } from "./srgb-profile";
import type { WebpSaveOptions } from "./webp-options";

const TEXT = new TextEncoder();
const NO_BYTES = new Uint8Array(0);

/**
 * Encodes a flat document as a WebP (FMT-OPT-WEBP-01, FMT-META-05) in the codec worker. The sRGB
 * profile is always written (the ICCP chunk). The EXIF and XMP metadata are written unless "Remove
 * metadata" is on, and only the first XMP packet is written.
 */
export async function encodeWebpFile(
  file: FileDocument,
  options: WebpSaveOptions,
  progress: ProgressReporter,
): Promise<Uint8Array> {
  const layer = file.layers[0];
  if (layer === undefined) throw new RangeError("A WebP needs at least one layer.");
  const exif = options.removeMetadata ? undefined : file.metadata.exif;
  const packet = options.removeMetadata ? undefined : file.metadata.xmp[0];
  const bytes = await runCodecJob("encodeWebp", {
    width: layer.surface.width,
    height: layer.surface.height,
    rgba: straightRgba(layer.surface),
    lossless: options.lossless,
    quality: options.quality,
    preset: options.preset,
    icc: srgbIccProfile(),
    exif: exif ?? NO_BYTES,
    xmp: packet === undefined ? NO_BYTES : TEXT.encode(packet),
  });
  progress(1);
  return bytes;
}
