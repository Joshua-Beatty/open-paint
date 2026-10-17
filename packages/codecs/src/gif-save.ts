import type { FileDocument, ProgressReporter } from "@openpaint/extension-api";
import { encodeGifImage, type GifContainer } from "./gif-encoder";
import { type GifSaveOptions, gifPipelineOptions } from "./gif-options";
import type { PngImage } from "./png-encoder";
import { choosePngImage, type PaletteQuantizer } from "./png-pipeline";

const TEXT = new TextEncoder();
const NO_BYTES = new Uint8Array(0);

/**
 * Encodes a flat document as a GIF (FMT-OPT-GIF-01, FMT-QNT-01). The layer is the flattened image, with
 * an 8-bit palette and the transparency threshold. Only the first XMP packet is written, in an
 * application extension, and only when "Remove metadata" is off. GIF has no profile or density field.
 */
export function encodeGifFile(
  file: FileDocument,
  options: GifSaveOptions,
  progress: ProgressReporter,
  quantize?: PaletteQuantizer,
): Uint8Array {
  const layer = file.layers[0];
  if (layer === undefined) throw new RangeError("A GIF needs at least one layer.");
  const packet = options.removeMetadata ? undefined : file.metadata.xmp[0];
  const container: GifContainer = {
    xmp: packet === undefined ? NO_BYTES : TEXT.encode(packet),
  };
  const encode = (image: PngImage) => encodeGifImage(image, container);
  const image = choosePngImage(layer.surface, gifPipelineOptions(options), {
    encode,
    progress,
    ...(quantize === undefined ? {} : { quantize }),
  });
  const bytes = encode(image);
  progress(1);
  return bytes;
}
