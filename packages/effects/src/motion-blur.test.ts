/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  MOTION_BLUR_ID,
  motionBlurBinding,
  motionBlurCpu,
  motionBlurDescriptor,
  motionBlurParams,
  motionBlurPlan,
  motionBlurSchema,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque image of one color. */
function solidImage(width: number, height: number, rgba: number[]): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return new Surface(width, height, data);
}

/** The `dx, dy, weight` triples of a plan. */
function triples(plan: Float32Array): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < plan.length; i += 3) {
    const [dx = 0, dy = 0, weight = 0] = plan.subarray(i, i + 3);
    out.push([dx, dy, weight]);
  }
  return out;
}

describe("Motion Blur descriptor and schema", () => {
  it("is a configurable Blurs effect", () => {
    expect(motionBlurDescriptor()).toMatchObject({
      id: MOTION_BLUR_ID,
      label: "effect.motionBlur",
      category: "effect",
      submenu: "blurs",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Angle, Distance, Centered and Edge Behavior, in that order", () => {
    const keys = motionBlurSchema().properties.map((property) => property.key);
    expect(keys).toEqual(["angle", "distance", "centered", "edge"]);
  });

  it("uses the spec's ranges, defaults and edge choices", () => {
    const find = (key: string) =>
      motionBlurSchema().properties.find((property) => property.key === key);
    expect(find("angle")).toMatchObject({ kind: "double", defaultValue: 25, min: -180, max: 180 });
    expect(find("distance")).toMatchObject({ kind: "double", defaultValue: 10, min: 1, max: 500 });
    expect(find("centered")).toMatchObject({ kind: "boolean", defaultValue: true });
    const edge = find("edge");
    expect(edge).toMatchObject({ kind: "choice", defaultValue: "clamp" });
    expect(edge?.kind === "choice" ? edge.options.map((o) => o.value) : []).toEqual([
      "clamp",
      "wrap",
      "reflect",
      "transparent",
    ]);
  });

  it("clamps the distance to its range", () => {
    expect(resolveValues(motionBlurSchema(), { distance: 900 })).toMatchObject({ distance: 500 });
    expect(resolveValues(motionBlurSchema(), { distance: 0 })).toMatchObject({ distance: 1 });
  });
});

describe("Motion Blur parameters and plan", () => {
  it("reads the defaults, with a centered path and the Clamp edge", () => {
    expect(motionBlurParams({})).toEqual({
      angle: 25,
      distance: 10,
      centered: true,
      edge: "clamp",
    });
  });

  it("reads the Centered flag and the Edge Behavior choice", () => {
    expect(motionBlurParams({ edge: "wrap", centered: false })).toMatchObject({
      centered: false,
      edge: "wrap",
    });
  });

  it("builds a normalized kernel that follows the angle", () => {
    const plan = triples(motionBlurPlan({ angle: 0, distance: 10, centered: true, edge: "clamp" }));
    expect(plan.length).toBe(81);
    expect(plan.reduce((sum, sample) => sum + sample[2], 0)).toBeCloseTo(1, 5);
    expect(plan.every((sample) => Math.abs(sample[1]) < 1e-6)).toBe(true);
  });

  it("returns an empty kernel for a zero distance", () => {
    expect(motionBlurPlan({ angle: 0, distance: 0, centered: true, edge: "clamp" }).length).toBe(0);
  });
});

describe("Motion Blur CPU reference", () => {
  it("smears a bright pixel along the motion direction", () => {
    const data = new Uint8ClampedArray(9 * 3 * 4);
    for (let i = 0; i < 27; i++) data.set([0, 0, 0, 255], i * 4);
    data.set([255, 255, 255, 255], (1 * 9 + 4) * 4);
    const input = new Surface(9, 3, data);
    const out = motionBlurCpu(input, { angle: 0, distance: 4, centered: true, edge: "clamp" });
    const lit = (x: number) => out.data[(1 * 9 + x) * 4] ?? 0;
    expect(lit(4)).toBeGreaterThan(lit(3));
    expect(lit(3)).toBeGreaterThan(lit(2));
    expect(lit(2)).toBeGreaterThan(0);
    expect(lit(0)).toBe(0);
  });

  it("leaves a uniform image unchanged under the opaque edge modes", () => {
    const uniform = solidImage(7, 5, [20, 90, 160, 255]);
    for (const edge of ["clamp", "wrap", "reflect"] as const) {
      const out = motionBlurCpu(uniform, { angle: 40, distance: 9, centered: false, edge });
      expect([...out.data], edge).toEqual([...uniform.data]);
    }
  });

  it("fades the pixels nearest a transparent border", () => {
    const input = solidImage(4, 1, [200, 0, 0, 255]);
    const out = motionBlurCpu(input, {
      angle: 0,
      distance: 8,
      centered: true,
      edge: "transparent",
    });
    const alpha = (x: number) => out.data[x * 4 + 3] ?? 0;
    expect(alpha(0)).toBeLessThan(alpha(1));
    expect(alpha(1)).toBeLessThan(255);
  });

  it("returns the input unchanged for a zero distance", () => {
    const input = solidImage(3, 2, [1, 2, 3, 128]);
    const out = motionBlurCpu(input, { angle: 90, distance: 0, centered: false, edge: "wrap" });
    expect([...out.data]).toEqual([...input.data]);
  });
});

describe("Motion Blur binding", () => {
  it("reads its parameters and runs the CPU reference", () => {
    const binding = motionBlurBinding();
    const params = binding.params({ angle: -30 });
    expect(params).toMatchObject({ angle: -30, distance: 10, edge: "clamp" });
    expect(binding.cpu(solidImage(6, 4, [9, 9, 9, 255]), params).height).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(MOTION_BLUR_ID);
  });
});
