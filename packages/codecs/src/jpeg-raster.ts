import { decode_jpeg } from "@openpaint/cpu";
import { DecodeError } from "./errors";

/** A JPEG in the channels of the file: gray (1), RGB (3) or CMYK ink (4), 8 bits per channel. */
export interface JpegSamples {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 3 | 4;
  readonly samples: Uint8Array;
}

/**
 * Decodes a JPEG into its own channels, without converting them, so the color engine can convert an
 * embedded profile or CMYK (FMT-META-03). Every JPEG is decoded this way (WEB-FILE-07).
 */
export function decodeJpegSamples(bytes: Uint8Array): JpegSamples {
  let raster: ReturnType<typeof decode_jpeg>;
  try {
    raster = decode_jpeg(bytes);
  } catch (cause) {
    throw new DecodeError("The JPEG could not be decoded.", cause);
  }
  try {
    const channels = raster.channels;
    if (channels !== 1 && channels !== 3 && channels !== 4) {
      throw new DecodeError(`Unsupported JPEG channel count ${channels}.`);
    }
    return {
      width: raster.width,
      height: raster.height,
      channels,
      samples: raster.samples,
    };
  } finally {
    raster.free();
  }
}
