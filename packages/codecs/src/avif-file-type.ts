import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { AVIF_SAVE_SCHEMA, avifIsLossless, avifSaveOptions } from "./avif-options";
import { encodeAvifFile } from "./avif-save";
import { type AvifDecoded, runCodecJob } from "./codec-jobs";
import { DecodeError } from "./errors";
import { srgbPixelsOf } from "./icc-transform";
import { applyExifOrientation } from "./orientation";
import { isAvifBytes } from "./sniff";

const LOAD_FAILED = "The image could not be decoded.";
const TEXT_DECODER = new TextDecoder();

/** Decodes an AVIF file to straight RGBA, with its ICC profile and metadata (WEB-FILE-07). */
export type AvifDecoder = (bytes: Uint8Array) => Promise<AvifDecoded>;

/**
 * Opens an AVIF: the pixels from libavif in the codec worker, converted to sRGB from the file's ICC profile
 * (FMT-META-03), and a one-layer document. The container's EXIF block and XMP packet become the document
 * metadata, and the EXIF orientation is applied and removed (FMT-META-02).
 */
export async function loadAvifFile(
  bytes: Uint8Array,
  decode: AvifDecoder = (data) => runCodecJob("decodeAvif", { bytes: data }),
): Promise<FileDocument> {
  let decoded: AvifDecoded;
  try {
    decoded = await decode(bytes);
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

/** The AVIF codec. Saving runs in the codec worker, and loading decodes there too. */
const avifCodec: FileCodec = {
  async load(source: ByteSource): Promise<FileDocument> {
    return loadAvifFile(await source.readAll());
  },
  async save(file, sink, token, progress): Promise<void> {
    await sink.write(await encodeAvifFile(file, avifSaveOptions(token), progress));
  },
};

/**
 * The built-in AVIF file type (FMT-REG-02 row 5). Only Lossless is reflexive (FMT-REG-06). The save
 * does not report intermediate progress, but it can be canceled at its checkpoints (FMT-REG-06).
 */
export function avifFileType(): FileTypeDescriptor {
  return {
    id: "avif",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.avif",
    icon: "file-avif",
    loadExtensions: [".avif"],
    saveExtensions: [".avif"],
    mimeTypes: ["image/avif"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: false,
      supportsCancellation: true,
    },
    saveOptions: AVIF_SAVE_SCHEMA,
    sniff: isAvifBytes,
    loadCodec: async () => avifCodec,
    isLossless: avifIsLossless,
  };
}
