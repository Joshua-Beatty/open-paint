import type { FileDocument, ProgressReporter } from "@openpaint/extension-api";
import { runCodecJob } from "./codec-jobs";
import type { JxlSaveOptions } from "./jxl-options";
import { straightRgba } from "./raster-document";

const TEXT = new TextEncoder();
const NO_BYTES = new Uint8Array(0);

/**
 * Encodes a flat document as a JPEG XL (FMT-META-05, FMT-OPT-JXL-01) in the codec worker. libjxl writes
 * the codestream at the chosen quality and effort, or losslessly, and the EXIF and XMP boxes are written
 * unless "Remove metadata" is on. Only the first XMP packet is written. The sRGB profile is implied by
 * JPEG XL, so no ICC box is written. The progress reporter is called before the encode and after it, so
 * a superseded save can stop at either point (FMT-REG-06 cancellation).
 */
export async function encodeJxlFile(
  file: FileDocument,
  options: JxlSaveOptions,
  progress: ProgressReporter,
): Promise<Uint8Array> {
  const layer = file.layers[0];
  if (layer === undefined) throw new RangeError("A JPEG XL needs at least one layer.");
  const exif = options.removeMetadata ? undefined : file.metadata.exif;
  const packet = options.removeMetadata ? undefined : file.metadata.xmp[0];
  progress(0);
  const bytes = await runCodecJob("encodeJxl", {
    width: layer.surface.width,
    height: layer.surface.height,
    rgba: straightRgba(layer.surface),
    lossless: options.lossless,
    quality: options.quality,
    effort: options.effort,
    exif: exif ?? NO_BYTES,
    xmp: packet === undefined ? NO_BYTES : TEXT.encode(packet),
  });
  progress(1);
  return bytes;
}
