import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { decodeBmpImage } from "./bmp-encoder";
import { BMP_SAVE_SCHEMA, bmpIsLossless, bmpSaveOptions } from "./bmp-options";
import { encodeBmpFile } from "./bmp-save";
import { DecodeError } from "./errors";
import { srgbPixelsOf } from "./icc-transform";
import { quantizePalette } from "./quantize";
import { rasterDocument, resolutionFromPixelsPerMeter } from "./raster-document";
import { isBmpBytes } from "./sniff";

const LOAD_FAILED = "The image could not be decoded.";

/**
 * Opens a BMP: the pixels and density from the WASM reader (FMT-META-01), converted to sRGB when an
 * embedded profile needs it (FMT-META-03).
 */
export async function loadBmpFile(bytes: Uint8Array): Promise<FileDocument> {
  let raster: ReturnType<typeof decodeBmpImage>;
  try {
    raster = decodeBmpImage(bytes);
  } catch (cause) {
    throw new DecodeError(LOAD_FAILED, cause);
  }
  const { pixels, warnings } = await srgbPixelsOf(raster);
  return {
    ...rasterDocument({ ...raster, pixels }, resolutionFromPixelsPerMeter(raster.pixelsPerMeter)),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The BMP codec. Both directions are WASM (WEB-FILE-07). */
function bmpCodec(embedColorProfiles: () => boolean): FileCodec {
  return {
    async load(source: ByteSource): Promise<FileDocument> {
      return loadBmpFile(await source.readAll());
    },
    async save(file, sink, token, progress): Promise<void> {
      const bytes = encodeBmpFile(
        file,
        bmpSaveOptions(token),
        progress,
        embedColorProfiles(),
        quantizePalette,
      );
      await sink.write(bytes);
    },
  };
}

/**
 * The built-in Bitmap (BMP) file type (FMT-REG-02 row 10). Its save is lossless only with Auto-detect
 * or 32-bit (FMT-REG-06). The save reports progress through the palette pipeline.
 */
export function bmpFileType(embedColorProfiles: () => boolean = () => false): FileTypeDescriptor {
  return {
    id: "bmp",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.bmp",
    icon: "file-bmp",
    loadExtensions: [".bmp", ".dib", ".rle"],
    saveExtensions: [".bmp"],
    mimeTypes: ["image/bmp"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: true,
      supportsCancellation: false,
    },
    saveOptions: BMP_SAVE_SCHEMA,
    sniff: isBmpBytes,
    loadCodec: async () => bmpCodec(embedColorProfiles),
    isLossless: bmpIsLossless,
  };
}
