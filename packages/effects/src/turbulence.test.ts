/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  TURBULENCE_ID,
  TURBULENCE_PARAMS_BYTES,
  TURBULENCE_WGSL,
  type TurbulenceParams,
  turbulenceCpu,
  turbulenceDescriptor,
  turbulenceParams,
  turbulencePlan,
  turbulenceSchema,
  turbulenceStitch,
  turbulenceTables,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const BASE: TurbulenceParams = {
  octaves: 4,
  period: 16,
  tile: 64,
  fractal: false,
  seed: 1,
  mode: 0,
  origin: undefined,
};

/** A fully transparent image: Overwrite replaces it with the turbulence, so the result is the noise. */
function blank(width: number, height: number): Surface {
  return new Surface(width, height, new Uint8ClampedArray(width * height * 4));
}

describe("Turbulence descriptor and schema (FX-RENDER-TURB-01)", () => {
  it("is a configurable GPU effect in the Render submenu, in document space", () => {
    expect(turbulenceDescriptor()).toMatchObject({
      id: TURBULENCE_ID,
      label: "effect.turbulence",
      category: "effect",
      submenu: "render",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("lists Octaves, Period, Size, Noise, Seed and Blend Mode with the spec's defaults", () => {
    const schema = turbulenceSchema();
    expect(schema.properties.map((property) => property.key)).toEqual([
      "octaves",
      "period",
      "tile",
      "noise",
      "seed",
      "blendMode",
    ]);
    const find = (key: string) => schema.properties.find((p) => p.key === key);
    expect(find("octaves")).toMatchObject({ kind: "int32", defaultValue: 4, min: 1, max: 15 });
    expect(find("period")).toMatchObject({
      kind: "double",
      defaultValue: 100,
      min: 0.1,
      max: 1024,
    });
    expect(find("period")?.control).toMatchObject({ useExponentialScale: true });
    expect(find("tile")).toMatchObject({ kind: "int32", defaultValue: 4096, min: 1, max: 4096 });
    expect(find("noise")).toMatchObject({ kind: "choice", defaultValue: "turbulence" });
    expect(find("seed")).toMatchObject({ kind: "int32", defaultValue: 1, min: 0, max: 255 });
    expect(find("blendMode")).toMatchObject({ kind: "choice", defaultValue: 0 });
  });

  it("offers Fractal sum and Turbulence as the Noise choices", () => {
    const noise = turbulenceSchema().properties.find((p) => p.key === "noise");
    if (noise?.kind !== "choice") throw new Error("expected the Noise drop-down");
    expect(noise.options.map((option) => option.value)).toEqual(["fractalSum", "turbulence"]);
  });

  it("reads the defaults, the noise choice and the instance seed", () => {
    expect(turbulenceParams({})).toEqual({
      octaves: 4,
      period: 100,
      tile: 4096,
      fractal: false,
      seed: 1,
      mode: 0,
      origin: undefined,
    });
    const read = turbulenceParams({ noise: "fractalSum", seed: 8 }, undefined, 3, { x: 2, y: 9 });
    expect(read).toMatchObject({ fractal: true, seed: 8 ^ 3, origin: { x: 2, y: 9 } });
  });

  it("has a shader with the mix snippet, the Turbulence entry point and the tables", () => {
    expect(TURBULENCE_WGSL).toContain("fn turbulence(");
    expect(TURBULENCE_WGSL).toContain("fn mix_pixel(");
    expect(TURBULENCE_WGSL).toContain("var<storage, read> lattice");
    expect(TURBULENCE_WGSL).toContain("var<storage, read> gradients");
    expect(TURBULENCE_PARAMS_BYTES).toBe(64);
  });

  it("is registered before Rotate / Zoom, the last built-in effect", () => {
    expect(builtinEffectBindings(1).at(-13)?.descriptor.id).toBe(TURBULENCE_ID);
  });
});

describe("Turbulence Rust reference", () => {
  it("writes the flat parameter array in the order the Rust reader expects", () => {
    const plan = turbulencePlan({ ...BASE, origin: { x: 3, y: 4 }, fractal: true, mode: 5 });
    expect(Array.from(plan)).toEqual([3, 4, 4, 16, 64, 1, 1, 5]);
  });

  it("snaps the period to whole cycles across the tile, and the tables have the SVG sizes", () => {
    const [freqX = 0, freqY = 0, width = 0, wrapX = 0] = turbulenceStitch(100, 4096);
    expect(Math.abs(freqX * 4096 - Math.round(freqX * 4096))).toBeLessThan(1e-3);
    expect(Math.abs(freqY * 4096 - Math.round(freqY * 4096))).toBeLessThan(1e-3);
    expect(wrapX).toBe(4096 + width);
    const { lattice, gradients } = turbulenceTables(7);
    expect(lattice).toHaveLength(514);
    expect(gradients).toHaveLength(4 * 514 * 2);
  });

  it("is deterministic, depends on the seed, and differs between the two noise kinds", () => {
    const input = blank(32, 24);
    const turbulence = turbulenceCpu(input, { ...BASE, mode: 7 });
    expect(turbulenceCpu(input, { ...BASE, mode: 7 }).data).toEqual(turbulence.data);
    expect(turbulenceCpu(input, { ...BASE, mode: 7, seed: 2 }).data).not.toEqual(turbulence.data);
    expect(turbulenceCpu(input, { ...BASE, mode: 7, fractal: true }).data).not.toEqual(
      turbulence.data,
    );
  });

  it("repeats the tile across the canvas, so one tile away is the same pixel", () => {
    const region = turbulenceCpu(blank(4, 4), {
      ...BASE,
      mode: 2,
      origin: { x: 64, y: 64 },
    });
    const first = turbulenceCpu(blank(4, 4), { ...BASE, mode: 2, origin: { x: 0, y: 0 } });
    expect(region.data).toEqual(first.data);
  });

  it("gives the same pixels for a region as for the same place in the whole canvas", () => {
    const whole = turbulenceCpu(blank(32, 24), { ...BASE, mode: 2, origin: { x: 0, y: 0 } });
    const region = turbulenceCpu(blank(4, 3), { ...BASE, mode: 2, origin: { x: 5, y: 7 } });
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        const at = ((y + 7) * 32 + x + 5) * 4;
        const here = (y * 4 + x) * 4;
        expect(Array.from(region.data.slice(here, here + 4))).toEqual(
          Array.from(whole.data.slice(at, at + 4)),
        );
      }
    }
  });

  it("is 0.5 at the origin for a fractal sum, since every noise term vanishes on the lattice", () => {
    const out = turbulenceCpu(blank(1, 1), { ...BASE, fractal: true, mode: 2, origin: undefined });
    expect(Array.from(out.data)).toEqual([128, 128, 128, 128]);
  });

  it("varies across the tile", () => {
    const out = turbulenceCpu(blank(16, 16), { ...BASE, mode: 2 });
    const reds = new Set(out.data.filter((_, i) => i % 4 === 0));
    expect(reds.size).toBeGreaterThan(20);
  });

  it("composites over an opaque layer: an opaque layer keeps its alpha", () => {
    const data = new Uint8ClampedArray(64);
    for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : 90;
    const out = turbulenceCpu(new Surface(4, 4, data), { ...BASE, mode: 0 });
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });
});
