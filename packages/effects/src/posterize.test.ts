/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  POSTERIZE_DEFAULT_LEVELS,
  POSTERIZE_ID,
  POSTERIZE_OP,
  posterizeBinding,
  posterizeCpu,
  posterizeDescriptor,
  posterizeParams,
  posterizePlan,
  posterizeSchema,
} from "./posterize";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("Posterize schema (ADJ-POSTERIZE table)", () => {
  it("is a configurable adjustment listing each channel, its levels and Linked, in order", () => {
    expect(posterizeDescriptor()).toMatchObject({
      id: POSTERIZE_ID,
      category: "adjustment",
      configurable: true,
      kind: "gpuImage",
    });
    expect(posterizeSchema().properties.map((property) => property.key)).toEqual([
      "red",
      "redLevels",
      "green",
      "greenLevels",
      "blue",
      "blueLevels",
      "alpha",
      "alphaLevels",
      "linked",
    ]);
  });

  it("starts with 16 levels, Alpha off and Linked on", () => {
    expect(POSTERIZE_DEFAULT_LEVELS).toBe(16);
    expect(resolveValues(posterizeSchema(), {})).toMatchObject({
      red: true,
      redLevels: 16,
      green: true,
      greenLevels: 16,
      blue: true,
      blueLevels: 16,
      alpha: false,
      alphaLevels: 16,
      linked: true,
    });
  });

  it("gives each level slider the range 2 to 64 in steps of 1", () => {
    const levels = posterizeSchema().properties.filter((property) =>
      property.key.endsWith("Levels"),
    );
    expect(levels).toHaveLength(4);
    for (const level of levels) {
      expect(level).toMatchObject({ kind: "int32", min: 2, max: 64 });
    }
  });

  it("makes each level slider read-only while its checkbox is off, and links the levels", () => {
    expect(posterizeSchema().rules).toEqual([
      { kind: "readOnlyWhenBoolean", target: "redLevels", source: "red" },
      { kind: "readOnlyWhenBoolean", target: "greenLevels", source: "green" },
      { kind: "readOnlyWhenBoolean", target: "blueLevels", source: "blue" },
      { kind: "readOnlyWhenBoolean", target: "alphaLevels", source: "alpha" },
      {
        kind: "linkValuesWhenBoolean",
        source: "linked",
        when: true,
        keys: ["redLevels", "greenLevels", "blueLevels", "alphaLevels"],
      },
    ]);
  });
});

describe("Posterize parameters", () => {
  it("clamps each level to 2 to 64 and reads 0 for a channel whose checkbox is off", () => {
    expect(
      posterizeParams({
        red: true,
        redLevels: 500,
        green: true,
        greenLevels: 1,
        blue: false,
        blueLevels: 9,
        alpha: true,
        alphaLevels: 4,
        linked: false,
      }),
    ).toEqual({ levels: [64, 2, 0, 4] });
  });

  it("copies the red level to every slider while Linked is on", () => {
    expect(posterizeParams({ linked: true, redLevels: 8, greenLevels: 3 })).toEqual({
      levels: [8, 8, 8, 0],
    });
  });
});

describe("Posterize math (ADJ-POSTERIZE-01)", () => {
  it("maps each value to the nearest of the evenly spaced levels", () => {
    for (let n = 2; n <= 64; n++) {
      const src = new Surface(256, 1);
      for (let v = 0; v < 256; v++) src.data.set([v, v, v, 255], v * 4);
      const out = posterizeCpu(src, { levels: [n, n, n, 0] });
      for (let v = 0; v < 256; v++) {
        const expected = Math.round((v / 255) * (n - 1)) / (n - 1);
        expect(out.data[v * 4], `n ${n} v ${v}`).toBe(Math.round(expected * 255));
      }
    }
  });

  it("leaves unposterized channels and alpha alone when their level is 0", () => {
    const src = new Surface(1, 1, new Uint8ClampedArray([100, 200, 30, 77]));
    expect([...posterizeCpu(src, { levels: [4, 4, 4, 0] }).data]).toEqual([85, 170, 0, 77]);
    expect([...posterizeCpu(src, { levels: [0, 0, 0, 0] }).data]).toEqual([100, 200, 30, 77]);
  });

  it("plans the level counts for the WGSL twin", () => {
    const plan = posterizePlan({ levels: [4, 0, 2, 8] });
    expect(plan.op).toBe(POSTERIZE_OP);
    expect([...plan.posterize]).toEqual([4, 0, 2, 8]);
  });

  it("binds the parameter reader and the CPU reference", () => {
    const binding = posterizeBinding();
    const src = new Surface(1, 1, new Uint8ClampedArray([120, 60, 30, 255]));
    const params = binding.params({ red: true, redLevels: 3, green: false, linked: false });
    expect([...binding.cpu(src, params).data]).toEqual([
      ...posterizeCpu(src, { levels: [3, 0, 16, 0] }).data,
    ]);
  });
});
