/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  planStraighten,
  STRAIGHTEN_ID,
  STRAIGHTEN_SAMPLING,
  straightenBinding,
  straightenCpu,
  straightenDescriptor,
  straightenParams,
  straightenSchema,
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

describe("Straighten descriptor and schema", () => {
  it("is a configurable Photo effect that works in linear light", () => {
    expect(straightenDescriptor()).toMatchObject({
      id: STRAIGHTEN_ID,
      label: "effect.straighten",
      category: "effect",
      submenu: "photo",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "linear", inputAlpha: "straight" } },
    });
  });

  it("lists Angle and then Sampling, with the spec's ranges and defaults", () => {
    const properties = straightenSchema().properties;
    expect(properties.map((property) => property.key)).toEqual(["angle", "sampling"]);
    expect(properties[0]).toMatchObject({
      kind: "double",
      defaultValue: 0,
      min: -45,
      max: 45,
      control: { controlType: "anglePicker" },
    });
    expect(properties[1]).toMatchObject({
      kind: "choice",
      defaultValue: "bicubic",
      label: "property.noCaption",
      control: { description: "property.sampling" },
    });
  });

  it("offers the three sampling modes in dialog order", () => {
    expect(STRAIGHTEN_SAMPLING).toEqual(["bicubic", "bilinear", "nearestNeighbor"]);
    const sampling = straightenSchema().properties[1];
    expect(
      sampling?.kind === "choice" ? sampling.options.map((option) => option.value) : [],
    ).toEqual([...STRAIGHTEN_SAMPLING]);
  });

  it("uses the defaults and clamps the angle to plus or minus 45", () => {
    expect(resolveValues(straightenSchema(), {})).toMatchObject({
      angle: 0,
      sampling: "bicubic",
    });
    expect(straightenParams({ angle: 80, sampling: "bilinear" })).toEqual({
      angle: 45,
      sampling: "bilinear",
    });
    expect(straightenParams({ angle: -60, sampling: "nearestNeighbor" }).angle).toBe(-45);
  });
});

describe("Straighten plan", () => {
  it("is the identity matrix at zero degrees, with the sampling code", () => {
    const plan = planStraighten({ angle: 0, sampling: "nearestNeighbor" }, 40, 24);
    expect(Array.from(plan.matrix, Math.abs)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(plan.sampling).toBe(2);
  });

  it("scales the rotated layer up, so a tilted layer has no transparent corners", () => {
    const plan = planStraighten({ angle: 20, sampling: "bicubic" }, 40, 24);
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = plan.matrix;
    const corner = (x: number, y: number) => [a * x + c * y + e, b * x + d * y + f];
    for (const [x, y] of [
      [0, 0],
      [40, 0],
      [0, 24],
      [40, 24],
    ] as const) {
      const [sx, sy] = corner(x, y);
      expect(sx).toBeGreaterThanOrEqual(-1e-4);
      expect(sx).toBeLessThanOrEqual(40 + 1e-4);
      expect(sy).toBeGreaterThanOrEqual(-1e-4);
      expect(sy).toBeLessThanOrEqual(24 + 1e-4);
    }
  });
});

describe("Straighten CPU reference", () => {
  it("returns a same-sized surface that reproduces the input at zero degrees", () => {
    const input = flat(6, 4, [70, 140, 210, 255]);
    const out = straightenCpu(input, { angle: 0, sampling: "bicubic" });
    expect(out.width).toBe(6);
    expect(out.height).toBe(4);
    expect([...out.data]).toEqual([...input.data]);
  });

  it("keeps a flat image flat under a tilt", () => {
    const out = straightenCpu(flat(16, 16, [40, 120, 200, 255]), {
      angle: -30,
      sampling: "bilinear",
    });
    expect(out.data[(8 * 16 + 8) * 4 + 3]).toBe(255);
    expect(out.data[(8 * 16 + 8) * 4] ?? 0).toBeGreaterThanOrEqual(39);
    expect(out.data[(8 * 16 + 8) * 4] ?? 0).toBeLessThanOrEqual(41);
  });
});

describe("Straighten binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = straightenBinding();
    const out = binding.cpu(
      flat(4, 4, [51, 51, 51, 255]),
      binding.params({ angle: 5, sampling: "nearestNeighbor" }),
    );
    expect(out.width).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(STRAIGHTEN_ID);
  });
});
