/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DENTS_ID,
  dentsBinding,
  dentsCpu,
  dentsDescriptor,
  dentsParams,
  dentsPlan,
  dentsSchema,
} from "./dents";
import { builtinEffectBindings } from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** An opaque image whose red channel runs along x and green along y. */
function gradientImage(width: number, height: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data.set([(x * 255) / (width - 1), (y * 255) / (height - 1), 90, 255], i);
    }
  }
  return new Surface(width, height, data);
}

describe("Dents descriptor and schema", () => {
  it("is a configurable Distort effect", () => {
    expect(dentsDescriptor(2)).toMatchObject({
      id: DENTS_ID,
      label: "effect.dents",
      category: "effect",
      submenu: "distort",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists the noise controls, Quality and the Randomize seed, in order", () => {
    expect(dentsSchema(2).properties.map((property) => property.key)).toEqual([
      "scale",
      "refraction",
      "detail",
      "turbulence",
      "angle",
      "quality",
      "seed",
    ]);
  });

  it("gives the spec's ranges and defaults (FX-DIST-DENTS-02)", () => {
    const property = (key: string) =>
      dentsSchema(2).properties.find((candidate) => candidate.key === key);
    expect(property("scale")).toMatchObject({ kind: "double", defaultValue: 25, min: 0, max: 200 });
    expect(property("refraction")).toMatchObject({ defaultValue: 50, min: 0, max: 200 });
    expect(property("detail")).toMatchObject({ defaultValue: 10, min: 0, max: 100 });
    expect(property("turbulence")).toMatchObject({ defaultValue: 10, min: 0, max: 100 });
    expect(property("angle")).toMatchObject({ defaultValue: 0, min: -180, max: 180 });
    expect(property("angle")?.control).toMatchObject({
      controlType: "anglePicker",
      rangeWraps: true,
    });
    expect(property("quality")).toMatchObject({ kind: "int32", min: 1, max: 8, defaultValue: 2 });
  });
});

describe("Dents parameters and plan", () => {
  it("reads defaults, clamps values and takes the instance seed from the caller", () => {
    expect(dentsParams({}, 3, 5)).toEqual({
      scale: 25,
      refraction: 50,
      detail: 10,
      turbulence: 10,
      angle: 0,
      quality: 3,
      userSeed: 0,
      instanceSeed: 5,
    });
    expect(dentsParams({ scale: 900, angle: 270 }, 1).scale).toBe(200);
    expect(dentsParams({ angle: -270 }, 1).angle).toBe(-180);
  });

  it("plans the region with the noise centered on it and ten values", () => {
    const plan = [...dentsPlan(dentsParams({}, 1), 40, 24)];
    expect(plan).toHaveLength(10);
    expect(plan[0]).toBe(20);
    expect(plan[1]).toBe(12);
    expect(plan[9]).toBe(0);
  });
});

describe("Dents CPU reference", () => {
  it("returns the input when Refraction is zero", () => {
    const input = gradientImage(20, 12);
    const out = dentsCpu(input, dentsParams({ refraction: 0 }, 1));
    const differences = [...out.data].map((value, i) => Math.abs(value - (input.data[i] ?? 0)));
    expect(Math.max(...differences)).toBeLessThanOrEqual(1);
  });

  it("displaces the image when Refraction is set", () => {
    const input = gradientImage(40, 24);
    const out = dentsCpu(input, dentsParams({ refraction: 150 }, 1));
    expect([...out.data]).not.toEqual([...input.data]);
  });

  it("changes the pattern with the instance seed, even at Seed 0 (FX-A-00-05)", () => {
    const input = gradientImage(40, 24);
    const first = dentsCpu(input, dentsParams({}, 1, 1));
    const second = dentsCpu(input, dentsParams({}, 1, 2));
    expect([...first.data]).not.toEqual([...second.data]);
  });

  it("gives the same pattern for the same seeds", () => {
    const input = gradientImage(40, 24);
    const params = dentsParams({ seed: 9, angle: 35 }, 2, 200);
    expect([...dentsCpu(input, params).data]).toEqual([...dentsCpu(input, params).data]);
  });
});

describe("Dents binding", () => {
  it("reads its parameters and runs the CPU reference", () => {
    const binding = dentsBinding(1);
    const params = binding.params({ scale: 12 }, { width: 40, height: 24 }, 3);
    expect(params).toMatchObject({ scale: 12, quality: 1, instanceSeed: 3 });
    const out = binding.cpu(gradientImage(8, 8), params);
    expect(out.width).toBe(8);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(DENTS_ID);
  });
});
