import { describe, expect, it, vi } from "vitest";
import { rect } from "./geometry";
import { resampleLayerPixelsWith } from "./layer-pixels";
import { Surface } from "./surface";
import { TiledPixelStore } from "./tiled-store";

describe("resampleLayerPixelsWith", () => {
  it("stores the result in slices of about 2 M pixels, not of 64 rows (L10)", async () => {
    const source = new TiledPixelStore(8, 8);
    source.fill({ r: 1, g: 2, b: 3, a: 255 });
    const resample = vi.fn(async (_input: Surface, width: number, height: number) => {
      const out = new Surface(width, height);
      out.fill({ r: 9, g: 8, b: 7, a: 255 });
      return out;
    });
    const pause = vi.fn(async () => {});
    const out = await resampleLayerPixelsWith(
      source,
      4096,
      1100,
      { filter: "bilinear", linearLight: false },
      resample,
      pause,
    );
    // 2^21 / 4096 = 512 rows per slice: 512, 512 and 76.
    expect(pause).toHaveBeenCalledTimes(3);
    expect(out.getPixel(4095, 1099)).toEqual({ r: 9, g: 8, b: 7, a: 255 });
    expect(out.readRegion(rect(0, 511, 1, 2)).data[3]).toBe(255);
  });
});
