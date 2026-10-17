import { convertResolution, type Resolution, type Surface } from "@openpaint/document";
import type { DocumentMetadata, FileDocument, ProgressReporter } from "@openpaint/extension-api";
import { encodeJpegImage, type JpegContainer, type JpegImage } from "./jpeg-encoder";
import type { JpegSaveOptions } from "./jpeg-options";
import { srgbIccProfile } from "./srgb-profile";

const TEXT = new TextEncoder();
/** The longest body of one APP segment (the 16-bit length less its own two bytes). */
const MAX_SEGMENT_BODY = 65_533;
/** The bytes an APP segment adds before its data: `Exif\0\0`, the XMP namespace, the IPTC wrapper. */
const EXIF_PREFIX = 6;
const XMP_PREFIX = 29;
const IPTC_PREFIX = 27;
const MAX_DPI = 65_535;

/**
 * Encodes a flat document as a JPEG (FMT-OPT-JPG-01, FMT-META-05). The layer is flattened over white
 * (FMT-QNT-03), and the sRGB profile is embedded (APP2). The EXIF, XMP and IPTC metadata are written
 * unless "Remove metadata" is on. A metadata item too large for one APP segment is left out, so the
 * rest of the file still saves.
 */
export function encodeJpegFile(
  file: FileDocument,
  options: JpegSaveOptions,
  progress: ProgressReporter,
): Uint8Array {
  const layer = file.layers[0];
  if (layer === undefined) throw new RangeError("A JPEG needs at least one layer.");
  const container: JpegContainer = {
    quality: options.quality,
    sampling: options.chromaSubsampling,
    dpi: dotsPerInch(file.resolution),
    icc: srgbIccProfile(),
    ...(options.removeMetadata ? { xmp: [] } : keptMetadata(file.metadata)),
  };
  const image: JpegImage = {
    width: layer.surface.width,
    height: layer.surface.height,
    rgb: flattenOverWhite(layer.surface),
  };
  const bytes = encodeJpegImage(image, container);
  progress(1);
  return bytes;
}

/** The metadata items that fit an APP segment, in the form the container writes them. */
function keptMetadata(metadata: DocumentMetadata): Pick<JpegContainer, "exif" | "xmp" | "iptc"> {
  const exif = metadata.exif;
  const iptc = metadata.iptc;
  const xmp = metadata.xmp.map((packet) => TEXT.encode(packet));
  return {
    ...(exif !== undefined && exif.length + EXIF_PREFIX <= MAX_SEGMENT_BODY ? { exif } : {}),
    xmp: xmp.filter((packet) => packet.length + XMP_PREFIX <= MAX_SEGMENT_BODY),
    ...(iptc !== undefined && iptc.length + IPTC_PREFIX <= MAX_SEGMENT_BODY ? { iptc } : {}),
  };
}

/**
 * The image over white, as RGB (FMT-QNT-03): each channel is `c * a + 255 * (1 - a)` with alpha `a`.
 * The division rounds to nearest, so an opaque pixel keeps its exact value.
 */
export function flattenOverWhite(surface: Surface): Uint8Array {
  const { data } = surface;
  const rgb = new Uint8Array(new ArrayBuffer((data.length / 4) * 3));
  for (let from = 0, to = 0; from < data.length; from += 4, to += 3) {
    const alpha = data[from + 3] ?? 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const color = data[from + channel] ?? 0;
      rgb[to + channel] = Math.floor((color * alpha + 255 * (255 - alpha) + 127) / 255);
    }
  }
  return rgb;
}

/** The JFIF density in dots per inch. A pixel unit has no physical size, so it writes none. */
export function dotsPerInch(resolution: Resolution): { x: number; y: number } {
  if (resolution.unit === "pixel") return { x: 0, y: 0 };
  const inches = convertResolution(resolution, "inch");
  return { x: clampDpi(inches.x), y: clampDpi(inches.y) };
}

function clampDpi(value: number): number {
  return Math.min(MAX_DPI, Math.max(1, Math.round(value)));
}
