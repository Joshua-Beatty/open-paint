import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { RgbaImage } from "@openpaint/codecs";
import { resampleSurface, Surface } from "@openpaint/document";
import { initCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { RESAMPLE_CASES, RESAMPLE_INPUT, RESAMPLE_SIZES } from "./cases";
import { CPU_TOLERANCE, diffImages } from "./compare";
import { readReference, writeActual } from "./node-io";

describe("resampling: Rust/WASM kernel against the stored references", () => {
  let input: Surface;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    const image: RgbaImage = await readReference(RESAMPLE_INPUT);
    input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  });

  it.each(RESAMPLE_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const size = RESAMPLE_SIZES[kase.direction];
    const out = resampleSurface(input, size.width, size.height, {
      filter: kase.filter,
      linearLight: kase.linearLight,
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
