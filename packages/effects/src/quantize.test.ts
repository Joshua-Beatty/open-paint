/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  QUANTIZE_ID,
  quantizeBinding,
  quantizeCpu,
  quantizeDescriptor,
  quantizeParams,
  quantizeSchema,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly number[],
): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return new Surface(width, height, data);
}

function pixelAt(surface: Surface, index: number): number[] {
  return [...surface.data.subarray(index * 4, index * 4 + 4)];
}

const BASE = { algorithm: "octree", colors: 256, dithering: 7, transparencyThreshold: 0 } as const;

describe("Quantize descriptor and schema", () => {
  it("is a configurable CPU Color effect that writes every pixel", () => {
    expect(quantizeDescriptor()).toMatchObject({
      id: QUANTIZE_ID,
      label: "effect.quantize",
      category: "effect",
      submenu: "color",
      configurable: true,
      kind: "cpuRegion",
      options: { singleThreaded: true, uninitializedOutput: true, schedule: "none" },
    });
  });

  it("defaults to Octree, 256 colors, dithering 7 and threshold 128 (FX-COLOR-QUANTIZE-01)", () => {
    expect(resolveValues(quantizeSchema(), {})).toMatchObject({
      algorithm: "octree",
      colors: 256,
      dithering: 7,
      transparencyThreshold: 128,
    });
  });

  it("clamps out-of-range values and falls back on an unknown algorithm", () => {
    expect(
      quantizeParams({ algorithm: "bogus", colors: 1000, dithering: 9, transparencyThreshold: -4 }),
    ).toEqual({ algorithm: "octree", colors: 256, dithering: 8, transparencyThreshold: 0 });
    expect(quantizeParams({ algorithm: "medianCut", colors: 1 })).toMatchObject({
      algorithm: "medianCut",
      colors: 2,
    });
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(QUANTIZE_ID);
    expect(quantizeBinding().descriptor.id).toBe(QUANTIZE_ID);
  });
});

describe("Quantize CPU reference", () => {
  const sixteen = image(4, 4, (x, y) => [x * 60, y * 60, 128, 255]);

  it.each(["octree", "medianCut"] as const)(
    "keeps an image whose colors fit the palette unchanged (%s)",
    (algorithm) => {
      const out = quantizeCpu(sixteen, { ...BASE, algorithm, colors: 16, dithering: 8 });
      expect([...out.data]).toEqual([...sixteen.data]);
    },
  );

  it.each(["octree", "medianCut"] as const)(
    "uses no more opaque colors than Colors (%s)",
    (algorithm) => {
      const gradient = image(32, 32, (x, y) => [x * 8, y * 8, (x + y) * 4, 255]);
      const out = quantizeCpu(gradient, { ...BASE, algorithm, colors: 4, dithering: 0 });
      const colors = new Set<string>();
      for (let i = 0; i < out.width * out.height; i++) {
        colors.add(pixelAt(out, i).slice(0, 3).join(","));
      }
      expect(colors.size).toBeLessThanOrEqual(4);
      expect(colors.size).toBeGreaterThan(1);
    },
  );

  it("makes transparent the pixels below the threshold and keeps the others' alpha", () => {
    const input = image(3, 1, (x) => {
      if (x === 0) return [200, 10, 10, 100];
      if (x === 1) return [10, 200, 10, 200];
      return [10, 10, 200, 255];
    });
    const out = quantizeCpu(input, { ...BASE, colors: 16, transparencyThreshold: 128 });
    expect(pixelAt(out, 0)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(out, 1)).toEqual([10, 200, 10, 200]);
    expect(pixelAt(out, 2)).toEqual([10, 10, 200, 255]);
  });

  it("keeps translucent pixels when the threshold is 0 (transparency off)", () => {
    const input = image(2, 1, (x) => (x === 0 ? [200, 10, 10, 100] : [10, 10, 200, 255]));
    const out = quantizeCpu(input, { ...BASE, colors: 16, transparencyThreshold: 0 });
    expect(pixelAt(out, 0)).toEqual([200, 10, 10, 100]);
  });

  it("leaves pixels outside the selection unchanged and keeps them out of the palette", () => {
    const input = image(3, 1, (x) => (x === 0 ? [200, 10, 10, 255] : [33, 44, 55, 255]));
    const coverage = Uint8Array.from([255, 0, 255]);
    const out = quantizeCpu(input, { ...BASE, colors: 2 }, coverage);
    expect(pixelAt(out, 1)).toEqual([33, 44, 55, 255]);
    expect(pixelAt(out, 0)).toEqual([200, 10, 10, 255]);
    expect(pixelAt(out, 2)).toEqual([33, 44, 55, 255]);
  });

  it("returns an all-transparent region without a palette", () => {
    const input = image(2, 2, () => [9, 9, 9, 10]);
    const out = quantizeCpu(input, { ...BASE, transparencyThreshold: 255 });
    expect([...out.data]).toEqual(new Array(16).fill(0));
  });

  it("dithers a ramp differently from plain nearest-color mapping", () => {
    const ramp = image(16, 4, (x) => [x * 16, x * 16, x * 16, 255]);
    const plain = quantizeCpu(ramp, { ...BASE, colors: 2, dithering: 0 });
    const dithered = quantizeCpu(ramp, { ...BASE, colors: 2, dithering: 8 });
    expect([...dithered.data]).not.toEqual([...plain.data]);
  });
});
