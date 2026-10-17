/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  FROST_SAMPLE_COUNTS,
  FROSTED_GLASS_ID,
  frostedGlassBinding,
  frostedGlassCpu,
  frostedGlassDescriptor,
  frostedGlassParams,
  frostedGlassPlan,
  frostedGlassSchema,
  frostedGlassSeeds,
} from "./index";

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

describe("Frosted Glass descriptor and schema", () => {
  it("is a configurable Distort effect", () => {
    expect(frostedGlassDescriptor()).toMatchObject({
      id: FROSTED_GLASS_ID,
      label: "effect.frostedGlass",
      category: "effect",
      submenu: "distort",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists the radii, Diffusion, Smoothness and Seed, in that order", () => {
    const keys = frostedGlassSchema().properties.map((property) => property.key);
    expect(keys).toEqual(["maximumRadius", "minimumRadius", "diffusion", "smoothness", "seed"]);
  });

  it("uses the spec's ranges and defaults", () => {
    const find = (key: string) =>
      frostedGlassSchema().properties.find((property) => property.key === key);
    expect(find("maximumRadius")).toMatchObject({ defaultValue: 3, min: 0, max: 500 });
    expect(find("minimumRadius")).toMatchObject({ defaultValue: 0, min: 0, max: 500 });
    expect(find("diffusion")).toMatchObject({ defaultValue: 1, min: 0.01, max: 3 });
    expect(find("smoothness")).toMatchObject({ kind: "int32", defaultValue: 2, min: 1, max: 8 });
    expect(find("seed")).toMatchObject({
      defaultValue: 0,
      min: 0,
      max: 255,
      control: { controlType: "incrementButton", rangeWraps: true },
    });
  });

  it("soft-links the radii so the minimum never passes the maximum", () => {
    const params = frostedGlassParams({ maximumRadius: 2, minimumRadius: 7 });
    expect(params.minimumRadius).toBeLessThanOrEqual(params.maximumRadius);
  });
});

describe("Frosted Glass parameters", () => {
  it("reads the defaults and clamps values to the schema", () => {
    expect(frostedGlassParams({}, 5)).toEqual({
      maximumRadius: 3,
      minimumRadius: 0,
      diffusion: 1,
      smoothness: 2,
      userSeed: 0,
      instanceSeed: 5,
    });
    expect(frostedGlassParams({ smoothness: 99, diffusion: -4 })).toMatchObject({
      smoothness: 8,
      diffusion: 0.01,
    });
  });

  it("plans the radii and the diffusion for the kernel", () => {
    const plan = frostedGlassPlan(
      frostedGlassParams({ maximumRadius: 6, minimumRadius: 2, diffusion: 0.5 }),
    );
    expect([...plan]).toEqual([2, 6, Math.fround(0.5)]);
  });
});

describe("Frosted Glass seeds", () => {
  it("gives one seed per Fibonacci sample of the Smoothness", () => {
    expect(FROST_SAMPLE_COUNTS).toEqual([1, 2, 3, 5, 8, 13, 21, 34]);
    for (const smoothness of [1, 2, 5, 8]) {
      const params = frostedGlassParams({ smoothness }, 77);
      const count = FROST_SAMPLE_COUNTS[smoothness - 1];
      expect(frostedGlassSeeds(params)).toHaveLength(count ?? 0);
    }
  });

  it("changes with the instance seed even at user seed 0", () => {
    const first = frostedGlassSeeds(frostedGlassParams({}, 0x1234_5678));
    const second = frostedGlassSeeds(frostedGlassParams({}, 0x8765_4321));
    expect([...first]).not.toEqual([...second]);
  });

  it("gives each sample map its own seed", () => {
    const seeds = frostedGlassSeeds(frostedGlassParams({ smoothness: 8 }, 9));
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});

describe("Frosted Glass CPU reference", () => {
  it("returns the input unchanged when the scatter radius is zero", () => {
    const input = gradientImage(20, 12);
    const out = frostedGlassCpu(input, frostedGlassParams({ maximumRadius: 0 }));
    expect(out.width).toBe(20);
    expect([...out.data]).toEqual([...input.data]);
  });

  it("keeps a uniform image uniform", () => {
    const input = new Surface(9, 7, new Uint8ClampedArray(9 * 7 * 4));
    for (let i = 0; i < input.data.length; i += 4) input.data.set([40, 80, 120, 255], i);
    const out = frostedGlassCpu(input, frostedGlassParams({ maximumRadius: 8, minimumRadius: 2 }));
    expect([...out.data]).toEqual([...input.data]);
  });

  it("scatters the pixels of a sharp edge, so the output differs from the input", () => {
    const input = gradientImage(24, 16);
    const out = frostedGlassCpu(input, frostedGlassParams({ maximumRadius: 6, smoothness: 4 }, 3));
    expect([...out.data]).not.toEqual([...input.data]);
  });
});

describe("Frosted Glass binding", () => {
  it("reads its parameters, with the instance seed from the session", () => {
    const binding = frostedGlassBinding();
    const params = binding.params({ maximumRadius: 4 }, undefined, 42);
    expect(params).toMatchObject({ maximumRadius: 4, instanceSeed: 42 });
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(FROSTED_GLASS_ID);
  });
});
