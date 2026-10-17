import { quantizePalette, type RgbaImage } from "@openpaint/codecs";
import type { QuantizeCase } from "./cases";

/**
 * The palette-mapped image of one quantization case. Without a transparent entry the input is made
 * opaque first, as the PNG pipeline prepares pixels for indexed targets. Every pixel takes its palette
 * color, and a transparent pixel stays fully transparent.
 */
export function quantizedImage(input: RgbaImage, kase: QuantizeCase): RgbaImage {
  const pixels = kase.transparentEntry ? input.data : opaque(input.data);
  const { palette, indices } = quantizePalette({
    width: input.width,
    height: input.height,
    pixels,
    capacity: kase.capacity,
    transparentEntry: kase.transparentEntry,
    algorithm: kase.algorithm,
    dithering: kase.dithering,
  });
  const data = new Uint8Array(input.width * input.height * 4);
  for (let pixel = 0; pixel < indices.length; pixel++) {
    if (kase.transparentEntry && (input.data[pixel * 4 + 3] ?? 0) === 0) continue;
    const index = (indices[pixel] ?? 0) * 3;
    data.set(
      [palette[index] ?? 0, palette[index + 1] ?? 0, palette[index + 2] ?? 0, 255],
      pixel * 4,
    );
  }
  return { width: input.width, height: input.height, data };
}

function opaque(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}
