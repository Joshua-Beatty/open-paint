import type { FileDocument, ProgressReporter } from "@openpaint/extension-api";
import { EXIF_TAG_ARTIST, EXIF_TAG_IMAGE_DESCRIPTION, exifAsciiBytes } from "./exif";
import type { PngImage } from "./png-encoder";
import { choosePngImage } from "./png-pipeline";
import { encodeTgaImage, type TgaContainer } from "./tga-encoder";
import { type TgaSaveOptions, tgaPipelineOptions } from "./tga-options";

const NO_BYTES = new Uint8Array(0);
/** The ASCII substitute for a character outside the field's range. */
const SUBSTITUTE = 0x3f;

/**
 * Encodes a flat document as a TGA (FMT-OPT-TGA-01). The layer is composited over white where it has
 * no alpha. The author and comment fields come from the EXIF Artist and ImageDescription tags. They
 * are left blank when "Remove metadata" is on, and the save date and the "OpenPaint" software ID are
 * always written.
 */
export function encodeTgaFile(
  file: FileDocument,
  options: TgaSaveOptions,
  progress: ProgressReporter,
  savedAt: Date,
): Uint8Array {
  const layer = file.layers[0];
  if (layer === undefined) throw new RangeError("A TGA needs at least one layer.");
  const exif = file.metadata.exif;
  const container: TgaContainer = {
    rle: options.rle,
    author: options.removeMetadata ? NO_BYTES : asciiField(exifAsciiBytes(exif, EXIF_TAG_ARTIST)),
    comment: options.removeMetadata
      ? NO_BYTES
      : asciiField(exifAsciiBytes(exif, EXIF_TAG_IMAGE_DESCRIPTION)),
    date: [
      savedAt.getMonth() + 1,
      savedAt.getDate(),
      savedAt.getFullYear(),
      savedAt.getHours(),
      savedAt.getMinutes(),
      savedAt.getSeconds(),
    ],
  };
  const encode = (image: PngImage) => encodeTgaImage(image, container);
  const image = choosePngImage(layer.surface, tgaPipelineOptions(options), { encode, progress });
  const bytes = encode(image);
  progress(1);
  return bytes;
}

/** Keeps the bytes that are ASCII and replaces the rest, since the TGA text fields are ASCII. */
function asciiField(bytes: Uint8Array): Uint8Array {
  return bytes.map((byte) => (byte < 0x80 ? byte : SUBSTITUTE));
}
