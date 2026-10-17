import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import { builtinEffectBindings } from "./index";
import {
  MEDIAN_BLUR_ID,
  medianBlurBinding,
  medianBlurCpu,
  medianBlurDescriptor,
  medianBlurParams,
  medianBlurSchema,
} from "./median-blur";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque black image with one white pixel. */
function spikeImage(size: number, x: number, y: number): Surface {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([0, 0, 0, 255], i * 4);
  data.set([255, 255, 255, 255], (y * size + x) * 4);
  return new Surface(size, size, data);
}

describe("Median Blur descriptor and schema", () => {
  it("is a configurable Blurs effect", () => {
    expect(medianBlurDescriptor()).toMatchObject({
      id: MEDIAN_BLUR_ID,
      label: "effect.medianBlur",
      category: "effect",
      submenu: "blurs",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Radius, Percentile and Quality, with the spec's defaults and ranges", () => {
    const properties = medianBlurSchema().properties;
    expect(properties.map((property) => property.key)).toEqual(["radius", "percentile", "quality"]);
    expect(properties).toEqual([
      expect.objectContaining({ kind: "int32", defaultValue: 10, min: 0, max: 100 }),
      expect.objectContaining({ kind: "int32", defaultValue: 50, min: 0, max: 100 }),
      expect.objectContaining({ kind: "int32", defaultValue: 8, min: 1, max: 9 }),
    ]);
  });

  it("clamps stored values to the schema ranges", () => {
    expect(
      resolveValues(medianBlurSchema(), { radius: 150, percentile: -5, quality: 12 }),
    ).toMatchObject({ radius: 100, percentile: 0, quality: 9 });
  });
});

describe("Median Blur parameters and CPU reference", () => {
  it("reads the defaults from empty values", () => {
    expect(medianBlurParams({})).toEqual({ radius: 10, percentile: 50, quality: 8 });
  });

  it("removes an isolated bright pixel at the median", () => {
    const input = spikeImage(9, 4, 4);
    const out = medianBlurCpu(input, { radius: 2, percentile: 50, quality: 8 });
    expect(out.data[(4 * 9 + 4) * 4]).toBe(0);
    expect(out.width).toBe(9);
  });

  it("spreads the bright pixel at percentile 100", () => {
    const out = medianBlurCpu(spikeImage(9, 4, 4), { radius: 2, percentile: 100, quality: 8 });
    expect(out.data[(4 * 9 + 6) * 4]).toBe(255);
    expect(out.data[(4 * 9 + 7) * 4]).toBe(0);
  });

  it("passes the image through at radius 0", () => {
    const input = spikeImage(7, 2, 3);
    const out = medianBlurCpu(input, { radius: 0, percentile: 30, quality: 4 });
    expect([...out.data]).toEqual([...input.data]);
  });

  it("leaves a uniform image unchanged", () => {
    const data = new Uint8ClampedArray(10 * 6 * 4);
    for (let i = 0; i < 60; i++) data.set([70, 140, 210, 255], i * 4);
    const uniform = new Surface(10, 6, data);
    const out = medianBlurCpu(uniform, { radius: 3, percentile: 40, quality: 8 });
    expect([...out.data]).toEqual([...uniform.data]);
  });
});

describe("Median Blur binding", () => {
  it("reads its parameters from values and runs the CPU reference", () => {
    const binding = medianBlurBinding();
    const params = binding.params({ radius: 1 }, { width: 8, height: 8 }, 0);
    expect(params).toEqual({ radius: 1, percentile: 50, quality: 8 });
    expect(binding.cpu(spikeImage(8, 3, 3), params).height).toBe(8);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(MEDIAN_BLUR_ID);
  });
});
