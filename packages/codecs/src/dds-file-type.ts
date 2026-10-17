import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { definePropertySchema } from "@openpaint/properties";
import { type DdsDecoded, runCodecJob } from "./codec-jobs";
import { DecodeError } from "./errors";
import { isDdsBytes } from "./sniff";

const LOAD_FAILED = "The image could not be decoded.";

/**
 * Opens a DDS texture in the codec worker: its top mip level, as straight RGBA. DDS carries no color
 * profile, so the pixels are taken as sRGB, as the other formats without one are. The file has no
 * metadata, and the document gets the default resolution.
 */
export async function loadDdsFile(bytes: Uint8Array): Promise<FileDocument> {
  let decoded: DdsDecoded;
  try {
    decoded = await runCodecJob("decodeDds", { bytes });
  } catch (cause) {
    throw new DecodeError(LOAD_FAILED, cause);
  }
  const surface = new Surface(decoded.width, decoded.height, new Uint8ClampedArray(decoded.pixels));
  return {
    width: surface.width,
    height: surface.height,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: { xmp: [], user: {} },
    layers: [{ name: "Background", visible: true, opacity: 255, blendMode: 0, surface }],
  };
}

/** The DDS codec. Decoding runs in the codec worker, which loads the WASM (WEB-FILE-07). */
const ddsCodec: FileCodec = {
  async load(source: ByteSource): Promise<FileDocument> {
    return loadDdsFile(await source.readAll());
  },
  async save(): Promise<void> {
    throw new Error("DDS files cannot be saved.");
  },
};

/**
 * The built-in DDS file type (FMT-REG-02 row 7). It is open only: it has no save extensions, so it
 * stays out of the Save As list (FMT-REG-07). Its save options are empty, and it is never lossless.
 */
export function ddsFileType(): FileTypeDescriptor {
  return {
    id: "dds",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.dds",
    icon: "file-dds",
    loadExtensions: [".dds"],
    saveExtensions: [],
    mimeTypes: ["image/vnd.ms-dds"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: false,
      supportsLoading: true,
      savesWithProgress: false,
      supportsCancellation: false,
    },
    saveOptions: definePropertySchema({ properties: [] }),
    sniff: isDdsBytes,
    loadCodec: async () => ddsCodec,
    isLossless: () => false,
  };
}
