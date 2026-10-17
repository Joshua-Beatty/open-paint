import { Surface } from "@openpaint/document";
import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { DecodeError } from "./errors";
import { cmykPixelsOf, srgbPixelsOf } from "./icc-transform";
import { applyExifOrientation } from "./orientation";
import { quantizePalette } from "./quantize";
import { resolutionFromPixelsPerMeter } from "./raster-document";
import { isTiffBytes } from "./sniff";
import { type DecodedTiff, decodeTiffImage } from "./tiff-encoder";
import { TIFF_SAVE_SCHEMA, tiffIsLossless, tiffSaveOptions } from "./tiff-options";
import { encodeTiffFile } from "./tiff-save";

const LOAD_FAILED = "The image could not be decoded.";
const TEXT_DECODER = new TextDecoder();

/**
 * Opens a TIFF: the first page only (FMT-META-04), from the WASM reader. The embedded profile is converted
 * to sRGB when it needs it, and a CMYK page is converted from its ink (FMT-META-03). The EXIF orientation
 * is applied (FMT-META-02). The density
 * comes from the resolution tags, and the XMP packet and the IFD0 entries become the document metadata.
 */
export async function loadTiffFile(bytes: Uint8Array): Promise<FileDocument> {
  let raster: DecodedTiff;
  try {
    raster = decodeTiffImage(bytes);
  } catch (cause) {
    throw new DecodeError(LOAD_FAILED, cause);
  }
  const { pixels, warnings } = raster.cmyk
    ? await cmykPixelsOf(raster.pixels, raster.icc)
    : await srgbPixelsOf(raster);
  const surface = new Surface(raster.width, raster.height, new Uint8ClampedArray(pixels));
  const upright = applyExifOrientation(surface, raster.exif.length > 0 ? raster.exif : undefined);
  const exif = upright.exif;
  const xmp = raster.xmp.length > 0 ? [TEXT_DECODER.decode(raster.xmp)] : [];
  return {
    width: upright.surface.width,
    height: upright.surface.height,
    resolution: resolutionFromPixelsPerMeter(raster.pixelsPerMeter),
    colorProfile: "srgb",
    metadata: { ...(exif === undefined ? {} : { exif }), xmp, user: {} },
    layers: [
      { name: "Background", visible: true, opacity: 255, blendMode: 0, surface: upright.surface },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The TIFF codec. Both directions are WASM (WEB-FILE-07). */
const tiffCodec: FileCodec = {
  async load(source: ByteSource): Promise<FileDocument> {
    return loadTiffFile(await source.readAll());
  },
  async save(file, sink, token, progress): Promise<void> {
    const bytes = encodeTiffFile(file, tiffSaveOptions(token), progress, quantizePalette);
    await sink.write(bytes);
  },
};

/**
 * The built-in TIFF file type (FMT-REG-02 row 8). Auto-detect and 32-bit are lossless (FMT-REG-06). The
 * writer uses LZW with the horizontal predictor (FMT-OPT-TIF-01).
 */
export function tiffFileType(): FileTypeDescriptor {
  return {
    id: "tiff",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.tiff",
    icon: "file-tiff",
    loadExtensions: [".tif", ".tiff"],
    saveExtensions: [".tif", ".tiff"],
    mimeTypes: ["image/tiff"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: true,
      supportsCancellation: false,
    },
    saveOptions: TIFF_SAVE_SCHEMA,
    sniff: isTiffBytes,
    loadCodec: async () => tiffCodec,
    isLossless: tiffIsLossless,
  };
}
