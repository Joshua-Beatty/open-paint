import type { FileDocument, ProgressReporter } from "@openpaint/extension-api";
import { type BmpContainer, encodeBmpImage } from "./bmp-encoder";
import { type BmpSaveOptions, bmpPipelineOptions } from "./bmp-options";
import type { PngImage } from "./png-encoder";
import { choosePngImage, type PaletteQuantizer } from "./png-pipeline";
import { pixelsPerMeter } from "./png-save";
import { srgbIccProfile } from "./srgb-profile";

const NO_BYTES = new Uint8Array(0);

/**
 * Encodes a flat document as a BMP (FMT-OPT-BMP-01, FMT-QNT-01). The layer is composited over white
 * where the depth has no alpha, and the indexed depths use the palette hook. The sRGB profile is
 * embedded only when `embedColorProfile` is on, which is the hidden "Embed color profiles in BMP"
 * setting.
 */
export function encodeBmpFile(
  file: FileDocument,
  options: BmpSaveOptions,
  progress: ProgressReporter,
  embedColorProfile: boolean,
  quantize?: PaletteQuantizer,
): Uint8Array {
  const layer = file.layers[0];
  if (layer === undefined) throw new RangeError("A BMP needs at least one layer.");
  const container: BmpContainer = {
    icc: embedColorProfile ? srgbIccProfile() : NO_BYTES,
    pixelsPerMeter: pixelsPerMeter(file.resolution),
  };
  const encode = (image: PngImage) => encodeBmpImage(image, container);
  const image = choosePngImage(layer.surface, bmpPipelineOptions(options), {
    encode,
    progress,
    ...(quantize === undefined ? {} : { quantize }),
  });
  const bytes = encode(image);
  progress(1);
  return bytes;
}
