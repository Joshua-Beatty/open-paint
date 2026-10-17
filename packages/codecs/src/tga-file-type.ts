import { DEFAULT_RESOLUTION } from "@openpaint/document";
import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { DecodeError } from "./errors";
import { EXIF_TAG_ARTIST, EXIF_TAG_IMAGE_DESCRIPTION, exifFromAsciiTags } from "./exif";
import { rasterDocument } from "./raster-document";
import { decodeTgaImage } from "./tga-encoder";
import { TGA_SAVE_SCHEMA, tgaIsLossless, tgaSaveOptions } from "./tga-options";
import { encodeTgaFile } from "./tga-save";

const LOAD_FAILED = "The image could not be decoded.";
const NO_BYTES = new Uint8Array(0);

/**
 * Opens a TGA: the pixels from the WASM reader. TGA carries no density (FMT-META-01). The author and
 * comment fields become the EXIF Artist and ImageDescription tags, which is how the save writes them.
 */
export function loadTgaFile(bytes: Uint8Array): FileDocument {
  let raster: ReturnType<typeof decodeTgaImage>;
  try {
    raster = decodeTgaImage(bytes);
  } catch (cause) {
    throw new DecodeError(LOAD_FAILED, cause);
  }
  const document = rasterDocument(raster, DEFAULT_RESOLUTION);
  const exif = exifFromAsciiTags([
    { tag: EXIF_TAG_IMAGE_DESCRIPTION, text: raster.comment ?? NO_BYTES },
    { tag: EXIF_TAG_ARTIST, text: raster.author ?? NO_BYTES },
  ]);
  return exif === undefined ? document : { ...document, metadata: { ...document.metadata, exif } };
}

/** The TGA codec. Both directions are WASM, since browsers cannot decode TGA (WEB-FILE-07). */
const tgaCodec: FileCodec = {
  async load(source: ByteSource): Promise<FileDocument> {
    return loadTgaFile(await source.readAll());
  },
  async save(file, sink, token, progress): Promise<void> {
    await sink.write(encodeTgaFile(file, tgaSaveOptions(token), progress, new Date()));
  },
};

/**
 * The built-in TGA file type (FMT-REG-02 row 11). Auto-detect and 32-bit are lossless (FMT-REG-06).
 * The encoder does not report progress, and it cannot be canceled.
 */
export function tgaFileType(): FileTypeDescriptor {
  return {
    id: "tga",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.tga",
    icon: "file-tga",
    loadExtensions: [".tga"],
    saveExtensions: [".tga"],
    mimeTypes: ["image/x-tga"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: false,
      supportsCancellation: false,
    },
    saveOptions: TGA_SAVE_SCHEMA,
    loadCodec: async () => tgaCodec,
    isLossless: tgaIsLossless,
  };
}
