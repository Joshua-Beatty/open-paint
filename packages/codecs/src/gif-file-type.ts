import { DEFAULT_RESOLUTION } from "@openpaint/document";
import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { DecodeError } from "./errors";
import { decodeGifImage } from "./gif-encoder";
import { GIF_SAVE_SCHEMA, gifSaveOptions } from "./gif-options";
import { encodeGifFile } from "./gif-save";
import { quantizePalette } from "./quantize";
import { rasterDocument } from "./raster-document";
import { isGifBytes } from "./sniff";

const LOAD_FAILED = "The image could not be decoded.";

/**
 * Opens a GIF: the first frame only (FMT-META-04), from the WASM reader. GIF has no density or profile,
 * so the pixels are sRGB and the document uses the default resolution.
 */
export function loadGifFile(bytes: Uint8Array): FileDocument {
  let raster: ReturnType<typeof decodeGifImage>;
  try {
    raster = decodeGifImage(bytes);
  } catch (cause) {
    throw new DecodeError(LOAD_FAILED, cause);
  }
  return rasterDocument(raster, DEFAULT_RESOLUTION);
}

/** The GIF codec. Both directions are WASM (WEB-FILE-07). */
const gifCodec: FileCodec = {
  async load(source: ByteSource): Promise<FileDocument> {
    return loadGifFile(await source.readAll());
  },
  async save(file, sink, token, progress): Promise<void> {
    const bytes = encodeGifFile(file, gifSaveOptions(token), progress, quantizePalette);
    await sink.write(bytes);
  },
};

/**
 * The built-in GIF file type (FMT-REG-02 row 9). GIF is never lossless: its palette and threshold
 * change the pixels (FMT-REG-06), so the Save Configuration preview decodes what it wrote.
 */
export function gifFileType(): FileTypeDescriptor {
  return {
    id: "gif",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.gif",
    icon: "file-gif",
    loadExtensions: [".gif"],
    saveExtensions: [".gif"],
    mimeTypes: ["image/gif"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: true,
      supportsCancellation: false,
    },
    saveOptions: GIF_SAVE_SCHEMA,
    sniff: isGifBytes,
    loadCodec: async () => gifCodec,
    isLossless: () => false,
  };
}
