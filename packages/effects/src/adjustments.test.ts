/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { EffectRegistry } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ADJUSTMENT_IDS,
  ADJUSTMENT_OPS,
  adjustmentCpu,
  blackAndWhiteBinding,
  blackAndWhiteCpu,
  invertAlphaCpu,
  invertColorsCpu,
  planAdjustment,
  SEPIA_DEFAULT_INTENSITY,
  sepiaBinding,
  sepiaCpu,
  sepiaDescriptor,
  sepiaParams,
  sepiaSchema,
} from "./adjustments";
import { ADJUSTMENTS_WGSL } from "./adjustments-wgsl";
import { EffectMemory, type EffectValueStore } from "./framework/memory";
import { registerBuiltinEffects } from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function pixels(...rgba: number[][]): Surface {
  const data = new Uint8ClampedArray(rgba.flat());
  return new Surface(rgba.length, 1, data);
}

describe("adjustment descriptors (ADJ-MENU-02, ADJ-COMMON-01)", () => {
  it("registers the four adjustments in the adjustment category, flat and without a submenu", () => {
    const registry = new EffectRegistry();
    registerBuiltinEffects(registry, 2);
    for (const id of ADJUSTMENT_IDS) {
      const descriptor = registry.get(id);
      expect(descriptor?.category).toBe("adjustment");
      expect(descriptor?.submenu).toBeUndefined();
      expect(descriptor?.kind).toBe("gpuImage");
    }
  });

  it("makes only Sepia configurable, with the Intensity dialog", () => {
    expect(sepiaDescriptor().configurable).toBe(true);
    for (const id of ["invertColors", "invertAlpha", "blackAndWhite"] as const) {
      const registry = new EffectRegistry();
      registerBuiltinEffects(registry, 2);
      const descriptor = registry.get(id);
      expect(descriptor?.configurable).toBe(false);
      expect(descriptor?.schema.properties).toEqual([]);
    }
  });

  it("declares Intensity 0-100 with the default 50 (ADJ-SEPIA table)", () => {
    const [intensity] = sepiaSchema().properties;
    expect(intensity).toMatchObject({ kind: "int32", key: "intensity", defaultValue: 50 });
    expect(intensity).toMatchObject({ min: 0, max: 100 });
    expect(SEPIA_DEFAULT_INTENSITY).toBe(50);
  });

  it("turns the header line off for every generated adjustment dialog control (ADJ-COMMON-04)", () => {
    const registry = new EffectRegistry();
    registerBuiltinEffects(registry, 2);
    const controlled = registry
      .list()
      .filter(
        (descriptor) =>
          descriptor.category === "adjustment" && descriptor.customDialog === undefined,
      )
      .flatMap((descriptor) => descriptor.schema.properties);
    expect(controlled.length).toBeGreaterThan(0);
    for (const property of controlled) {
      expect(property.control?.showHeaderLine).toBe(false);
    }
  });

  it("clamps Sepia's stored values to the schema", () => {
    expect(sepiaParams({ intensity: 250 })).toEqual({ intensity: 100 });
    expect(sepiaParams({ intensity: -4 })).toEqual({ intensity: 0 });
    expect(sepiaParams({ intensity: "bad" })).toEqual({ intensity: 50 });
  });

  it("exposes the built-in adjustments in the registry order after Gaussian Blur", () => {
    const registry = new EffectRegistry();
    registerBuiltinEffects(registry, 1);
    expect(registry.list().map((effect) => effect.id)).toEqual([
      "gaussian-blur",
      ...ADJUSTMENT_IDS,
      "autoLevel",
      "brightnessContrast",
      "hueSaturation",
      "posterize",
      "levels",
      "curves",
      "exposure",
      "highlightsShadows",
      "temperatureTint",
      "bulge",
      "twist",
      "crystalize",
      "dents",
      "frostedGlass",
      "pixelate",
      "polarInversion",
      "tileReflection",
      "morphology",
      "fragment-blur",
      "motion-blur",
      "radial-blur",
      "zoom-blur",
      "median-blur",
      "surface-blur",
      "square-blur",
      "sketch-blur",
      "bokeh-blur",
      "add-noise",
      "reduce-noise",
      "ink-sketch",
      "oil-painting",
      "pencil-sketch",
      "glow",
      "soften-portrait",
      "sharpen",
      "red-eye",
      "straighten",
      "vignette",
      "clouds",
      "turbulence",
      "julia",
      "mandelbrot",
      "edge-detect",
      "emboss",
      "relief",
      "outline",
      "drop-shadow",
      "align-object",
      "flip-horizontal",
      "flip-vertical",
      "quantize",
      "rotate-zoom",
    ]);
    expect(sepiaBinding().descriptor).toEqual(sepiaDescriptor());
    expect(blackAndWhiteBinding().descriptor.id).toBe("blackAndWhite");
  });

  it("never makes an adjustment the Repeat target", () => {
    const values = new Map<string, unknown>();
    const store: EffectValueStore = {
      get: (id) => values.get(id),
      set: (id, _category, stored) => values.set(id, stored),
    };
    const memory = new EffectMemory(store);
    memory.recordRun(sepiaDescriptor(), { intensity: 80 });
    expect(memory.last).toBeUndefined();
  });

  it("stores Sepia's remembered values under its adjustment category", () => {
    const seen: [string, string][] = [];
    const store: EffectValueStore = {
      get: () => undefined,
      set: (id, category) => seen.push([id, category]),
    };
    new EffectMemory(store).remember(sepiaDescriptor(), { intensity: 20 });
    expect(seen).toEqual([["sepia", "adjustment"]]);
  });
});

describe("adjustment CPU references (ADJ-INVCOL, ADJ-INVALPHA, ADJ-BW, ADJ-SEPIA)", () => {
  const input = pixels([10, 20, 30, 255], [200, 100, 0, 0], [128, 128, 128, 77]);

  it("inverts the colors and keeps alpha, so hidden colors invert too", () => {
    const out = invertColorsCpu(input);
    expect([...out.data]).toEqual([245, 235, 225, 255, 55, 155, 255, 0, 127, 127, 127, 77]);
  });

  it("inverts alpha and keeps color", () => {
    const out = invertAlphaCpu(input);
    expect([...out.data]).toEqual([10, 20, 30, 0, 200, 100, 0, 255, 128, 128, 128, 178]);
  });

  it("makes each color its luma and keeps alpha", () => {
    const out = blackAndWhiteCpu(input);
    expect(out.data[0]).toBe(out.data[1]);
    expect(out.data[1]).toBe(out.data[2]);
    expect(out.data[3]).toBe(255);
    expect(out.data[8]).toBe(128);
    expect(out.data[11]).toBe(77);
  });

  it("gives Sepia at intensity 0 the same result as Black and White", () => {
    expect([...sepiaCpu(input, { intensity: 0 }).data]).toEqual([...blackAndWhiteCpu(input).data]);
  });

  it("warms the gray at the default intensity and keeps alpha", () => {
    const out = sepiaCpu(input, { intensity: SEPIA_DEFAULT_INTENSITY });
    expect(out.data[8]).toBeGreaterThan(out.data[9] ?? 0);
    expect(out.data[9]).toBeGreaterThan(out.data[10] ?? 0);
    expect(out.data[11]).toBe(77);
  });

  it("dispatches each id to its reference", () => {
    expect([...adjustmentCpu("invertColors", input, 50).data]).toEqual([
      ...invertColorsCpu(input).data,
    ]);
    expect([...adjustmentCpu("sepia", input, 100).data]).toEqual([
      ...sepiaCpu(input, { intensity: 100 }).data,
    ]);
  });

  it("leaves the input untouched", () => {
    const before = [...input.data];
    invertColorsCpu(input);
    sepiaCpu(input, { intensity: 70 });
    expect([...input.data]).toEqual(before);
  });
});

describe("adjustment plans for the WGSL twin", () => {
  it("maps each adjustment to its op and gives Sepia the Rust exponents", () => {
    expect(planAdjustment("invertColors", 50).op).toBe(ADJUSTMENT_OPS.invertColors);
    expect(planAdjustment("invertAlpha", 50).op).toBe(1);
    expect(planAdjustment("blackAndWhite", 50).op).toBe(2);
    const sepia = planAdjustment("sepia", 50);
    expect(sepia.op).toBe(3);
    expect(sepia.exponents[0]).toBeCloseTo(0.8, 6);
    expect(sepia.exponents[1]).toBe(1);
    expect(sepia.exponents[2]).toBeCloseTo(1.2, 6);
  });

  it("ships the WGSL entry point the engine dispatches", () => {
    expect(ADJUSTMENTS_WGSL).toContain("@compute @workgroup_size(256)");
    expect(ADJUSTMENTS_WGSL).toContain("fn adjust(");
  });
});
