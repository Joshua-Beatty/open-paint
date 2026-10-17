/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { rect, rgba8, TiledPixelStore } from "@openpaint/document";
import { hueSaturationCpu, hueSaturationParams } from "@openpaint/effects";
import { beforeAll, describe, expect, it } from "vitest";
import type { CompositeDocument } from "./composite";
import { compositeCpu } from "./composite-cpu";
import { initCpu } from "./cpu";

/** Pixel values checked against the hand-computed Rust reference cases in `blend.rs`. */
const NORMAL_RESULT = rgba8(100, 100, 125, 255);
const MULTIPLY_RESULT = rgba8(103, 134, 6, 228);
const SCREEN_RESULT = rgba8(161, 161, 161, 255);

describe("compositeCpu", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  /** Two tiles wide, so the probe pixels sit on either side of the tile boundary at x = 256. */
  function sample(): CompositeDocument {
    const width = 300;
    const height = 200;
    const base = new TiledPixelStore(width, height);
    base.fill(rgba8(200, 100, 50, 255));
    base.setPixel(260, 10, rgba8(200, 100, 50, 128));
    base.setPixel(150, 150, rgba8(100, 100, 100, 255));

    const normal = new TiledPixelStore(width, height);
    normal.setPixel(10, 10, rgba8(0, 100, 200, 128));

    const multiply = new TiledPixelStore(width, height);
    multiply.setPixel(260, 10, rgba8(100, 200, 0, 200));

    const screen = new TiledPixelStore(width, height);
    screen.setPixel(150, 150, rgba8(200, 200, 200, 255));

    const hidden = new TiledPixelStore(width, height);
    hidden.setPixel(150, 150, rgba8(255, 0, 0, 255));

    return {
      width,
      height,
      layers: [
        { store: base, mode: 0, opacity: 255, visible: true },
        { store: normal, mode: 0, opacity: 255, visible: true },
        { store: multiply, mode: 1, opacity: 255, visible: true },
        { store: screen, mode: 12, opacity: 128, visible: true },
        { store: hidden, mode: 0, opacity: 255, visible: false },
      ],
    };
  }

  it("blends layers bottom to top across tile boundaries", () => {
    const out = compositeCpu(sample(), rect(0, 0, 300, 200));
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
    expect(out.getPixel(10, 10)).toEqual(NORMAL_RESULT);
    expect(out.getPixel(260, 10)).toEqual(MULTIPLY_RESULT);
    expect(out.getPixel(150, 150)).toEqual(SCREEN_RESULT);
    expect(out.getPixel(0, 0)).toEqual(rgba8(200, 100, 50, 255));
  });

  it("composites only the requested region, keeping its origin at zero", () => {
    const out = compositeCpu(sample(), rect(250, 0, 50, 20));
    expect(out.width).toBe(50);
    expect(out.height).toBe(20);
    expect(out.getPixel(10, 10)).toEqual(MULTIPLY_RESULT);
  });

  it("gives every region the same pixels as the whole composite", () => {
    const doc = sample();
    const whole = compositeCpu(doc, rect(0, 0, 300, 200));
    for (const region of [rect(128, 0, 128, 128), rect(200, 5, 90, 160), rect(0, 128, 300, 72)]) {
      const part = compositeCpu(doc, region);
      for (let y = 0; y < region.height; y++) {
        for (let x = 0; x < region.width; x++) {
          expect(part.getPixel(x, y)).toEqual(whole.getPixel(region.x + x, region.y + y));
        }
      }
    }
  });

  it("draws a layer through its live filter inside its region, mixed by the coverage", () => {
    const width = 300;
    const height = 280;
    const store = new TiledPixelStore(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) store.setPixel(x, y, rgba8(x % 256, (y * 3) % 256, 90, 200));
    }
    const region = rect(200, 240, 80, 30);
    const coverage = Uint8Array.from({ length: 80 * 30 }, (_, i) => (i * 7) % 256);
    const params = hueSaturationParams({ saturation: 0, hue: 40 });
    const live = { effectId: "hueSaturation", params, region, coverage, key: "k" };
    const out = compositeCpu(
      { width, height, layers: [{ store, mode: 0, opacity: 255, visible: true, live }] },
      rect(0, 0, width, height),
    );
    // The reference: the adjustment over the region, clipped by the coverage, then composited.
    const adjusted = hueSaturationCpu(store.readRegion(region), params);
    const expected = new TiledPixelStore(width, height);
    expected.writeRegion(store.readRegion(rect(0, 0, width, height)), 0, 0);
    for (let y = 0; y < region.height; y++) {
      for (let x = 0; x < region.width; x++) {
        const c = coverage[y * region.width + x] ?? 0;
        const o = store.getPixel(region.x + x, region.y + y);
        const a = adjusted.getPixel(x, y);
        const mix = (p: number, q: number) => Math.floor((p * (255 - c) + q * c + 127) / 255);
        expected.setPixel(
          region.x + x,
          region.y + y,
          rgba8(mix(o.r, a.r), mix(o.g, a.g), mix(o.b, a.b), mix(o.a, a.a)),
        );
      }
    }
    const reference = compositeCpu(
      { width, height, layers: [{ store: expected, mode: 0, opacity: 255, visible: true }] },
      rect(0, 0, width, height),
    );
    expect([...out.data]).toEqual([...reference.data]);
    // The store itself is untouched.
    expect(store.getPixel(250, 250)).toEqual(rgba8(250, (250 * 3) % 256, 90, 200));
  });

  it("returns an empty surface for an empty region", () => {
    const out = compositeCpu(sample(), rect(0, 0, 0, 0));
    expect(out.byteLength).toBe(0);
  });

  it("skips tiles that no layer allocates", () => {
    const store = new TiledPixelStore(600, 300);
    store.setPixel(10, 10, rgba8(9, 8, 7, 255));
    const out = compositeCpu(
      { width: 600, height: 300, layers: [{ store, mode: 0, opacity: 255, visible: true }] },
      rect(0, 0, 600, 300),
    );
    expect(out.getPixel(10, 10)).toEqual(rgba8(9, 8, 7, 255));
    expect(out.getPixel(500, 250)).toEqual(rgba8(0, 0, 0, 0));
  });
});
