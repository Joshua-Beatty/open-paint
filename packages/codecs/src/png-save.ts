import { convertResolution, type Resolution } from "@openpaint/document";
import type { FileDocument, ProgressReporter } from "@openpaint/extension-api";
import { encodePngImage, type PngContainer, type PngImage } from "./png-encoder";
import { type PngSaveOptions, pngPipelineOptions } from "./png-options";
import { choosePngImage, type PaletteQuantizer } from "./png-pipeline";

const TEXT = new TextEncoder();
const CENTIMETERS_PER_METER = 100;

/**
 * Encodes a flat document as a PNG (FMT-OPT-PNG-01, FMT-QNT-01, FMT-META-05). The layer is the
 * flattened image. The EXIF and XMP metadata are written unless "Remove metadata" is on. The sRGB
 * profile and the resolution are always written. `quantize` is the palette hook for lossy palettes.
 */
export function encodePngFile(
  file: FileDocument,
  options: PngSaveOptions,
  progress: ProgressReporter,
  quantize?: PaletteQuantizer,
): Uint8Array {
  const layer = file.layers[0];
  if (layer === undefined) throw new RangeError("A PNG needs at least one layer.");
  const exif = options.removeMetadata ? undefined : file.metadata.exif;
  const container: PngContainer = {
    interlaced: options.interlaced,
    xmp: options.removeMetadata ? [] : file.metadata.xmp.map((packet) => TEXT.encode(packet)),
    ...(exif === undefined ? {} : { exif }),
    pixelsPerMeter: pixelsPerMeter(file.resolution),
  };
  const encode = (image: PngImage) => encodePngImage(image, container);
  const image = choosePngImage(layer.surface, pngPipelineOptions(options), {
    encode,
    progress,
    ...(quantize === undefined ? {} : { quantize }),
  });
  const bytes = encode(image);
  progress(1);
  return bytes;
}

/** The pHYs resolution in pixels per meter. A pixel-unit resolution has no physical size. */
export function pixelsPerMeter(resolution: Resolution): { x: number; y: number } {
  if (resolution.unit === "pixel") return { x: 0, y: 0 };
  const centimeters = convertResolution(resolution, "centimeter");
  return {
    x: Math.round(centimeters.x * CENTIMETERS_PER_METER),
    y: Math.round(centimeters.y * CENTIMETERS_PER_METER),
  };
}
