/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  MORPHOLOGY_ID,
  MORPHOLOGY_MODES,
  morphologyBinding,
  morphologyCode,
  morphologyCpu,
  morphologyDescriptor,
  morphologyParams,
  morphologySchema,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque black image with one white pixel. */
function dotImage(width: number, height: number, x: number, y: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([0, 0, 0, 255], i * 4);
  data.set([255, 255, 255, 255], (y * width + x) * 4);
  return new Surface(width, height, data);
}

describe("Morphology descriptor and schema", () => {
  it("is a configurable Distort effect", () => {
    expect(morphologyDescriptor()).toMatchObject({
      id: MORPHOLOGY_ID,
      label: "effect.morphology",
      category: "effect",
      submenu: "distort",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Width, Height, Linked and Mode, in that order", () => {
    const keys = morphologySchema().properties.map((property) => property.key);
    expect(keys).toEqual(["width", "height", "linked", "mode"]);
  });

  it("uses the spec's ranges, defaults and Mode choices", () => {
    const find = (key: string) =>
      morphologySchema().properties.find((property) => property.key === key);
    expect(find("width")).toMatchObject({ kind: "int32", defaultValue: 5, min: 1, max: 100 });
    expect(find("height")).toMatchObject({ kind: "int32", defaultValue: 5, min: 1, max: 100 });
    expect(find("linked")).toMatchObject({ kind: "boolean", defaultValue: true });
    const mode = find("mode");
    expect(mode).toMatchObject({ kind: "choice", defaultValue: "dilate" });
    expect(mode?.kind === "choice" ? mode.options.map((o) => o.value) : []).toEqual([
      "erode",
      "dilate",
    ]);
  });

  it("keeps Width and Height equal while Linked is checked", () => {
    const linked = resolveValues(morphologySchema(), { width: 3, height: 9, linked: true });
    expect(linked.width).toBe(linked.height);
    const free = resolveValues(morphologySchema(), { width: 3, height: 9, linked: false });
    expect(free).toMatchObject({ width: 3, height: 9 });
  });
});

describe("Morphology parameters and codes", () => {
  it("reads the defaults and clamps the sizes", () => {
    expect(morphologyParams({})).toEqual({ width: 5, height: 5, mode: "dilate" });
    expect(morphologyParams({ width: 0, height: 500, linked: false })).toMatchObject({
      width: 1,
      height: 100,
    });
  });

  it("falls back to Dilate for a Mode that is not listed", () => {
    expect(morphologyParams({ mode: "sparkle" })).toMatchObject({ mode: "dilate" });
  });

  it("codes Erode as 0 and Dilate as 1, the spec's values", () => {
    expect(MORPHOLOGY_MODES.indexOf("erode")).toBe(0);
    expect(morphologyCode({ width: 1, height: 1, mode: "erode" })).toBe(0);
    expect(morphologyCode({ width: 1, height: 1, mode: "dilate" })).toBe(1);
  });
});

describe("Morphology CPU reference", () => {
  it("grows a bright pixel under Dilate and removes it under Erode", () => {
    const input = dotImage(9, 9, 4, 4);
    const grown = morphologyCpu(input, { width: 1, height: 1, mode: "dilate" });
    const lit = (x: number, y: number) => grown.data[(y * 9 + x) * 4];
    expect(lit(4, 4)).toBe(255);
    expect(lit(5, 5)).toBe(255);
    expect(lit(6, 4)).toBe(0);

    const shrunk = morphologyCpu(input, { width: 1, height: 1, mode: "erode" });
    expect([...shrunk.data].every((value, i) => i % 4 === 3 || value === 0)).toBe(true);
  });

  it("returns a same-sized surface and leaves a uniform image unchanged", () => {
    const data = new Uint8ClampedArray(6 * 4 * 4);
    for (let i = 0; i < 24; i++) data.set([40, 80, 120, 255], i * 4);
    const uniform = new Surface(6, 4, data);
    const out = morphologyCpu(uniform, { width: 3, height: 2, mode: "erode" });
    expect(out.width).toBe(6);
    expect([...out.data]).toEqual([...uniform.data]);
  });
});

describe("Morphology binding", () => {
  it("reads its parameters and runs the CPU reference", () => {
    const binding = morphologyBinding();
    const params = binding.params({ width: 2, mode: "erode" });
    expect(params).toMatchObject({ width: 2, height: 2, mode: "erode" });
    expect(binding.cpu(dotImage(8, 6, 3, 2), params).height).toBe(6);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(MORPHOLOGY_ID);
  });
});
