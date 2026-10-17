/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  OIL_PAINTING_ID,
  oilPaintingBinding,
  oilPaintingCpu,
  oilPaintingDescriptor,
  oilPaintingParams,
  oilPaintingSchema,
  planOilPainting,
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

describe("Oil Painting descriptor and schema", () => {
  it("is a configurable Artistic effect in linear light", () => {
    expect(oilPaintingDescriptor()).toMatchObject({
      id: OIL_PAINTING_ID,
      label: "effect.oilPainting",
      submenu: "artistic",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "linear", inputAlpha: "straight" } },
    });
  });

  it("lists Brush size, Granularity and Kernel Shape with the spec's ranges", () => {
    const find = (key: string) => oilPaintingSchema().properties.find((p) => p.key === key);
    expect(find("brushSize")).toMatchObject({ kind: "int32", defaultValue: 10, min: 1, max: 50 });
    expect(find("granularity")).toMatchObject({
      kind: "double",
      defaultValue: 0.2,
      min: 0.01,
      max: 1,
    });
    const shape = find("kernelShape");
    expect(shape).toMatchObject({ kind: "choice", defaultValue: "circle" });
    expect(shape?.kind === "choice" ? shape.options.map((o) => o.value) : []).toEqual([
      "circle",
      "square",
    ]);
  });

  it("clamps the values and falls back to a circle for an unknown shape", () => {
    expect(oilPaintingParams({ brushSize: 0, granularity: 5, kernelShape: "hexagon" })).toEqual({
      brushSize: 1,
      granularity: 1,
      kernelShape: "circle",
    });
    expect(resolveValues(oilPaintingSchema(), {})).toMatchObject({ brushSize: 10 });
  });
});

describe("Oil Painting plan", () => {
  it("sets the bin count to int(granularity x 256), clamped to 4 to 256", () => {
    const bins = (granularity: number) =>
      planOilPainting({ brushSize: 3, granularity, kernelShape: "circle" }).bins;
    expect(bins(0.2)).toBe(51);
    expect(bins(0.01)).toBe(4);
    expect(bins(1)).toBe(256);
  });

  it("uses the disc limit r squared plus r over two, and the square flag", () => {
    expect(planOilPainting({ brushSize: 10, granularity: 0.2, kernelShape: "circle" })).toEqual({
      radius: 10,
      bins: 51,
      limit: 105,
      square: false,
    });
    expect(planOilPainting({ brushSize: 2, granularity: 0.2, kernelShape: "square" }).square).toBe(
      true,
    );
  });
});

describe("Oil Painting CPU reference", () => {
  it("keeps a flat image unchanged", () => {
    const input = flat(6, 5, [60, 120, 200, 255]);
    const out = oilPaintingCpu(input, oilPaintingParams({ brushSize: 2 }));
    expect([...out.data]).toEqual([...input.data]);
  });

  it("removes a single odd pixel in a square kernel", () => {
    const input = flat(5, 5, [100, 100, 100, 255]);
    input.data.set([255, 255, 255, 255], (2 * 5 + 2) * 4);
    const out = oilPaintingCpu(input, { brushSize: 1, granularity: 0.2, kernelShape: "square" });
    expect([...out.data.slice((2 * 5 + 2) * 4, (2 * 5 + 2) * 4 + 4)]).toEqual([100, 100, 100, 255]);
  });

  it("keeps the alpha of transparent pixels", () => {
    const out = oilPaintingCpu(flat(4, 4, [9, 9, 9, 0]), oilPaintingParams({ brushSize: 2 }));
    expect(out.data.every((value, i) => i % 4 !== 3 || value === 0)).toBe(true);
  });
});

describe("Oil Painting binding", () => {
  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(OIL_PAINTING_ID);
    const binding = oilPaintingBinding();
    expect(binding.cpu(flat(3, 3, [5, 5, 5, 255]), binding.params({})).width).toBe(3);
  });
});
