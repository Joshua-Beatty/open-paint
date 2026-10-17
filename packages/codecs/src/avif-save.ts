import type { FileDocument, ProgressReporter } from "@openpaint/extension-api";
import type { AvifSaveOptions } from "./avif-options";
import { runCodecJob } from "./codec-jobs";
import { straightRgba } from "./raster-document";
import { srgbIccProfile } from "./srgb-profile";

const TEXT = new TextEncoder();
const NO_BYTES = new Uint8Array(0);

/**
 * Encodes a flat document as an AVIF (FMT-OPT-AVIF-01) in the codec worker. The color planes use the
 * chosen subsampling, or full 4:4:4 with the identity matrix when Lossless is on. Premultiplied alpha
 * applies only to lossy output, since the spec disables it for lossless. The EXIF block (GPS included)
 * and the first XMP packet are written unless "Remove metadata" is on. The sRGB ICC profile is written as
 * a `colr` property of type `prof` (FMT-META-05), beside the CICP box. The progress reporter is called
 * before the encode and after it, so a superseded save can stop at either point (FMT-REG-06 cancellation).
 */
export async function encodeAvifFile(
  file: FileDocument,
  options: AvifSaveOptions,
  progress: ProgressReporter,
): Promise<Uint8Array> {
  const layer = file.layers[0];
  if (layer === undefined) throw new RangeError("An AVIF needs at least one layer.");
  const exif = options.removeMetadata ? undefined : file.metadata.exif;
  const packet = options.removeMetadata ? undefined : file.metadata.xmp[0];
  progress(0);
  const bytes = await runCodecJob("encodeAvif", {
    width: layer.surface.width,
    height: layer.surface.height,
    rgba: straightRgba(layer.surface),
    lossless: options.lossless,
    quality: options.quality,
    losslessAlpha: options.losslessAlpha,
    alphaQuality: options.quality,
    speed: options.speed,
    chroma: options.chroma,
    premultiplied: !options.lossless && options.premultipliedAlpha,
    exif: exif ?? NO_BYTES,
    xmp: packet === undefined ? NO_BYTES : TEXT.encode(packet),
    icc: srgbIccProfile(),
  });
  progress(1);
  return bytes;
}
