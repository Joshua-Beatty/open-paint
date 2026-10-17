/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addNoiseSeed,
  createInstanceSeed,
  crystalizeSeed,
  dentsSeed,
  frostMapRandoms,
  frostSeed,
  noiseCpu,
  SEED_MAX,
  seedProperty,
} from "./rng";
import { PIXEL_NOISE_WGSL, PIXEL_RNG_WGSL } from "./rng-wgsl";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("Randomize button (FX-A-00-05)", () => {
  it("is an integer seed from 0 to 255, default 0, shown as a wrapping increment button", () => {
    expect(SEED_MAX).toBe(255);
    expect(seedProperty()).toMatchObject({
      kind: "int32",
      key: "seed",
      defaultValue: 0,
      min: 0,
      max: 255,
      control: {
        controlType: "incrementButton",
        buttonText: "property.randomize",
        rangeWraps: true,
      },
    });
  });
});

describe("instance and user seeds", () => {
  it("draws a 32-bit instance seed that changes between effect instances", () => {
    const seeds = Array.from({ length: 8 }, () => createInstanceSeed());
    for (const seed of seeds) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("combines the user and instance seeds with each effect's formula", () => {
    expect(addNoiseSeed(0xf0, 0x0f)).toBe(0xff);
    expect(addNoiseSeed(5, 0x1_0000_0005)).toBe(0);
    expect(crystalizeSeed(2, 0)).toBe(3_132_167_882);
    expect(crystalizeSeed(1, 0x1_05)).toBe((1_566_083_941 + 5) >>> 0);
    expect(dentsSeed(200, 0x1ff)).toBe(199);
    expect(frostSeed(7, 0x105, 0xf0)).toBe(7 ^ (5 ^ 0xf0));
  });

  it("gives one random value per Frosted Glass sample map, repeatably for an instance", () => {
    const randoms = frostMapRandoms(0x1234_5678, 5);
    expect(randoms.length).toBe(5);
    expect(Array.from(frostMapRandoms(0x1234_5678, 5))).toEqual(Array.from(randoms));
    expect(new Set(randoms).size).toBe(5);
  });
});

describe("per-pixel noise", () => {
  it("is opaque, repeatable, and changes with the seed", () => {
    const a = noiseCpu(6, 5, 0);
    expect(a.width).toBe(6);
    expect(a.height).toBe(5);
    for (let i = 3; i < a.data.length; i += 4) expect(a.data[i]).toBe(255);
    expect(Array.from(noiseCpu(6, 5, 0).data)).toEqual(Array.from(a.data));
    expect(Array.from(noiseCpu(6, 5, 1).data)).not.toEqual(Array.from(a.data));
  });

  it("ships the WGSL twin with the same generator and entry point", () => {
    expect(PIXEL_RNG_WGSL).toContain("fn pcg_hash(");
    expect(PIXEL_RNG_WGSL).toContain("(1.0 / 16777216.0)");
    expect(PIXEL_NOISE_WGSL).toContain("@compute @workgroup_size(8, 8)");
    expect(PIXEL_NOISE_WGSL).toContain("fn main(");
  });
});
