import { quantize_palette } from "@openpaint/cpu";
import type { PaletteAlgorithm, PaletteQuantizer } from "./png-pipeline";

/** The WASM ids of the palette algorithms (`quantize_palette`, `Algorithm` in quantize.rs). */
const ALGORITHM_IDS: Record<PaletteAlgorithm, number> = { medianCut: 0, octree: 1 };

/**
 * The 8-bit palette quantizer (FMT-QNT-01 step 5): Median Cut or Octree, with error-diffusion dithering
 * at the chosen level. It runs in WASM, and the palette hook of the PNG pipeline calls it.
 */
export const quantizePalette: PaletteQuantizer = (request) => {
  const result = quantize_palette(
    request.pixels,
    request.width,
    request.height,
    request.capacity,
    request.transparentEntry,
    ALGORITHM_IDS[request.algorithm],
    request.dithering,
  );
  try {
    return { palette: result.palette, indices: result.indices };
  } finally {
    result.free();
  }
};
