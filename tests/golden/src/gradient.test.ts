import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { RgbaImage } from "@openpaint/codecs";
import { Surface } from "@openpaint/document";
import { gradientCpu, initCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { GRADIENT_CASES, GRADIENT_INPUT, gradientColorOf } from "./cases";
import { CPU_TOLERANCE, diffImages } from "./compare";
import { readReference, writeActual } from "./node-io";

describe("gradients: Rust/WASM kernel against the stored references", () => {
  let input: RgbaImage;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    input = await readReference(GRADIENT_INPUT);
  });

  it.each(GRADIENT_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const surface = new Surface(input.width, input.height, new Uint8ClampedArray(input.data));
    const out = gradientCpu(surface, {
      shape: kase.shape,
      repeat: kase.repeat,
      start: { x: kase.start[0], y: kase.start[1] },
      end: { x: kase.end[0], y: kase.end[1] },
      startColor: gradientColorOf(kase.startColor),
      endColor: gradientColorOf(kase.endColor),
      alphaOnly: kase.alphaOnly,
      antialias: kase.antialias,
      blend: kase.blend,
    });
    const actual: RgbaImage = {
      width: out.width,
      height: out.height,
      data: new Uint8Array(out.data),
    };

    const diff = diffImages(actual, expected);
    if (diff.maxDifference > CPU_TOLERANCE) {
      const saved = await writeActual(kase.id, actual);
      expect.fail(`${kase.id}: max difference ${diff.maxDifference}; actual saved to ${saved}`);
    }
    expect(diff.maxDifference).toBe(CPU_TOLERANCE);
  });
});
