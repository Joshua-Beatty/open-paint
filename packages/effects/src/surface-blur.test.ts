import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import { builtinEffectBindings } from "./index";
import {
  SURFACE_BLUR_ID,
  surfaceBlurBinding,
  surfaceBlurCpu,
  surfaceBlurDescriptor,
  surfaceBlurParams,
  surfaceBlurSchema,
  surfaceBlurSlope,
} from "./surface-blur";

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

describe("Surface Blur descriptor and schema", () => {
  it("is a configurable Blurs effect", () => {
    expect(surfaceBlurDescriptor()).toMatchObject({
      id: SURFACE_BLUR_ID,
      label: "effect.surfaceBlur",
      category: "effect",
      submenu: "blurs",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Radius and Threshold, with the spec's defaults and ranges", () => {
    const properties = surfaceBlurSchema().properties;
    expect(properties.map((property) => property.key)).toEqual(["radius", "threshold"]);
    expect(properties).toEqual([
      expect.objectContaining({ kind: "int32", defaultValue: 6, min: 1, max: 50 }),
      expect.objectContaining({ kind: "int32", defaultValue: 15, min: 1, max: 100 }),
    ]);
  });

  it("clamps stored values to the schema ranges", () => {
    expect(resolveValues(surfaceBlurSchema(), { radius: 0, threshold: 500 })).toMatchObject({
      radius: 1,
      threshold: 100,
    });
  });
});

describe("Surface Blur parameters and CPU reference", () => {
  it("reads the defaults from empty values, and the slope follows the threshold", () => {
    const params = surfaceBlurParams({});
    expect(params).toEqual({ radius: 6, threshold: 15 });
    expect(surfaceBlurSlope(params)).toBeCloseTo(1 / (0.96 * 0.15), 3);
  });

  it("keeps a sharp step edge", () => {
    const input = stepImage(16, 6);
    const out = surfaceBlurCpu(input, { radius: 4, threshold: 15 });
    expect(out.data[(3 * 16 + 7) * 4]).toBe(0);
    expect(out.data[(3 * 16 + 8) * 4]).toBe(255);
  });

  it("leaves a uniform image unchanged", () => {
    const data = new Uint8ClampedArray(9 * 7 * 4);
    for (let i = 0; i < 63; i++) data.set([30, 60, 90, 255], i * 4);
    const uniform = new Surface(9, 7, data);
    const out = surfaceBlurCpu(uniform, { radius: 3, threshold: 40 });
    expect([...out.data]).toEqual([...uniform.data]);
  });
});

describe("Surface Blur binding", () => {
  it("reads its parameters from values and runs the CPU reference", () => {
    const binding = surfaceBlurBinding();
    const params = binding.params({ threshold: 30 }, { width: 8, height: 8 }, 0);
    expect(params).toEqual({ radius: 6, threshold: 30 });
    expect(binding.cpu(stepImage(8, 6), params).height).toBe(6);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(SURFACE_BLUR_ID);
  });
});
