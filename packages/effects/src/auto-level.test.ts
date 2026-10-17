/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { identityPlan } from "./adjustments";
import {
  AUTO_LEVEL_ID,
  AUTO_LEVEL_OP,
  autoLevelBinding,
  autoLevelCpu,
  autoLevelDescriptor,
  autoLevelPlan,
} from "./auto-level";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** Gray pixels with alpha 255, one per value. */
function gray(values: readonly number[]): Surface {
  const data = new Uint8ClampedArray(values.length * 4);
  values.forEach((value, i) => {
    data.set([value, value, value, 255], i * 4);
  });
  return new Surface(values.length, 1, data);
}

describe("Auto-Level descriptor (ADJ-MENU-03, ADJ-COMMON-01)", () => {
  it("is a non-configurable adjustment with no parameters", () => {
    const descriptor = autoLevelDescriptor();
    expect(descriptor).toMatchObject({
      id: AUTO_LEVEL_ID,
      category: "adjustment",
      configurable: false,
      kind: "gpuImage",
    });
    expect(descriptor.schema.properties).toEqual([]);
    expect(descriptor.submenu).toBeUndefined();
  });

  it("gets the WGSL op and identity exponents and Brightness numbers from its plan", () => {
    expect(AUTO_LEVEL_OP).toBe(4);
    const plan = autoLevelPlan(gray([10, 200]));
    expect(plan.op).toBe(AUTO_LEVEL_OP);
    expect(plan.levels).toHaveLength(15);
    expect([...plan.exponents]).toEqual([...identityPlan(0).exponents]);
    expect([...plan.brightnessContrast]).toEqual([0, 1, 1]);
  });
});

describe("Auto-Level histograms read only the selection (ADJ-COMMON-05)", () => {
  const selected = Array.from({ length: 81 }, (_, i) => 60 + i);
  const outliers = [0, 0, 255, 255];

  it("ignores unselected pixels, so the result matches the selected pixels alone", () => {
    const full = gray([...selected, ...outliers]);
    const coverage = [...selected.map(() => 255), 0, 0, 0, 0];
    const masked = autoLevelCpu(full, coverage);
    const alone = autoLevelCpu(gray(selected));
    expect([...masked.data.slice(0, alone.data.length)]).toEqual([...alone.data]);
    expect(autoLevelPlan(full, coverage).levels).toEqual(autoLevelPlan(gray(selected)).levels);
  });

  it("analyses the whole layer when no coverage is given", () => {
    const full = gray([...selected, ...outliers]);
    expect(autoLevelPlan(full).levels).not.toEqual(autoLevelPlan(gray(selected)).levels);
    expect([...autoLevelCpu(full).data]).toEqual([
      ...autoLevelCpu(full, new Array(full.width * full.height).fill(255)).data,
    ]);
  });

  it("passes the coverage through the binding's CPU reference", () => {
    const full = gray([...selected, ...outliers]);
    const coverage = [...selected.map(() => 255), 0, 0, 0, 0];
    const out = autoLevelBinding().cpu(full, {}, coverage);
    expect([...out.data]).toEqual([...autoLevelCpu(full, coverage).data]);
  });
});

describe("Auto-Level stretches the range (ADJ-AUTOLEVEL-01)", () => {
  it("maps the percentile black and white points to 0 and 255, keeping alpha", () => {
    const values = Array.from({ length: 151 }, (_, i) => 50 + i);
    const out = autoLevelCpu(gray(values));
    expect(out.data[0]).toBe(0);
    expect(out.data[(values.length - 1) * 4]).toBe(255);
    expect(out.data[(values.length - 1) * 4 + 3]).toBe(255);
  });
});
