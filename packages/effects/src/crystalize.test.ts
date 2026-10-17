/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CRYSTALIZE_ID,
  CRYSTALIZE_MAX_QUALITY,
  crystalizeBinding,
  crystalizeCpu,
  crystalizeDescriptor,
  crystalizeParams,
  crystalizePlan,
  crystalizeSchema,
} from "./crystalize";
import { builtinEffectBindings } from "./index";
import { crystalizeSeed } from "./rng";

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

describe("Crystalize descriptor and schema", () => {
  it("is a configurable Distort effect", () => {
    expect(crystalizeDescriptor(2)).toMatchObject({
      id: CRYSTALIZE_ID,
      label: "effect.crystalize",
      category: "effect",
      submenu: "distort",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Cell Size, Quality and the Randomize seed, in that order", () => {
    const schema = crystalizeSchema(2);
    expect(schema.properties.map((property) => property.key)).toEqual([
      "cellSize",
      "quality",
      "seed",
    ]);
    expect(schema.properties.find((property) => property.key === "cellSize")).toMatchObject({
      kind: "int32",
      defaultValue: 8,
      min: 2,
      max: 250,
    });
  });

  it("uses a Randomize button for the seed, which wraps from 255 to 0 (FX-A-00-05)", () => {
    const seed = crystalizeSchema(2).properties.find((property) => property.key === "seed");
    expect(seed).toMatchObject({ kind: "int32", defaultValue: 0, min: 0, max: 255 });
    expect(seed?.control).toMatchObject({ controlType: "incrementButton", rangeWraps: true });
  });

  it("caps the Quality at 5, and takes its default from the Default Quality Level", () => {
    const quality = (level: number) =>
      crystalizeSchema(level).properties.find((property) => property.key === "quality");
    expect(quality(3)).toMatchObject({ kind: "int32", min: 1, max: CRYSTALIZE_MAX_QUALITY });
    expect(quality(3)).toMatchObject({ defaultValue: 3 });
    expect(quality(8)).toMatchObject({ defaultValue: 5 });
  });
});

describe("Crystalize parameters and plan", () => {
  it("reads defaults and takes the instance seed from the caller", () => {
    expect(crystalizeParams({}, 2, 99)).toEqual({
      cellSize: 8,
      quality: 2,
      userSeed: 0,
      instanceSeed: 99,
    });
    expect(crystalizeParams({}, 2).instanceSeed).toBe(0);
  });

  it("clamps the cell size to its range", () => {
    expect(crystalizeParams({ cellSize: 1000 }, 1).cellSize).toBe(250);
    expect(crystalizeParams({ cellSize: 0 }, 1).cellSize).toBe(2);
  });

  it("plans the cell size and the bytes of the effective seed", () => {
    const params = crystalizeParams({ cellSize: 6, seed: 3 }, 1, 40);
    const plan = [...crystalizePlan(params)];
    expect(plan).toHaveLength(5);
    expect(plan[0]).toBe(6);
    expect(crystalizeSeed(3, 40)).not.toBe(crystalizeSeed(3, 41));
  });
});

describe("Crystalize CPU reference", () => {
  it("keeps a flat image flat", () => {
    const flat = new Surface(16, 12, new Uint8ClampedArray(16 * 12 * 4).fill(120));
    for (let i = 3; i < flat.data.length; i += 4) flat.data[i] = 255;
    const out = crystalizeCpu(flat, crystalizeParams({ cellSize: 5 }, 2, 7));
    expect([...out.data]).toEqual([...flat.data]);
  });

  it("changes the pattern with the instance seed, even at Seed 0 (FX-A-00-05)", () => {
    const input = gradientImage(40, 24);
    const first = crystalizeCpu(input, crystalizeParams({ cellSize: 6 }, 1, 1));
    const second = crystalizeCpu(input, crystalizeParams({ cellSize: 6 }, 1, 2));
    expect([...first.data]).not.toEqual([...second.data]);
  });

  it("gives the same pattern for the same seeds", () => {
    const input = gradientImage(40, 24);
    const params = crystalizeParams({ cellSize: 6, seed: 5 }, 2, 12);
    expect([...crystalizeCpu(input, params).data]).toEqual([...crystalizeCpu(input, params).data]);
  });
});

describe("Crystalize binding", () => {
  it("reads the instance seed the session passes and runs the CPU reference", () => {
    const binding = crystalizeBinding(1);
    const params = binding.params({ cellSize: 4 }, { width: 40, height: 24 }, 77);
    expect(params).toMatchObject({ cellSize: 4, quality: 1, instanceSeed: 77 });
    const out = binding.cpu(gradientImage(8, 8), params);
    expect(out.width).toBe(8);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(CRYSTALIZE_ID);
  });
});
