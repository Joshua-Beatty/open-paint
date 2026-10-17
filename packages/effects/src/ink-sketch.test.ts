/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  INK_SKETCH_ID,
  inkSketchBinding,
  inkSketchCpu,
  inkSketchDescriptor,
  inkSketchParams,
  inkSketchSchema,
  planInkSketch,
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

describe("Ink Sketch descriptor and schema", () => {
  it("is a configurable Artistic effect in document space", () => {
    expect(inkSketchDescriptor()).toMatchObject({
      id: INK_SKETCH_ID,
      label: "effect.inkSketch",
      category: "effect",
      submenu: "artistic",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("lists Ink Outline and Coloring with the spec's ranges and defaults", () => {
    const find = (key: string) => inkSketchSchema().properties.find((p) => p.key === key);
    expect(find("inkOutline")).toMatchObject({ kind: "int32", defaultValue: 50, min: 0, max: 99 });
    expect(find("coloring")).toMatchObject({ kind: "int32", defaultValue: 50, min: 0, max: 100 });
  });

  it("clamps the values to the schema", () => {
    expect(inkSketchParams({ inkOutline: 250, coloring: -4 })).toEqual({
      inkOutline: 99,
      coloring: 0,
    });
    expect(resolveValues(inkSketchSchema(), {})).toMatchObject({ inkOutline: 50, coloring: 50 });
  });
});

describe("Ink Sketch plan", () => {
  it("uses threshold Ink Outline / 100 and Glow radius 6 times 1.25 in high quality", () => {
    const plan = planInkSketch({ inkOutline: 50, coloring: 50 });
    expect(plan.threshold).toBe(Math.fround(0.5));
    expect(plan.glowRadius).toBe(7.5);
    expect(plan.glowQuality).toBe(4);
  });

  it("sets Glow brightness and contrast to 0 at Coloring 50", () => {
    expect([...planInkSketch({ inkOutline: 50, coloring: 50 }).glowPlan]).toEqual([0, 1, 1]);
  });

  it("drives the Glow to its full range at Coloring 0 and 100", () => {
    // Coloring 0 is brightness and contrast +100: a divisor of 0 (the full-contrast case).
    expect(planInkSketch({ inkOutline: 50, coloring: 0 }).glowPlan[2]).toBe(0);
    // Coloring 100 is -100: a multiplier of 0 and a divisor of 100.
    const low = planInkSketch({ inkOutline: 50, coloring: 100 }).glowPlan;
    expect(low[1]).toBe(0);
    expect(low[2]).toBe(100);
  });
});

describe("Ink Sketch CPU reference", () => {
  it("draws a flat dark area in black ink and keeps its alpha", () => {
    const out = inkSketchCpu(flat(5, 5, [51, 51, 51, 255]), inkSketchParams({}));
    expect([...out.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect(out.data.every((value, i) => i % 4 !== 3 || value === 255)).toBe(true);
  });

  it("leaves transparent pixels transparent", () => {
    const out = inkSketchCpu(flat(3, 3, [90, 90, 90, 0]), inkSketchParams({}));
    expect(out.data.every((value, i) => i % 4 !== 3 || value === 0)).toBe(true);
  });

  it("returns a same-sized surface", () => {
    const out = inkSketchCpu(flat(7, 4, [10, 200, 30, 255]), inkSketchParams({ coloring: 0 }));
    expect(out.width).toBe(7);
    expect(out.height).toBe(4);
  });
});

describe("Ink Sketch binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = inkSketchBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ coloring: 80 }));
    expect(out.width).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(INK_SKETCH_ID);
  });
});
