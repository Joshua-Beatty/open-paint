/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  PENCIL_SKETCH_ID,
  pencilSketchBinding,
  pencilSketchCpu,
  pencilSketchDescriptor,
  pencilSketchParams,
  pencilSketchSchema,
  planPencilSketch,
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

describe("Pencil Sketch descriptor and schema", () => {
  it("is a configurable Artistic effect in document space", () => {
    expect(pencilSketchDescriptor()).toMatchObject({
      id: PENCIL_SKETCH_ID,
      label: "effect.pencilSketch",
      submenu: "artistic",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document" } },
    });
  });

  it("lists Pencil tip size and Range with the spec's ranges and defaults", () => {
    const find = (key: string) => pencilSketchSchema().properties.find((p) => p.key === key);
    expect(find("tipSize")).toMatchObject({ kind: "double", defaultValue: 2, min: 1, max: 20 });
    expect(find("range")).toMatchObject({ kind: "double", defaultValue: 0, min: -20, max: 20 });
    expect(resolveValues(pencilSketchSchema(), {})).toMatchObject({ tipSize: 2, range: 0 });
    expect(pencilSketchParams({ tipSize: 99, range: -99 })).toEqual({ tipSize: 20, range: -20 });
  });
});

describe("Pencil Sketch plan", () => {
  it("blurs with radius 1.5 times the tip size at quality 3", () => {
    const plan = planPencilSketch({ tipSize: 2, range: 0 });
    expect(plan.blurRadius).toBe(3);
    expect(plan.blurQuality).toBe(3);
  });

  it("sets brightness to Range + 1 and contrast to its negative", () => {
    // Range 0 gives brightness 1 and contrast -1: a multiplier of 99 over a divisor of 100.
    const plan = planPencilSketch({ tipSize: 2, range: 0 });
    expect([...plan.plan]).toEqual([Math.fround(1 / 255), 99, 100]);
    const raised = planPencilSketch({ tipSize: 2, range: 10 });
    expect(raised.plan[1]).toBe(89);
  });
});

describe("Pencil Sketch CPU reference", () => {
  it("keeps a flat white image white", () => {
    const out = pencilSketchCpu(flat(4, 4, [255, 255, 255, 255]), pencilSketchParams({}));
    expect([...out.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  });

  it("lightens a flat mid gray toward white", () => {
    const out = pencilSketchCpu(flat(4, 4, [128, 128, 128, 255]), pencilSketchParams({}));
    expect(out.data[0]).toBeGreaterThan(240);
    expect(out.data[0]).toBe(out.data[1]);
  });

  it("keeps the alpha of the input", () => {
    const out = pencilSketchCpu(flat(3, 3, [40, 40, 40, 0]), pencilSketchParams({}));
    expect(out.data.every((value, i) => i % 4 !== 3 || value === 0)).toBe(true);
  });
});

describe("Pencil Sketch binding", () => {
  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(PENCIL_SKETCH_ID);
    const binding = pencilSketchBinding();
    expect(binding.cpu(flat(2, 2, [1, 2, 3, 255]), binding.params({})).height).toBe(2);
  });
});
