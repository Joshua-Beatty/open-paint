import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ADD_NOISE_ID,
  addNoiseBinding,
  addNoiseCpu,
  addNoiseDescriptor,
  addNoiseParams,
  addNoiseSchema,
  addNoiseTable,
} from "./add-noise";
import { ADD_NOISE_WGSL } from "./add-noise-wgsl";
import { builtinEffectBindings } from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque gray image, with the alpha of every pixel set to `alpha`. */
function gray(width: number, height: number, value: number, alpha = 255): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([value, value, value, alpha], i * 4);
  return new Surface(width, height, data);
}

describe("Add Noise descriptor and schema", () => {
  it("is a configurable Noise effect in the document working space", () => {
    expect(addNoiseDescriptor()).toMatchObject({
      id: ADD_NOISE_ID,
      label: "effect.addNoise",
      category: "effect",
      submenu: "noise",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("lists Intensity, Color Saturation, Coverage and the Randomize seed, with the spec's defaults", () => {
    const properties = addNoiseSchema().properties;
    expect(properties.map((property) => property.key)).toEqual([
      "intensity",
      "colorSaturation",
      "coverage",
      "seed",
    ]);
    expect(properties).toEqual([
      expect.objectContaining({ kind: "int32", defaultValue: 64, min: 0, max: 100 }),
      expect.objectContaining({ kind: "int32", defaultValue: 100, min: 0, max: 400 }),
      expect.objectContaining({ kind: "double", defaultValue: 100, min: 0, max: 100 }),
      expect.objectContaining({
        kind: "int32",
        defaultValue: 0,
        min: 0,
        max: 255,
        control: expect.objectContaining({ controlType: "incrementButton", rangeWraps: true }),
      }),
    ]);
  });

  it("clamps stored values to the schema ranges", () => {
    expect(
      resolveValues(addNoiseSchema(), { intensity: 150, colorSaturation: -3, coverage: 120 }),
    ).toMatchObject({ intensity: 100, colorSaturation: 0, coverage: 100 });
  });
});

describe("Add Noise parameters and CPU reference", () => {
  it("reads the defaults from empty values and carries the instance seed", () => {
    expect(addNoiseParams({}, 7)).toEqual({
      intensity: 64,
      colorSaturation: 100,
      coverage: 100,
      userSeed: 0,
      instanceSeed: 7,
    });
  });

  it("builds a symmetric deviate table of 16384 values", () => {
    const table = addNoiseTable();
    expect(table).toHaveLength(16384);
    expect(table[0]).toBe(-(table[16383] ?? 0));
  });

  it("leaves the image unchanged at zero coverage or zero intensity", () => {
    const input = gray(6, 5, 90);
    expect([...addNoiseCpu(input, addNoiseParams({ coverage: 0 })).data]).toEqual([...input.data]);
    expect([...addNoiseCpu(input, addNoiseParams({ intensity: 0 })).data]).toEqual([...input.data]);
  });

  it("changes the color, keeps the alpha, and returns the input size", () => {
    const input = gray(12, 10, 128, 42);
    const out = addNoiseCpu(input, addNoiseParams({}));
    expect(out.width).toBe(12);
    expect(out.height).toBe(10);
    expect(out.data.some((value, index) => index % 4 !== 3 && value !== 128)).toBe(true);
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(42);
  });

  it("gives the same noise for the same seeds and different noise for a new instance seed", () => {
    const input = gray(16, 16, 128);
    const params = addNoiseParams({ seed: 9 }, 3);
    const first = addNoiseCpu(input, params);
    expect([...addNoiseCpu(input, params).data]).toEqual([...first.data]);
    expect([...addNoiseCpu(input, addNoiseParams({ seed: 9 }, 4)).data]).not.toEqual([
      ...first.data,
    ]);
  });

  it("gives gray noise at zero color saturation", () => {
    const out = addNoiseCpu(gray(16, 16, 128), addNoiseParams({ colorSaturation: 0 }));
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(out.data[i + 1]);
      expect(out.data[i + 1]).toBe(out.data[i + 2]);
    }
  });
});

describe("Add Noise binding and shader", () => {
  it("reads its parameters from values and runs the CPU reference", () => {
    const binding = addNoiseBinding();
    const params = binding.params({ intensity: 20 }, { width: 8, height: 8 }, 5);
    expect(params).toMatchObject({ intensity: 20, instanceSeed: 5 });
    expect(binding.cpu(gray(8, 8, 60), params).height).toBe(8);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(ADD_NOISE_ID);
  });

  it("ships a compute shader that reads the deviate table at binding 3", () => {
    expect(ADD_NOISE_WGSL).toContain("@compute @workgroup_size(8, 8)");
    expect(ADD_NOISE_WGSL).toContain("@binding(3) var<storage, read> deviates");
  });
});
