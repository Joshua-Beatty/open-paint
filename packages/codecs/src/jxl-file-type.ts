import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { type JxlDecoded, runCodecJob } from "./codec-jobs";
import { DecodeError } from "./errors";
import { EXIF_TAG_ORIENTATION, removeExifTag } from "./exif";
import { srgbPixelsOf } from "./icc-transform";
import { JXL_SAVE_SCHEMA, jxlSaveOptions } from "./jxl-options";
import { encodeJxlFile } from "./jxl-save";
import { isJxlBytes } from "./sniff";

const LOAD_FAILED = "The image could not be decoded.";
const TEXT_DECODER = new TextDecoder();

/**
 * Opens a JPEG XL in the codec worker: the first frame, rendered upright by the codestream's own
 * orientation, with its ICC profile converted to sRGB (FMT-META-03). The EXIF Orientation tag is
 * removed without being applied, since the decoder has already applied the codestream orientation
 * and applying both would turn the image twice. The EXIF and XMP boxes become the document metadata.
 */
export async function loadJxlFile(bytes: Uint8Array): Promise<FileDocument> {
  let decoded: JxlDecoded;
  try {
    decoded = await runCodecJob("decodeJxl", { bytes });
  } catch (cause) {
    throw new DecodeError(LOAD_FAILED, cause);
  }
  const { pixels, warnings } = await srgbPixelsOf({
    width: decoded.width,
    height: decoded.height,
    pixels: decoded.pixels,
    pixelsPerMeter: { x: 0, y: 0 },
    ...(decoded.icc.length > 0 ? { icc: decoded.icc } : {}),
  });
  const surface = new Surface(decoded.width, decoded.height, new Uint8ClampedArray(pixels));
  const exif =
    decoded.exif.length > 0 ? removeExifTag(decoded.exif, EXIF_TAG_ORIENTATION) : undefined;
  const xmp = decoded.xmp.length > 0 ? [TEXT_DECODER.decode(decoded.xmp)] : [];
  return {
    width: surface.width,
    height: surface.height,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: { ...(exif === undefined ? {} : { exif }), xmp, user: {} },
    layers: [{ name: "Background", visible: true, opacity: 255, blendMode: 0, surface }],
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The JPEG XL codec. Both directions run in the codec worker, which loads the WASM (WEB-FILE-07). */
const jxlCodec: FileCodec = {
  async load(source: ByteSource): Promise<FileDocument> {
    return loadJxlFile(await source.readAll());
  },
  async save(file, sink, token, progress): Promise<void> {
    await sink.write(await encodeJxlFile(file, jxlSaveOptions(token), progress));
  },
};

/**
 * The built-in JPEG XL file type (FMT-REG-02 row 4). Lossless saves reproduce the image exactly. Lossy
 * saves are reported as lossy, so the Save Configuration preview decodes them (FMT-REG-06, FMT-UI-03).
 * libjxl runs as one call and cannot be interrupted, so cancellation takes effect at the progress
 * checkpoints before and after the encode (EXT-07-01). The save does not report intermediate progress.
 */
export function jxlFileType(): FileTypeDescriptor {
  return {
    id: "jxl",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.jxl",
    icon: "file-jxl",
    loadExtensions: [".jxl"],
    saveExtensions: [".jxl"],
    mimeTypes: ["image/jxl"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: false,
      supportsCancellation: true,
    },
    saveOptions: JXL_SAVE_SCHEMA,
    sniff: isJxlBytes,
    loadCodec: async () => jxlCodec,
    isLossless: (token) => jxlSaveOptions(token).lossless,
  };
}
