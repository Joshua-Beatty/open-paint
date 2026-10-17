/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { identityPlan } from "./adjustments";
import { autoLevelPlan } from "./auto-level";
import { builtinEffectBindings } from "./index";
import {
  autoLevelParams,
  LEVELS_DIALOG_ID,
  LEVELS_ID,
  LEVELS_IDENTITY,
  LEVELS_OP,
  type LevelsParams,
  levelsBinding,
  levelsCpu,
  levelsDescriptor,
  levelsHistogram,
  levelsLut,
  levelsParams,
  levelsPlan,
  levelsPlanValues,
  levelsSchema,
  levelsValues,
} from "./levels";

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

const SHAPED: LevelsParams = {
  inputBlack: [0.1, 0, 0.2],
  inputWhite: [0.9, 1, 0.7],
  gamma: [1.5, 0.6, 1],
  outputBlack: [0, 0.1, 0],
  outputWhite: [1, 0.8, 0.9],
};

describe("Levels descriptor (ADJ-LEVELS-PARAMS, ADJ-MENU-03)", () => {
  it("is a configurable adjustment that names its custom dialog", () => {
    expect(levelsDescriptor()).toMatchObject({
      id: LEVELS_ID,
      category: "adjustment",
      configurable: true,
      kind: "gpuImage",
      customDialog: LEVELS_DIALOG_ID,
    });
  });

  it("declares the five parameters as per-channel triples with their ranges", () => {
    const properties = levelsSchema().properties;
    expect(properties.map((property) => property.key)).toEqual([
      "inputBlack",
      "inputWhite",
      "gamma",
      "outputBlack",
      "outputWhite",
    ]);
    expect(properties.every((property) => property.kind === "vector3")).toBe(true);
    expect(properties[0]).toMatchObject({
      defaultValue: { x: 0, y: 0, z: 0 },
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
    });
    expect(properties[2]).toMatchObject({
      defaultValue: { x: 1, y: 1, z: 1 },
      min: { x: 0.1, y: 0.1, z: 0.1 },
      max: { x: 10, y: 10, z: 10 },
    });
  });

  it("comes after the other adjustments, just before Curves, so the other effects keep their places", () => {
    const bindings = builtinEffectBindings(2);
    expect(bindings.at(-48)?.descriptor.id).toBe(LEVELS_ID);
  });
});

describe("Levels parameters", () => {
  it("reads the identity from empty values", () => {
    expect(levelsParams({})).toEqual(LEVELS_IDENTITY);
  });

  it("clamps out-of-range values to the schema", () => {
    const params = levelsParams({
      inputBlack: { x: 2, y: -1, z: 0.25 },
      gamma: { x: 50, y: 0, z: 1 },
    });
    expect(params.inputBlack).toEqual([1, 0, 0.25]);
    expect(params.gamma).toEqual([10, 0.1, 1]);
  });

  it("round-trips through the stored values", () => {
    expect(levelsParams(levelsValues(SHAPED))).toEqual(SHAPED);
  });
});

describe("Levels plan (ADJ-LEVELS-MATH)", () => {
  it("lays out five values per channel, R then G then B", () => {
    const plan = levelsPlanValues({
      inputBlack: [0.1, 0.2, 0.3],
      inputWhite: [0.4, 0.5, 0.6],
      gamma: [1, 2, 3],
      outputBlack: [0, 0.1, 0.2],
      outputWhite: [0.9, 0.8, 0.7],
    });
    expect(Array.from(plan)).toEqual(
      Array.from(
        new Float32Array([0.1, 0.4, 1, 0, 0.9, 0.2, 0.5, 2, 0.1, 0.8, 0.3, 0.6, 3, 0.2, 0.7]),
      ),
    );
  });

  it("is the identity plan for the identity parameters, with the Levels op", () => {
    const plan = levelsPlan(LEVELS_IDENTITY);
    expect(plan.op).toBe(LEVELS_OP);
    expect(Array.from(plan.levels)).toEqual(Array.from(identityPlan(LEVELS_OP).levels));
  });
});

describe("Levels transform", () => {
  it("leaves pixels unchanged for the identity, and keeps alpha", () => {
    const data = new Uint8ClampedArray([0, 40, 90, 255, 120, 200, 255, 0, 255, 255, 255, 17]);
    const input = new Surface(3, 1, data);
    expect([...levelsCpu(input, LEVELS_IDENTITY).data]).toEqual([...data]);
  });

  it("maps the input and output points, and clips outside the input range", () => {
    const params: LevelsParams = {
      ...LEVELS_IDENTITY,
      inputBlack: [0.5, 0, 0],
      outputBlack: [0.2, 0, 0],
      outputWhite: [0.8, 1, 1],
    };
    const out = levelsCpu(gray([0, 255]), params);
    expect(out.data[0]).toBe(51);
    expect(out.data[4]).toBe(204);
  });

  it("applies gamma as a direct exponent", () => {
    const darker = levelsCpu(gray([128]), { ...LEVELS_IDENTITY, gamma: [2, 2, 2] });
    const brighter = levelsCpu(gray([128]), { ...LEVELS_IDENTITY, gamma: [0.5, 0.5, 0.5] });
    expect(darker.data[0]).toBeLessThan(128);
    expect(brighter.data[0]).toBeGreaterThan(128);
  });

  it("matches the lookup table byte for byte, so the histogram predicts the render", () => {
    const lut = levelsLut(SHAPED);
    const values = Array.from({ length: 256 }, (_, value) => value);
    const out = levelsCpu(gray(values), SHAPED);
    for (let value = 0; value < 256; value++) {
      for (let channel = 0; channel < 3; channel++) {
        expect(out.data[value * 4 + channel]).toBe(lut[channel * 256 + value]);
      }
    }
  });

  it("is the binding's computation", () => {
    const input = gray([10, 90, 180, 250]);
    expect([...levelsBinding().cpu(input, SHAPED).data]).toEqual([
      ...levelsCpu(input, SHAPED).data,
    ]);
  });
});

describe("Levels histogram and Auto points (ADJ-LEVELS-UI-06, ADJ-LEVELS-UI-08)", () => {
  it("counts each channel over the selected pixels only", () => {
    const input = gray([10, 10, 200]);
    const bins = levelsHistogram(input, [255, 0, 255]);
    expect(bins.length).toBe(768);
    expect(bins[10]).toBe(1);
    expect(bins[200]).toBe(1);
    expect(bins.slice(0, 256).reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(bins[256 + 10]).toBe(1);
  });

  it("counts every pixel when no coverage is given", () => {
    const bins = levelsHistogram(gray([10, 10, 200]));
    expect(bins.slice(0, 256).reduce((sum, count) => sum + count, 0)).toBe(3);
  });

  it("gives the Auto points with the output from 0 to 1", () => {
    const input = gray([10, 40, 90, 200, 250]);
    const params = autoLevelParams(input);
    expect(params.outputBlack).toEqual([0, 0, 0]);
    expect(params.outputWhite).toEqual([1, 1, 1]);
    expect(Array.from(levelsPlanValues(params))).toEqual(Array.from(autoLevelPlan(input).levels));
  });

  it("reads only the selected pixels for the Auto points", () => {
    const full = gray([10, 40, 90, 200, 250, 0, 255]);
    const coverage = [255, 255, 255, 255, 255, 0, 0];
    const alone = autoLevelParams(gray([10, 40, 90, 200, 250]));
    expect(autoLevelParams(full, coverage)).toEqual(alone);
  });
});
