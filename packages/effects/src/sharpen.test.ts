/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  SHARPEN_ID,
  sharpenBinding,
  sharpenCpu,
  sharpenDescriptor,
  sharpenParams,
  sharpenSchema,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function flat(width: number, height: number, rgba: readonly number[]): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return new Surface(width, height, data);
}

describe("Sharpen descriptor and schema", () => {
  it("is a configurable Photo effect in document space", () => {
    expect(sharpenDescriptor()).toMatchObject({
      id: SHARPEN_ID,
      label: "effect.sharpen",
      category: "effect",
      submenu: "photo",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("lists Amount and an exponential Threshold with the spec's ranges and defaults", () => {
    const find = (key: string) => sharpenSchema().properties.find((p) => p.key === key);
    expect(find("amount")).toMatchObject({ kind: "double", defaultValue: 2, min: 0, max: 10 });
    expect(find("threshold")).toMatchObject({ kind: "double", defaultValue: 0, min: 0, max: 1 });
    expect(find("threshold")?.control).toMatchObject({ useExponentialScale: true });
  });

  it("uses the defaults and clamps the values to the schema", () => {
    expect(resolveValues(sharpenSchema(), {})).toMatchObject({ amount: 2, threshold: 0 });
    expect(sharpenParams({ amount: 50, threshold: -1 })).toEqual({ amount: 10, threshold: 0 });
  });
});

describe("Sharpen CPU reference", () => {
  it("leaves a flat image unchanged", () => {
    const input = flat(4, 3, [128, 60, 200, 255]);
    expect([...sharpenCpu(input, { amount: 2, threshold: 0 }).data]).toEqual([...input.data]);
  });

  it("darkens the dark side of an edge and brightens the light side", () => {
    // One row of 60, 60, 200, 200: the dark pixel next to the edge gets darker and the light pixel
    // next to it gets lighter.
    const input = new Surface(
      4,
      1,
      new Uint8ClampedArray([60, 60, 200, 200].flatMap((v) => [v, v, v, 255])),
    );
    const out = sharpenCpu(input, { amount: 1, threshold: 0 });
    expect(out.data[1 * 4] ?? 0).toBeLessThan(60);
    expect(out.data[1 * 4 + 3]).toBe(255);
    expect(out.data[2 * 4] ?? 0).toBeGreaterThan(200);
  });

  it("does nothing where the difference is below the threshold", () => {
    const row = [60, 60, 200, 200];
    const input = new Surface(4, 1, new Uint8ClampedArray(row.flatMap((v) => [v, v, v, 255])));
    const out = sharpenCpu(input, { amount: 5, threshold: 1 });
    expect([...out.data]).toEqual([...input.data]);
  });

  it("keeps transparent pixels transparent and the alpha of every pixel", () => {
    const out = sharpenCpu(flat(3, 3, [90, 90, 90, 0]), { amount: 10, threshold: 0 });
    expect(out.data.every((value, i) => i % 4 !== 3 || value === 0)).toBe(true);
    expect(out.data.every((value) => value === 0)).toBe(true);
  });

  it("returns a same-sized surface", () => {
    const out = sharpenCpu(flat(7, 4, [10, 200, 30, 255]), { amount: 2, threshold: 0 });
    expect(out.width).toBe(7);
    expect(out.height).toBe(4);
  });
});

describe("Sharpen binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = sharpenBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ amount: 3 }));
    expect(out.width).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(SHARPEN_ID);
  });
});
