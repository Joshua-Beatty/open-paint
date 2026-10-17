/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  planRelief,
  RELIEF_ID,
  reliefBinding,
  reliefCpu,
  reliefDescriptor,
  reliefParams,
  reliefSchema,
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

describe("Relief descriptor and schema", () => {
  it("is a configurable Stylize effect in document space", () => {
    expect(reliefDescriptor()).toMatchObject({
      id: RELIEF_ID,
      label: "effect.relief",
      category: "effect",
      submenu: "stylize",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("has one angle chooser from -180 to 180 degrees, defaulting to 45", () => {
    expect(reliefSchema().properties[0]).toMatchObject({
      key: "angle",
      kind: "double",
      defaultValue: 45,
      min: -180,
      max: 180,
      control: { controlType: "anglePicker" },
    });
    expect(resolveValues(reliefSchema(), {})).toMatchObject({ angle: 45 });
    expect(reliefParams({ angle: -250 })).toEqual({ angle: -180 });
  });
});

describe("Relief CPU reference", () => {
  it("leaves a flat image unchanged, alpha included", () => {
    const input = flat(4, 3, [90, 40, 200, 77]);
    const out = reliefCpu(input, { angle: 45 });
    expect([...out.data]).toEqual([...input.data]);
  });

  it("lights a rising edge and darkens a falling one", () => {
    const rising = new Surface(
      4,
      1,
      new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]),
    );
    expect(reliefCpu(rising, { angle: 45 }).data[1 * 4] ?? 0).toBe(255);
    const falling = new Surface(
      4,
      1,
      new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255]),
    );
    expect(reliefCpu(falling, { angle: 45 }).data[1 * 4] ?? 0).toBe(0);
  });

  it("gives a plan of nine weights with a unit center", () => {
    const weights = planRelief({ angle: 45 }).weights;
    expect(weights).toHaveLength(9);
    expect(weights[4]).toBe(1);
  });
});

describe("Relief binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = reliefBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ angle: -90 }));
    expect(out.width).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(RELIEF_ID);
  });
});
