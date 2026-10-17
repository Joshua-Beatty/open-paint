import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import { builtinEffectBindings } from "./index";
import {
  REDUCE_NOISE_ID,
  reduceNoiseBinding,
  reduceNoiseCpu,
  reduceNoiseDescriptor,
  reduceNoiseParams,
  reduceNoiseSchema,
} from "./reduce-noise";
import { REDUCE_NOISE_WGSL } from "./reduce-noise-wgsl";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque gray image with one dark speck at the center. */
function speckImage(size: number, speck: number): Surface {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([200, 200, 200, 255], i * 4);
  const center = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
  data.set([speck, speck, speck, 255], center);
  return new Surface(size, size, data);
}

describe("Reduce Noise descriptor and schema", () => {
  it("is a configurable Noise effect", () => {
    expect(reduceNoiseDescriptor()).toMatchObject({
      id: REDUCE_NOISE_ID,
      label: "effect.reduceNoise",
      category: "effect",
      submenu: "noise",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Radius and Strength, with the spec's defaults and ranges", () => {
    const properties = reduceNoiseSchema().properties;
    expect(properties.map((property) => property.key)).toEqual(["radius", "strength"]);
    expect(properties).toEqual([
      expect.objectContaining({ kind: "int32", defaultValue: 10, min: 0, max: 50 }),
      expect.objectContaining({ kind: "double", defaultValue: 0.4, min: 0, max: 1 }),
    ]);
  });

  it("clamps stored values to the schema ranges", () => {
    expect(resolveValues(reduceNoiseSchema(), { radius: 90, strength: -1 })).toMatchObject({
      radius: 50,
      strength: 0,
    });
  });
});

describe("Reduce Noise parameters and CPU reference", () => {
  it("reads the defaults from empty values", () => {
    expect(reduceNoiseParams({})).toEqual({ radius: 10, strength: 0.4 });
  });

  it("passes the image through at radius 0", () => {
    const input = speckImage(9, 20);
    const out = reduceNoiseCpu(input, { radius: 0, strength: 1 });
    expect([...out.data]).toEqual([...input.data]);
  });

  it("passes the image through at zero strength", () => {
    const input = speckImage(9, 20);
    const out = reduceNoiseCpu(input, { radius: 3, strength: 0 });
    expect([...out.data]).toEqual([...input.data]);
  });

  it("moves a dark speck toward its surroundings and keeps the alpha", () => {
    const data = speckImage(9, 20).data;
    for (let i = 3; i < data.length; i += 4) data[i] = 90;
    const input = new Surface(9, 9, data);
    const out = reduceNoiseCpu(input, { radius: 2, strength: 1 });
    const center = (4 * 9 + 4) * 4;
    expect(out.data[center]).toBeGreaterThan(20);
    expect(out.data[center + 3]).toBe(90);
  });
});

describe("Reduce Noise binding and shader", () => {
  it("reads its parameters from values and runs the CPU reference", () => {
    const binding = reduceNoiseBinding();
    const params = binding.params({ strength: 0.9 }, { width: 8, height: 8 }, 0);
    expect(params).toEqual({ radius: 10, strength: 0.9 });
    expect(binding.cpu(speckImage(8, 10), { radius: 1, strength: 0.5 }).width).toBe(8);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(REDUCE_NOISE_ID);
  });

  it("ships a compute shader with the mirrored neighborhood", () => {
    expect(REDUCE_NOISE_WGSL).toContain("@compute @workgroup_size(8, 8)");
    expect(REDUCE_NOISE_WGSL).toContain("fn mirror_index");
  });
});
