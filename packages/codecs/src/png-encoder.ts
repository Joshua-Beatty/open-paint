import { encode_png } from "@openpaint/cpu";
import { srgbIccProfile } from "./srgb-profile";

/** The output depths (FMT-OPT-PNG-01): 32 and 24 bit, or an indexed depth of 8, 4, 2 or 1 bits. */
export type PngDepth = 32 | 24 | 8 | 4 | 2 | 1;

/** A prepared image: the pixels the encoder writes, after the depth decisions (FMT-QNT-01). */
export interface PngImage {
  readonly width: number;
  readonly height: number;
  readonly depth: PngDepth;
  /** Straight RGBA (32), RGB (24), or one palette index per pixel for the indexed depths. */
  readonly pixels: Uint8Array;
  /** RGB triples, for the indexed depths. */
  readonly palette: Uint8Array;
  /** One alpha value per palette entry (tRNS). Empty when every entry is opaque. */
  readonly alpha: Uint8Array;
}

/** Container parts that do not depend on the pixels. */
export interface PngContainer {
  readonly interlaced: boolean;
  /** TIFF-structured EXIF (eXIf). Omitted when metadata is removed. */
  readonly exif?: Uint8Array;
  /** XMP packets in order, each an iTXt chunk. */
  readonly xmp: readonly Uint8Array[];
  /** Pixels per meter for pHYs. Zero on either axis omits the chunk. */
  readonly pixelsPerMeter: { readonly x: number; readonly y: number };
}

const NO_BYTES = new Uint8Array(0);

/** Writes a PNG file with the sRGB profile (iCCP), the container parts, and the prepared pixels. */
export function encodePngImage(image: PngImage, container: PngContainer): Uint8Array {
  const packets = joinPackets(container.xmp);
  return encode_png(
    image.width,
    image.height,
    image.pixels,
    image.depth,
    image.palette,
    image.alpha,
    container.interlaced,
    srgbIccProfile(),
    container.exif ?? NO_BYTES,
    packets,
    container.pixelsPerMeter.x,
    container.pixelsPerMeter.y,
  );
}

/** XMP packets joined by NUL bytes, as the WASM encoders split them. */
export function joinPackets(packets: readonly Uint8Array[]): Uint8Array {
  if (packets.length === 0) return NO_BYTES;
  const length = packets.reduce((sum, packet) => sum + packet.length, 0) + packets.length - 1;
  const out = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  packets.forEach((packet, index) => {
    if (index > 0) offset += 1;
    out.set(packet, offset);
    offset += packet.length;
  });
  return out;
}
