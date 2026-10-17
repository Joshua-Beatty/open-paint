import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import { builtinEffectBindings } from "./index";
import {
  SKETCH_BLUR_ID,
  sketchBlurBinding,
  sketchBlurCpu,
  sketchBlurDescriptor,
  sketchBlurParams,
  sketchBlurPlan,
  sketchBlurSchema,
} from "./sketch-blur";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque image: black on the left half, white on the right half. */
function stepImage(width: number, height: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = x < width / 2 ? 0 : 255;
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return new Surface(width, height, data);
}

describe("Sketch Blur descriptor and schema", () => {
  it("is a configurable Blurs effect that works in the document space", () => {
    expect(sketchBlurDescriptor()).toMatchObject({
      id: SKETCH_BLUR_ID,
      label: "effect.sketchBlur",
      category: "effect",
      submenu: "blurs",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("lists Radius, Percentile and Smoothness, with the spec's defaults and ranges", () => {
    const properties = sketchBlurSchema().properties;
    expect(properties.map((property) => property.key)).toEqual([
      "radius",
      "percentile",
      "smoothness",
    ]);
    expect(properties).toEqual([
      expect.objectContaining({ kind: "double", defaultValue: 25, min: 0, max: 100 }),
      expect.objectContaining({ kind: "int32", defaultValue: 50, min: 0, max: 100 }),
      expect.objectContaining({ kind: "int32", defaultValue: 3, min: 1, max: 20 }),
    ]);
  });

  it("clamps stored values to the schema ranges", () => {
    expect(
      resolveValues(sketchBlurSchema(), { radius: 500, percentile: -4, smoothness: 0 }),
    ).toMatchObject({ radius: 100, percentile: 0, smoothness: 1 });
  });
});

describe("Sketch Blur parameters, plan and CPU reference", () => {
  it("reads the defaults from empty values", () => {
    expect(sketchBlurParams({})).toEqual({ radius: 25, percentile: 50, smoothness: 3 });
  });

  it("plans the scan and the P² constants from the Rust reference", () => {
    const plan = sketchBlurPlan({ radius: 25, percentile: 50, smoothness: 3 });
    expect(plan.offsets.length).toBe(2 * 16 * 3);
    expect(plan.markers).toEqual([200, 400, 600, 800, 1000, 0, 50, 100, 150, 200]);
    expect(plan.rank).toBe(7);
  });

  it("keeps a sharp step edge at a small radius", () => {
    const out = sketchBlurCpu(stepImage(16, 6), { radius: 2, percentile: 50, smoothness: 2 });
    expect(out.data[(3 * 16 + 2) * 4]).toBe(0);
    expect(out.data[(3 * 16 + 13) * 4]).toBe(255);
  });

  it("gives a high percentile a brighter edge than a low one", () => {
    const input = stepImage(16, 6);
    const high = sketchBlurCpu(input, { radius: 3, percentile: 100, smoothness: 2 });
    const low = sketchBlurCpu(input, { radius: 3, percentile: 0, smoothness: 2 });
    const at = (surface: Surface) => surface.data[(3 * 16 + 7) * 4] ?? 0;
    expect(at(high)).toBeGreaterThan(at(low));
  });

  it("leaves a uniform image unchanged", () => {
    const data = new Uint8ClampedArray(9 * 7 * 4);
    for (let i = 0; i < 63; i++) data.set([30, 60, 90, 255], i * 4);
    const uniform = new Surface(9, 7, data);
    const out = sketchBlurCpu(uniform, { radius: 5, percentile: 30, smoothness: 4 });
    expect([...out.data]).toEqual([...uniform.data]);
  });
});

describe("Sketch Blur binding", () => {
  it("reads its parameters from values and runs the CPU reference", () => {
    const binding = sketchBlurBinding();
    const params = binding.params({ percentile: 20 }, { width: 8, height: 8 }, 0);
    expect(params).toEqual({ radius: 25, percentile: 20, smoothness: 3 });
    expect(binding.cpu(stepImage(8, 6), params).height).toBe(6);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(SKETCH_BLUR_ID);
  });
});
