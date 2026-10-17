/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { resolveValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  EDGE_DETECT_ID,
  edgeDetectBinding,
  edgeDetectCpu,
  edgeDetectDescriptor,
  edgeDetectParams,
  edgeDetectSchema,
  planEdgeDetect,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function flat(width: number, height: number, rgba: readonly number[]): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return new Surface(width, height, data);
}

function row(levels: readonly number[]): Surface {
  return new Surface(
    levels.length,
    1,
    new Uint8ClampedArray(levels.flatMap((v) => [v, v, v, 255])),
  );
}

describe("Edge Detect descriptor and schema", () => {
  it("is a configurable Stylize effect in document space", () => {
    expect(edgeDetectDescriptor()).toMatchObject({
      id: EDGE_DETECT_ID,
      label: "effect.edgeDetect",
      category: "effect",
      submenu: "stylize",
      configurable: true,
      kind: "gpuImage",
      options: { gpu: { workingSpace: "document", inputAlpha: "straight" } },
    });
  });

  it("lists Strength, an exponential Blurring, Algorithm and Overlay Edges with the spec's defaults", () => {
    const find = (key: string) => edgeDetectSchema().properties.find((p) => p.key === key);
    expect(find("strength")).toMatchObject({ kind: "double", defaultValue: 0.5, min: 0, max: 1 });
    expect(find("blurring")).toMatchObject({ kind: "double", defaultValue: 0, min: 0, max: 10 });
    expect(find("blurring")?.control).toMatchObject({ useExponentialScale: true });
    expect(find("algorithm")).toMatchObject({ kind: "choice", defaultValue: "sobel" });
    expect(find("overlayEdges")).toMatchObject({ kind: "boolean", defaultValue: false });
  });

  it("uses the defaults and clamps the values to the schema", () => {
    expect(resolveValues(edgeDetectSchema(), {})).toMatchObject({
      strength: 0.5,
      blurring: 0,
      algorithm: "sobel",
      overlayEdges: false,
    });
    expect(
      edgeDetectParams({ strength: 3, blurring: -4, algorithm: "prewitt", overlayEdges: true }),
    ).toEqual({ strength: 1, blurring: 0, algorithm: "prewitt", overlayEdges: true });
  });
});

describe("Edge Detect plan", () => {
  it("takes the gain from the Rust reference and reads the algorithm and overlay as flags", () => {
    const sobel = planEdgeDetect({
      strength: 0.5,
      blurring: 0,
      algorithm: "sobel",
      overlayEdges: false,
    });
    expect(sobel).toMatchObject({ gain: 0.5, blurred: false, flags: 0, radius: 0 });
    const prewitt = planEdgeDetect({
      strength: 0.75,
      blurring: 3,
      algorithm: "prewitt",
      overlayEdges: true,
    });
    expect(prewitt).toMatchObject({ gain: 1, blurred: true, flags: 3 });
    expect(prewitt.radius).toBe((prewitt.weights.length - 1) / 2);
  });
});

describe("Edge Detect CPU reference", () => {
  it("leaves a flat image black and keeps its alpha", () => {
    const out = edgeDetectCpu(flat(4, 3, [120, 80, 40, 200]), {
      strength: 1,
      blurring: 0,
      algorithm: "sobel",
      overlayEdges: false,
    });
    expect(out.data.every((value, i) => (i % 4 === 3 ? value === 200 : value === 0))).toBe(true);
  });

  it("lights the pixels beside a step in proportion to Strength", () => {
    const out = edgeDetectCpu(row([0, 0, 255, 255]), {
      strength: 0.1,
      blurring: 0,
      algorithm: "sobel",
      overlayEdges: false,
    });
    expect(out.data[1 * 4] ?? 0).toBeGreaterThan(95);
    expect(out.data[1 * 4] ?? 0).toBeLessThan(110);
    expect(out.data[0] ?? 0).toBe(0);
  });

  it("overlays the edges on the original when Overlay Edges is on", () => {
    const input = flat(3, 3, [90, 90, 90, 255]);
    const out = edgeDetectCpu(input, {
      strength: 1,
      blurring: 0,
      algorithm: "prewitt",
      overlayEdges: true,
    });
    expect([...out.data]).toEqual([...input.data]);
  });

  it("returns a same-sized surface", () => {
    const out = edgeDetectCpu(flat(7, 4, [10, 200, 30, 255]), {
      strength: 0.5,
      blurring: 2,
      algorithm: "sobel",
      overlayEdges: false,
    });
    expect(out.width).toBe(7);
    expect(out.height).toBe(4);
  });
});

describe("Edge Detect binding", () => {
  it("runs the CPU reference from its parameters", () => {
    const binding = edgeDetectBinding();
    const out = binding.cpu(flat(4, 4, [51, 51, 51, 255]), binding.params({ strength: 0.2 }));
    expect(out.width).toBe(4);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(EDGE_DETECT_ID);
  });
});
