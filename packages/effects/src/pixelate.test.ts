/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import {
  builtinEffectBindings,
  PIXELATE_ID,
  pixelateBinding,
  pixelateCodes,
  pixelateCpu,
  pixelateDescriptor,
  pixelateGrid,
  pixelateParams,
  pixelatePlan,
  pixelateSchema,
  SCALE_DOWN_MODES,
  SCALE_UP_MODES,
  SOURCE_UNDERLAY_KEY,
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

describe("Pixelate descriptor and schema", () => {
  it("is a configurable Distort effect", () => {
    expect(pixelateDescriptor()).toMatchObject({
      id: PIXELATE_ID,
      label: "effect.pixelate",
      category: "effect",
      submenu: "distort",
      configurable: true,
      kind: "gpuImage",
    });
  });

  it("lists Cell size, Anchor, Scale Down and Scale Up, in that order", () => {
    const keys = pixelateSchema().properties.map((property) => property.key);
    expect(keys).toEqual(["cellSize", "anchor", "scaleDown", "scaleUp"]);
  });

  it("draws the Anchor pad over the source thumbnail (FX-A-00-02e)", () => {
    const anchor = pixelateSchema().properties.find((property) => property.key === "anchor");
    expect(anchor).toMatchObject({
      kind: "vector2",
      defaultValue: { x: 0, y: 0 },
      min: { x: -1, y: -1 },
      max: { x: 1, y: 1 },
    });
    expect(anchor?.control?.staticImageUnderlay).toBe(SOURCE_UNDERLAY_KEY);
  });

  it("offers the spec's interpolations in the spec's list order", () => {
    const find = (key: string) =>
      pixelateSchema().properties.find((property) => property.key === key);
    const scaleDown = find("scaleDown");
    const scaleUp = find("scaleUp");
    expect(scaleDown).toMatchObject({ defaultValue: "multisampleBilinear" });
    expect(scaleDown?.kind === "choice" ? scaleDown.options.map((o) => o.value) : []).toEqual([
      "anisotropic",
      "bicubicHighQuality",
      "multisampleBilinear",
      "bicubic",
      "bilinear",
      "nearestNeighbor",
    ]);
    expect(scaleUp).toMatchObject({ defaultValue: "nearestNeighbor" });
    expect(scaleUp?.kind === "choice" ? scaleUp.options.map((o) => o.value) : []).toEqual([
      "bicubic",
      "bilinear",
      "nearestNeighbor",
    ]);
  });

  it("uses the spec's Cell Size range", () => {
    const cell = pixelateSchema().properties.find((property) => property.key === "cellSize");
    expect(cell).toMatchObject({ kind: "int32", defaultValue: 2, min: 1, max: 256 });
  });
});

describe("Pixelate parameters and kernel codes", () => {
  it("reads the defaults and clamps the cell size", () => {
    expect(pixelateParams({})).toEqual({
      cellSize: 2,
      anchor: { x: 0, y: 0 },
      scaleDown: "multisampleBilinear",
      scaleUp: "nearestNeighbor",
    });
    expect(pixelateParams({ cellSize: 9999, anchor: { x: 5, y: -5 } })).toMatchObject({
      cellSize: 256,
      anchor: { x: 1, y: -1 },
    });
  });

  it("falls back to the default for an interpolation that is not listed", () => {
    expect(pixelateParams({ scaleDown: "sparkle", scaleUp: "bicubic" })).toMatchObject({
      scaleDown: "multisampleBilinear",
      scaleUp: "bicubic",
    });
  });

  it("gives the kernel codes as positions in the mode lists", () => {
    const codes = pixelateCodes(pixelateParams({ scaleDown: "anisotropic", scaleUp: "bicubic" }));
    expect(codes).toEqual({ down: 5, up: 2 });
    expect(SCALE_DOWN_MODES.indexOf("nearestNeighbor")).toBe(0);
    expect(SCALE_UP_MODES.indexOf("nearestNeighbor")).toBe(0);
  });
});

describe("Pixelate plan and grid", () => {
  it("anchors the grid over the region and covers every pixel", () => {
    const params = pixelateParams({ cellSize: 8 });
    const plan = pixelatePlan(params, 40, 24);
    expect([...plan]).toEqual([20, 12, 8]);
    expect([...pixelateGrid(plan, 40, 24)]).toEqual([-3, -2, 6, 4]);
  });
});

describe("Pixelate CPU reference", () => {
  it("returns the input when the cells are single pixels", () => {
    const input = gradientImage(20, 12);
    const out = pixelateCpu(input, pixelateParams({ cellSize: 1 }));
    expect(out.width).toBe(20);
    expect([...out.data]).toEqual([...input.data]);
  });

  it("makes each nearest-neighbor cell a flat block", () => {
    const input = gradientImage(16, 8);
    const out = pixelateCpu(
      input,
      pixelateParams({ cellSize: 4, scaleDown: "nearestNeighbor", scaleUp: "nearestNeighbor" }),
    );
    const at = (x: number, y: number) => (y * 16 + x) * 4;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(out.data[at(x, y)]).toBe(out.data[at(0, 0)]);
      }
    }
    expect(out.data[at(4, 0)]).not.toBe(out.data[at(0, 0)]);
  });
});

describe("Pixelate binding", () => {
  it("reads its parameters and runs the CPU reference", () => {
    const binding = pixelateBinding();
    const params = binding.params({ cellSize: 3, scaleUp: "bilinear" });
    expect(params).toMatchObject({ cellSize: 3, scaleUp: "bilinear" });
    expect(binding.cpu(gradientImage(9, 6), params).width).toBe(9);
  });

  it("is registered among the built-in effects", () => {
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids).toContain(PIXELATE_ID);
  });
});
