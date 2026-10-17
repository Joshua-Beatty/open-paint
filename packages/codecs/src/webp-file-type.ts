import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { runCodecJob, type WebpDecoded } from "./codec-jobs";
import { DecodeError } from "./errors";
import { srgbPixelsOf } from "./icc-transform";
import { applyExifOrientation } from "./orientation";
import { isWebpBytes } from "./sniff";
import { WEBP_SAVE_SCHEMA, webpIsLossless, webpSaveOptions } from "./webp-options";
import { encodeWebpFile } from "./webp-save";

const LOAD_FAILED = "The image could not be decoded.";
const TEXT_DECODER = new TextDecoder();

/**
 * Opens a WebP in the codec worker: the first frame of an animation (FMT-META-04), with its ICC
 * profile converted to sRGB (FMT-META-03) and its EXIF orientation applied (FMT-META-02). The EXIF
 * and XMP chunks become the document metadata. WebP has no density, so the default applies.
 */
export async function loadWebpFile(bytes: Uint8Array): Promise<FileDocument> {
  let decoded: WebpDecoded;
  try {
    decoded = await runCodecJob("decodeWebp", { bytes });
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
  const upright = applyExifOrientation(surface, decoded.exif.length > 0 ? decoded.exif : undefined);
  const exif = upright.exif;
  const xmp = decoded.xmp.length > 0 ? [TEXT_DECODER.decode(decoded.xmp)] : [];
  return {
    width: upright.surface.width,
    height: upright.surface.height,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: { ...(exif === undefined ? {} : { exif }), xmp, user: {} },
    layers: [
      { name: "Background", visible: true, opacity: 255, blendMode: 0, surface: upright.surface },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** The WebP codec. Both directions run in the codec worker, which loads the WASM (WEB-FILE-07). */
const webpCodec: FileCodec = {
  async load(source: ByteSource): Promise<FileDocument> {
    return loadWebpFile(await source.readAll());
  },
  async save(file, sink, token, progress): Promise<void> {
    await sink.write(await encodeWebpFile(file, webpSaveOptions(token), progress));
  },
};

/**
 * The built-in WebP file type (FMT-REG-02 row 6). Lossless is the only reflexive setting (FMT-REG-06).
 * The encoder does not report progress, and it cannot be canceled.
 */
export function webpFileType(): FileTypeDescriptor {
  return {
    id: "webp",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.webp",
    icon: "file-webp",
    loadExtensions: [".webp"],
    saveExtensions: [".webp"],
    mimeTypes: ["image/webp"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: false,
      supportsCancellation: false,
    },
    saveOptions: WEBP_SAVE_SCHEMA,
    sniff: isWebpBytes,
    loadCodec: async () => webpCodec,
    isLossless: webpIsLossless,
  };
}
