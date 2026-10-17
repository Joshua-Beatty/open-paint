import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { DecodeError } from "./errors";
import { srgbPixelsOf } from "./icc-transform";
import { applyExifOrientation } from "./orientation";
import { readPngMetadata } from "./png-metadata";
import { PNG_SAVE_SCHEMA, pngIsLossless, pngSaveOptions } from "./png-options";
import { decodePngPixels } from "./png-raster";
import { encodePngFile } from "./png-save";
import { quantizePalette } from "./quantize";
import { isPngBytes } from "./sniff";

const LOAD_FAILED = "The image could not be decoded.";

/** The pixels of a PNG in sRGB, with the warnings their conversion raised. */
interface DecodedPng {
  readonly surface: Surface;
  readonly warnings: readonly string[];
}

/**
 * The PNG codec. Every PNG is decoded in WASM (WEB-FILE-07), and its embedded profile, if any, is converted
 * by the color engine (FMT-META-03, WEB-COL-01). The EXIF and XMP chunks are read directly. Saving is the
 * WASM encoder with the FMT-QNT pipeline.
 */
const pngCodec: FileCodec = {
  async load(source: ByteSource): Promise<FileDocument> {
    const bytes = await source.readAll();
    const metadata = await readPngMetadata(bytes);
    const decoded = await decodeToSrgb(bytes, metadata.icc);
    const upright = applyExifOrientation(decoded.surface, metadata.exif);
    const { exif } = upright;
    return {
      width: upright.surface.width,
      height: upright.surface.height,
      resolution: DEFAULT_RESOLUTION,
      colorProfile: "srgb",
      metadata: { ...(exif === undefined ? {} : { exif }), xmp: metadata.xmp, user: {} },
      layers: [
        { name: "Background", visible: true, opacity: 255, blendMode: 0, surface: upright.surface },
      ],
      ...(decoded.warnings.length > 0 ? { warnings: decoded.warnings } : {}),
    };
  },
  async save(file, sink, token, progress): Promise<void> {
    const bytes = encodePngFile(file, pngSaveOptions(token), progress, quantizePalette);
    await sink.write(bytes);
  },
};

/** Decodes to RGBA in WASM, then converts it from the embedded profile to sRGB if it has one. */
async function decodeToSrgb(bytes: Uint8Array, icc: Uint8Array | undefined): Promise<DecodedPng> {
  try {
    const raster = decodePngPixels(bytes);
    const { pixels, warnings } = await srgbPixelsOf({
      width: raster.width,
      height: raster.height,
      pixels: raster.pixels,
      pixelsPerMeter: { x: 0, y: 0 },
      ...(icc === undefined ? {} : { icc }),
    });
    return {
      surface: new Surface(raster.width, raster.height, new Uint8ClampedArray(pixels)),
      warnings,
    };
  } catch (cause) {
    if (cause instanceof DecodeError) throw cause;
    throw new DecodeError(LOAD_FAILED, cause);
  }
}

/** The built-in PNG file type (FMT-REG-02 row 2). Its codec is lazy-loaded on first use. */
export function pngFileType(): FileTypeDescriptor {
  return {
    id: "png",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.png",
    icon: "file-png",
    loadExtensions: [".png"],
    saveExtensions: [".png"],
    mimeTypes: ["image/png"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: true,
      supportsCancellation: false,
    },
    saveOptions: PNG_SAVE_SCHEMA,
    sniff: isPngBytes,
    loadCodec: async () => pngCodec,
    isLossless: pngIsLossless,
  };
}
