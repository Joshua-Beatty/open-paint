/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  HIGHLIGHTS_SHADOWS_DEFAULT_RADIUS,
  HIGHLIGHTS_SHADOWS_ID,
  HIGHLIGHTS_SHADOWS_OP,
  highlightsShadowsBinding,
  highlightsShadowsCpu,
  highlightsShadowsDescriptor,
  highlightsShadowsParams,
  highlightsShadowsPlan,
  highlightsShadowsSchema,
} from "./highlights-shadows";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function grays(values: readonly number[], alpha = 255): Surface {
  return new Surface(
    values.length,
    1,
    new Uint8ClampedArray(values.flatMap((v) => [v, v, v, alpha])),
  );
}

const NONE = { highlights: 0, shadows: 0, clarity: 0, radius: 1.25 };

describe("Highlights / Shadows descriptor (ADJ-HS)", () => {
  it("is a configurable adjustment with three amounts and a Radius", () => {
    expect(highlightsShadowsDescriptor()).toMatchObject({
      id: HIGHLIGHTS_SHADOWS_ID,
      category: "adjustment",
      configurable: true,
    });
    const [highlights, shadows, clarity, radius] = highlightsShadowsSchema().properties;
    expect(highlights).toMatchObject({ key: "highlights", defaultValue: 0, min: -100, max: 100 });
    expect(shadows).toMatchObject({ key: "shadows", defaultValue: 0, min: -100, max: 100 });
    expect(clarity).toMatchObject({ key: "clarity", defaultValue: 0, min: -100, max: 100 });
    expect(radius).toMatchObject({
      kind: "double",
      key: "radius",
      defaultValue: HIGHLIGHTS_SHADOWS_DEFAULT_RADIUS,
      min: 0,
      max: 10,
    });
  });

  it("clamps stored values to the schema", () => {
    expect(highlightsShadowsParams({ highlights: 400, radius: 99 })).toEqual({
      highlights: 100,
      shadows: 0,
      clarity: 0,
      radius: 10,
    });
    expect(resolveValues(highlightsShadowsSchema(), {}).radius).toBe(1.25);
  });

  it("registers as a binding with the same descriptor", () => {
    expect(highlightsShadowsBinding().descriptor.id).toBe(HIGHLIGHTS_SHADOWS_ID);
  });
});

describe("Highlights / Shadows math (ADJ-HS-01, ADJ-HS-02)", () => {
  it("is the identity at 0, 0, 0", () => {
    const src = grays([3, 60, 128, 200, 255]);
    expect([...highlightsShadowsCpu(src, NONE).data]).toEqual([...src.data]);
  });

  it("brightens highlights and leaves deep shadows alone", () => {
    const src = grays([20, 230]);
    const out = highlightsShadowsCpu(src, { ...NONE, highlights: 100, radius: 0 });
    expect(out.data[0]).toBe(20);
    expect(out.data[4]).toBeGreaterThan(230);
  });

  it("darkens shadows with a negative Shadows value", () => {
    const out = highlightsShadowsCpu(grays([40]), { ...NONE, shadows: -100 });
    expect(out.data[0]).toBeLessThan(40);
  });

  it("keeps alpha, including for transparent pixels", () => {
    const src = new Surface(1, 1, new Uint8ClampedArray([200, 200, 200, 0]));
    expect(highlightsShadowsCpu(src, { ...NONE, highlights: 100, clarity: 100 }).data[3]).toBe(0);
  });

  it("plans the tone values and the blur kernel of σ = 2 × Radius", () => {
    const plan = highlightsShadowsPlan({ highlights: 50, shadows: -20, clarity: 0, radius: 1.25 });
    expect(plan.op).toBe(HIGHLIGHTS_SHADOWS_OP);
    expect([...plan.tone]).toEqual([
      Math.fround(0.5),
      Math.fround(-0.2),
      0,
      // σ = 2.5 px gives taps out to ceil(3σ) = 8, so 17 weights.
      8,
    ]);
    const weights = plan.weights.subarray(0, 17);
    expect(weights[0]).toBeCloseTo(weights[16] ?? 0, 6);
    expect(weights[8]).toBeGreaterThan(weights[0] ?? 0);
    expect(weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 5);
    expect(plan.weights[17]).toBe(0);
  });

  it("plans a single unit weight for Radius 0", () => {
    const plan = highlightsShadowsPlan({ ...NONE, radius: 0 });
    expect(plan.tone[3]).toBe(0);
    expect(plan.weights[0]).toBe(1);
    expect(plan.weights[1]).toBe(0);
  });
});
