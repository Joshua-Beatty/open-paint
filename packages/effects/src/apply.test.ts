import { rect, Surface, TiledPixelStore } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import { applyToRegion, clipToCoverage, clipToCoverageArea } from "./apply";

function solid(width: number, height: number, pixel: number[]): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(pixel, i);
  return new Surface(width, height, data);
}

describe("clipToCoverage", () => {
  const original = solid(2, 1, [10, 20, 30, 40]);
  const effected = solid(2, 1, [200, 100, 0, 255]);

  it("keeps the original at coverage 0 and the effect at coverage 255", () => {
    const out = clipToCoverage(original, effected, new Uint8ClampedArray([0, 255]));
    expect([...out.data]).toEqual([10, 20, 30, 40, 200, 100, 0, 255]);
  });

  it("mixes partial coverage linearly and rounds half up", () => {
    const out = clipToCoverage(original, effected, new Uint8ClampedArray([128, 128]));
    // (10 * 127 + 200 * 128) / 255 = 105.37 -> 105.
    expect(out.data[0]).toBe(105);
    expect(out.data[3]).toBe(148);
  });

  it("rejects coverage that does not match the region", () => {
    expect(() => clipToCoverage(original, effected, new Uint8ClampedArray(3))).toThrow(
      "expected 2",
    );
  });
});

describe("applyToRegion", () => {
  it("applies the effect only inside the region and writes it back to the layer", async () => {
    const store = new TiledPixelStore(300, 300);
    store.writeRegion(solid(300, 300, [40, 80, 120, 255]), 0, 0);
    const region = rect(250, 250, 100, 100);
    const written = await applyToRegion({
      store,
      region,
      run: (input) => solid(input.width, input.height, [255, 0, 0, 255]),
    });
    expect(written).toEqual(rect(250, 250, 50, 50));
    expect(store.getPixel(260, 260)).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(store.getPixel(10, 10)).toEqual({ r: 40, g: 80, b: 120, a: 255 });
  });

  it("clips the effect to the coverage mask", async () => {
    const store = new TiledPixelStore(8, 4);
    store.writeRegion(solid(8, 4, [0, 0, 0, 255]), 0, 0);
    const coverage = new Uint8ClampedArray(4 * 4);
    coverage.fill(255, 0, 4);
    await applyToRegion({
      store,
      region: rect(2, 0, 4, 4),
      coverage,
      run: (input) => solid(input.width, input.height, [255, 255, 255, 255]),
    });
    expect(store.getPixel(2, 0)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(store.getPixel(2, 1)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it("does nothing for a region outside the layer", async () => {
    const store = new TiledPixelStore(8, 8);
    const written = await applyToRegion({
      store,
      region: rect(20, 20, 4, 4),
      run: () => {
        throw new Error("should not run");
      },
    });
    expect(written.width).toBe(0);
  });

  it("rejects an effect that changes the region size", async () => {
    const store = new TiledPixelStore(8, 8);
    await expect(
      applyToRegion({
        store,
        region: rect(0, 0, 4, 4),
        run: () => new Surface(2, 2),
      }),
    ).rejects.toThrow("Effect returned 2x2");
  });
});

describe("clipToCoverageArea (L7)", () => {
  it("equals the per-channel mix over any part, aligned or not", () => {
    let state = 3;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state >>> 24;
    };
    const width = 37;
    const height = 23;
    const backing = new Uint8ClampedArray(width * height * 4 + 1);
    const original = new Surface(width, height, backing.subarray(1));
    for (let i = 0; i < original.data.length; i++) original.data[i] = next();
    const effected = new Surface(width, height);
    for (let i = 0; i < effected.data.length; i++) effected.data[i] = next();
    const coverage = Uint8Array.from({ length: width * height }, () => {
      const pick = next();
      return pick < 90 ? 0 : pick < 180 ? 255 : pick;
    });
    const area = rect(5, 3, 20, 17);
    const out = clipToCoverageArea(original, effected, coverage, area);
    for (let y = 0; y < area.height; y++) {
      for (let x = 0; x < area.width; x++) {
        const i = (area.y + y) * width + area.x + x;
        const c = coverage[i] ?? 0;
        for (let k = 0; k < 4; k++) {
          const o = original.data[i * 4 + k] ?? 0;
          const e = effected.data[i * 4 + k] ?? 0;
          expect(out.data[(y * area.width + x) * 4 + k]).toBe(
            Math.floor((o * (255 - c) + e * c + 127) / 255),
          );
        }
      }
    }
    expect(clipToCoverage(original, effected, coverage).data.length).toBe(width * height * 4);
  });
});
