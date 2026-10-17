import { encode_jpeg } from "@openpaint/cpu";
import { joinPackets } from "./png-encoder";

/** The chroma subsampling choices (FMT-OPT-JPG-01), by their option value. */
export type JpegSampling = "444" | "440" | "422" | "420";

const SAMPLING_IDS: Record<JpegSampling, number> = { "444": 0, "440": 1, "422": 2, "420": 3 };
const NO_BYTES = new Uint8Array(0);

/** A flattened image as RGB, three bytes per pixel. JPEG has no alpha channel. */
export interface JpegImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

/** The encoder settings and the container parts that do not depend on the pixels. */
export interface JpegContainer {
  /** 0 to 100, passed to the encoder as quality/100 (FMT-OPT-JPG-01). */
  readonly quality: number;
  readonly sampling: JpegSampling;
  /** Dots per inch on each axis. Zero on either axis writes no density. */
  readonly dpi: { readonly x: number; readonly y: number };
  /** The sRGB ICC profile, written as APP2. */
  readonly icc: Uint8Array;
  /** TIFF-structured EXIF, without the `Exif\0\0` prefix, written as APP1. */
  readonly exif?: Uint8Array;
  /** XMP packets, each an APP1 segment. */
  readonly xmp: readonly Uint8Array[];
  /** IPTC-IIM records, written as APP13. */
  readonly iptc?: Uint8Array;
}

/** Writes a baseline JFIF file (the WASM encoder, jpeg-encoder). */
export function encodeJpegImage(image: JpegImage, container: JpegContainer): Uint8Array {
  return encode_jpeg(
    image.width,
    image.height,
    image.rgb,
    container.quality,
    SAMPLING_IDS[container.sampling],
    container.dpi.x,
    container.dpi.y,
    container.icc,
    container.exif ?? NO_BYTES,
    joinPackets(container.xmp),
    container.iptc ?? NO_BYTES,
  );
}
