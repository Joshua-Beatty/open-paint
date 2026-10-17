import type { FileDocument, ProgressReporter } from "@openpaint/extension-api";
import type { PngImage } from "./png-encoder";
import { choosePngImage, type PaletteQuantizer } from "./png-pipeline";
import { pixelsPerMeter } from "./png-save";
import { srgbIccProfile } from "./srgb-profile";
import { encodeTiffImage, type TiffContainer } from "./tiff-encoder";
import { type TiffSaveOptions, tiffPipelineOptions } from "./tiff-options";

const TEXT = new TextEncoder();
const NO_BYTES = new Uint8Array(0);

/**
 * Encodes a flat document as a TIFF (FMT-OPT-TIF-01, FMT-QNT-01, FMT-META-05). The layer is composited
 * over white where the depth has no alpha, and the indexed depths use the palette hook. The sRGB profile
 * and the density are always written. The EXIF and XMP metadata are written unless "Remove metadata" is
 * on. Only the first XMP packet is written.
 */
export function encodeTiffFile(
  file: FileDocument,
  options: TiffSaveOptions,
  progress: ProgressReporter,
  quantize?: PaletteQuantizer,
): Uint8Array {
  const layer = file.layers[0];
  if (layer === undefined) throw new RangeError("A TIFF needs at least one layer.");
  const exif = options.removeMetadata ? undefined : file.metadata.exif;
  const packet = options.removeMetadata ? undefined : file.metadata.xmp[0];
  const container: TiffContainer = {
    icc: srgbIccProfile(),
    exif: exif ?? NO_BYTES,
    xmp: packet === undefined ? NO_BYTES : TEXT.encode(packet),
    pixelsPerMeter: pixelsPerMeter(file.resolution),
  };
  const encode = (image: PngImage) => encodeTiffImage(image, container);
  const image = choosePngImage(layer.surface, tiffPipelineOptions(options), {
    encode,
    progress,
    ...(quantize === undefined ? {} : { quantize }),
  });
  const bytes = encode(image);
  progress(1);
  return bytes;
}
