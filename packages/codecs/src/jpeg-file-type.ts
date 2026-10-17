import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { DecodeError } from "./errors";
import { cmykPixelsOf, srgbPixelsOf } from "./icc-transform";
import { readJpegMetadata } from "./jpeg-metadata";
import { JPEG_SAVE_SCHEMA, jpegSaveOptions } from "./jpeg-options";
import { decodeJpegSamples, type JpegSamples } from "./jpeg-raster";
import { encodeJpegFile } from "./jpeg-save";
import { applyExifOrientation } from "./orientation";
import { isJpegBytes } from "./sniff";

const LOAD_FAILED = "The image could not be decoded.";
/** The frame component count of a CMYK (or YCCK) JPEG. */
const CMYK_COMPONENTS = 4;

/** The pixels of a JPEG in sRGB, with the warnings their conversion raised. */
interface DecodedJpeg {
  readonly surface: Surface;
  readonly warnings: readonly string[];
}

/**
 * Opens a JPEG: the pixels in sRGB, upright per the EXIF Orientation (FMT-META-02), and the metadata
 * and density from the file. The browser's own orientation is off, so it is applied once. Every JPEG is
 * decoded in WASM (WEB-FILE-07) to its own channels. An embedded profile, or CMYK ink, is converted by the
 * color engine (FMT-META-03). Other pixels are sRGB already.
 */
export async function loadJpegFile(
  bytes: Uint8Array,
  decodeSamples: (bytes: Uint8Array) => JpegSamples = decodeJpegSamples,
): Promise<FileDocument> {
  const metadata = readJpegMetadata(bytes);
  let decoded: DecodedJpeg;
  try {
    decoded = await decodeToSrgb(bytes, metadata.icc, decodeSamples);
  } catch (cause) {
    if (cause instanceof DecodeError) throw cause;
    throw new DecodeError(LOAD_FAILED, cause);
  }
  const upright = applyExifOrientation(decoded.surface, metadata.exif);
  const { exif } = upright;
  return {
    width: upright.surface.width,
    height: upright.surface.height,
    resolution: metadata.resolution ?? DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: {
      ...(exif === undefined ? {} : { exif }),
      xmp: metadata.xmp,
      ...(metadata.iptc === undefined ? {} : { iptc: metadata.iptc }),
      user: {},
    },
    layers: [
      { name: "Background", visible: true, opacity: 255, blendMode: 0, surface: upright.surface },
    ],
    ...(decoded.warnings.length > 0 ? { warnings: decoded.warnings } : {}),
  };
}

/** Decodes to the file's channels, then converts to sRGB with the embedded profile or the CMYK default. */
async function decodeToSrgb(
  bytes: Uint8Array,
  icc: Uint8Array | undefined,
  decodeSamples: (bytes: Uint8Array) => JpegSamples,
): Promise<DecodedJpeg> {
  const raster = decodeSamples(bytes);
  const { pixels, warnings } =
    raster.channels === CMYK_COMPONENTS
      ? await cmykPixelsOf(raster.samples, icc)
      : await srgbPixelsOf({
          width: raster.width,
          height: raster.height,
          pixels: toRgba(raster.samples, raster.channels),
          pixelsPerMeter: { x: 0, y: 0 },
          ...(icc === undefined ? {} : { icc }),
        });
  return {
    surface: new Surface(raster.width, raster.height, new Uint8ClampedArray(pixels)),
    warnings,
  };
}

/** Straight RGBA from gray or RGB samples, with opaque alpha. */
function toRgba(samples: Uint8Array, channels: 1 | 3): Uint8Array {
  const pixelCount = samples.length / channels;
  const out = new Uint8Array(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      out[pixel * 4 + channel] = samples[pixel * channels + Math.min(channel, channels - 1)] ?? 0;
    }
    out[pixel * 4 + 3] = 255;
  }
  return out;
}

/** The JPEG codec. Saving is the WASM encoder over the flattened image (FMT-QNT-03). */
const jpegCodec: FileCodec = {
  async load(source: ByteSource): Promise<FileDocument> {
    return loadJpegFile(await source.readAll());
  },
  async save(file, sink, token, progress): Promise<void> {
    await sink.write(encodeJpegFile(file, jpegSaveOptions(token), progress));
  },
};

/**
 * The built-in JPEG file type (FMT-REG-02 row 3). JPEG is lossy, so a save is never reflexive
 * (FMT-REG-06). The encoder does not report progress, and it cannot be canceled.
 */
export function jpegFileType(): FileTypeDescriptor {
  return {
    id: "jpeg",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.jpeg",
    icon: "file-jpeg",
    loadExtensions: [".jpg", ".jpeg", ".jpe", ".jfif"],
    saveExtensions: [".jpg", ".jpeg", ".jpe", ".jfif"],
    mimeTypes: ["image/jpeg"],
    capabilities: {
      supportsLayers: false,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: false,
      supportsCancellation: false,
    },
    saveOptions: JPEG_SAVE_SCHEMA,
    sniff: isJpegBytes,
    loadCodec: async () => jpegCodec,
    isLossless: () => false,
  };
}
