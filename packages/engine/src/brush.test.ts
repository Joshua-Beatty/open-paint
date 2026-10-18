/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { LayerBlendMode, Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { type BrushOptions, strokeBrush, strokeBrushCpu, strokePencilCpu } from "./brush";
import { BrushSettings, brushDabs, brushJoinsDabs, initCpu } from "./cpu";

function pixelAt(surface: Surface, x: number, y: number): number[] {
  const i = (y * surface.width + x) * 4;
  return Array.from(surface.data.subarray(i, i + 4));
}

function brush(settings: Partial<BrushSettings>): BrushSettings {
  return Object.assign(new BrushSettings(), settings);
}

describe("brush kernels (Rust/WASM)", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  it("lists the dabs of a path in stamping order", () => {
    const spaced = brush({ size: 10, spacing: 1.5, smooth: false, pressure: false });
    const dabs = brushDabs(new Float32Array([0, 0, 1, 60, 0, 1]), spaced);
    const xs = Array.from(dabs).filter((_, i) => i % 3 === 0);
    expect(xs).toEqual([0, 15, 30, 45, 60]);
    expect(Array.from(dabs).filter((_, i) => i % 3 === 2)).toEqual([10, 10, 10, 10, 10]);
    expect(brushJoinsDabs(spaced)).toBe(false);
  });

  it("joins the dabs below 100 % spacing: a straight line is one segment", () => {
    const joined = brush({ size: 10, spacing: 0.15, smooth: false, pressure: false });
    expect(brushJoinsDabs(joined)).toBe(true);
    expect(Array.from(brushDabs(new Float32Array([0, 0, 1, 20, 0, 1]), joined))).toEqual([
      0, 0, 10, 20, 0, 10,
    ]);
  });

  it("paints a copy of the surface and leaves the input untouched", () => {
    const input = new Surface(16, 16);
    const output = strokeBrushCpu(
      input,
      new Float32Array([8, 8, 1]),
      brush({ size: 6, hardness: 1, antialias: false, r: 255, g: 0, b: 0, a: 255 }),
    );
    expect(pixelAt(output, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(output, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(input, 8, 8)).toEqual([0, 0, 0, 0]);
  });

  it("renders the same pixels from plain options as from a settings object", () => {
    const options: BrushOptions = {
      size: 7,
      hardness: 0.6,
      spacing: 0.3,
      square: true,
      smooth: false,
      antialias: true,
      pressure: false,
      erase: false,
      blend: LayerBlendMode.multiply,
      hatch: 0,
      color: { r: 200, g: 40, b: 10, a: 180 },
      background: { r: 0, g: 0, b: 0, a: 255 },
    };
    const input = new Surface(20, 20);
    const path = new Float32Array([5, 5, 1, 14, 12, 1]);
    const fromOptions = strokeBrush(input, path, options);
    const fromSettings = strokeBrushCpu(
      input,
      path,
      brush({
        size: 7,
        hardness: 0.6,
        spacing: 0.3,
        square: true,
        smooth: false,
        antialias: true,
        pressure: false,
        blend: LayerBlendMode.multiply,
        r: 200,
        g: 40,
        b: 10,
        a: 180,
      }),
    );
    expect(fromOptions.data).toEqual(fromSettings.data);
  });

  it("paints a hatch with the color and the background by the pattern", () => {
    const options: BrushOptions = {
      size: 6,
      hardness: 1,
      spacing: 0.15,
      square: false,
      smooth: false,
      antialias: false,
      pressure: false,
      erase: false,
      blend: LayerBlendMode.normal,
      hatch: 3,
      color: { r: 255, g: 0, b: 0, a: 255 },
      background: { r: 0, g: 0, b: 255, a: 255 },
    };
    const output = strokeBrush(new Surface(16, 16), new Float32Array([8, 8, 1]), options);
    // Forward Diagonal sets (x + y) % 4 == 0: (8, 8) is red and (9, 8) is blue.
    expect(pixelAt(output, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(output, 9, 8)).toEqual([0, 0, 255, 255]);
  });

  it("paints a pencil line one pixel wide in the color and blend mode", () => {
    const output = strokePencilCpu(
      new Surface(8, 8),
      new Float32Array([1, 1, 4, 1]),
      { r: 1, g: 2, b: 3, a: 255 },
      LayerBlendMode.normal,
    );
    for (let x = 1; x <= 4; x++) expect(pixelAt(output, x, 1)).toEqual([1, 2, 3, 255]);
    expect(pixelAt(output, 5, 1)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(output, 2, 2)).toEqual([0, 0, 0, 0]);
  });

  it("rejects a pencil path that is not x, y pairs", () => {
    expect(() =>
      strokePencilCpu(
        new Surface(4, 4),
        new Float32Array([1, 1, 2]),
        { r: 0, g: 0, b: 0, a: 255 },
        0,
      ),
    ).toThrow();
  });

  it("rejects an unknown blend mode", () => {
    expect(() =>
      strokeBrushCpu(new Surface(4, 4), new Float32Array([2, 2, 1]), brush({ blend: 15 })),
    ).toThrow();
  });
});
