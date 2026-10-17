/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  TEMPERATURE_TINT_ID,
  TEMPERATURE_TINT_OP,
  temperatureTintBinding,
  temperatureTintCpu,
  temperatureTintDescriptor,
  temperatureTintParams,
  temperatureTintPlan,
  temperatureTintSchema,
} from "./temperature-tint";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const SAMPLE = new Surface(
  4,
  1,
  new Uint8ClampedArray([128, 128, 128, 255, 10, 200, 90, 255, 250, 40, 0, 0, 255, 255, 255, 255]),
);

describe("Temperature / Tint descriptor (ADJ-TT)", () => {
  it("is a configurable adjustment with two sliders from -100 to 100", () => {
    expect(temperatureTintDescriptor()).toMatchObject({
      id: TEMPERATURE_TINT_ID,
      category: "adjustment",
      configurable: true,
    });
    const [temperature, tint] = temperatureTintSchema().properties;
    expect(temperature).toMatchObject({ key: "temperature", defaultValue: 0, min: -100, max: 100 });
    expect(tint).toMatchObject({ key: "tint", defaultValue: 0, min: -100, max: 100 });
  });

  it("clamps stored values to the schema", () => {
    expect(temperatureTintParams({ temperature: -500, tint: 30 })).toEqual({
      temperature: -100,
      tint: 30,
    });
    expect(resolveValues(temperatureTintSchema(), {}).tint).toBe(0);
  });

  it("registers as a binding with the same descriptor", () => {
    expect(temperatureTintBinding().descriptor.id).toBe(TEMPERATURE_TINT_ID);
  });
});

describe("Temperature / Tint math (ADJ-TT-02)", () => {
  it("is the identity at (0, 0)", () => {
    expect([...temperatureTintCpu(SAMPLE, { temperature: 0, tint: 0 }).data]).toEqual([
      ...SAMPLE.data,
    ]);
  });

  it("warms with positive temperature and cools with negative", () => {
    const warm = temperatureTintCpu(SAMPLE, { temperature: 100, tint: 0 }).data;
    expect(warm[0]).toBeGreaterThan(128);
    expect(warm[2]).toBeLessThan(128);
    const cool = temperatureTintCpu(SAMPLE, { temperature: -100, tint: 0 }).data;
    expect(cool[0]).toBeLessThan(128);
    expect(cool[2]).toBeGreaterThan(128);
  });

  it("adds green with positive tint and magenta with negative", () => {
    const green = temperatureTintCpu(SAMPLE, { temperature: 0, tint: 100 }).data;
    expect(green[1]).toBeGreaterThan(128);
    const magenta = temperatureTintCpu(SAMPLE, { temperature: 0, tint: -100 }).data;
    expect(magenta[1]).toBeLessThan(128);
  });

  it("keeps alpha, including for transparent pixels", () => {
    const src = new Surface(1, 1, new Uint8ClampedArray([60, 60, 60, 0]));
    expect(temperatureTintCpu(src, { temperature: 80, tint: -50 }).data[3]).toBe(0);
  });

  it("plans the three linear-light gains for the WGSL twin", () => {
    const plan = temperatureTintPlan({ temperature: 40, tint: 20 });
    expect(plan.op).toBe(TEMPERATURE_TINT_OP);
    expect(plan.gains).toHaveLength(3);
    expect(plan.gains[0] ?? 0).toBeGreaterThan(plan.gains[2] ?? 0);
  });
});
