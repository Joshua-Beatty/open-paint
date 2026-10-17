import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { RgbaImage } from "@openpaint/codecs";
import { Surface } from "@openpaint/document";
import { initCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { adjustmentReference } from "./adjust-reference";
import { ADJUSTMENT_CASES, ADJUSTMENT_INPUT } from "./cases";
import { CPU_TOLERANCE, diffImages } from "./compare";
import { readReference, writeActual } from "./node-io";

describe("point adjustments: Rust/WASM kernels against the stored references", () => {
  let input: Surface;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    const image: RgbaImage = await readReference(ADJUSTMENT_INPUT);
    input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  });

  it.each(ADJUSTMENT_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const out = adjustmentReference(kase, input);
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
