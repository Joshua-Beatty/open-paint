import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { RgbaImage } from "@openpaint/codecs";
import { initCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { QUANTIZE_CASES, QUANTIZE_INPUT } from "./cases";
import { CPU_TOLERANCE, diffImages } from "./compare";
import { readReference, writeActual } from "./node-io";
import { quantizedImage } from "./quantize-output";

describe("palette quantization: Rust/WASM kernel against the stored references", () => {
  let input: RgbaImage;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    input = await readReference(QUANTIZE_INPUT);
  });

  it.each(QUANTIZE_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const actual = quantizedImage(input, kase);

    const diff = diffImages(actual, expected);
    if (diff.maxDifference > CPU_TOLERANCE) {
      const saved = await writeActual(kase.id, actual);
      expect.fail(`${kase.id}: max difference ${diff.maxDifference}; actual saved to ${saved}`);
    }
    expect(diff.maxDifference).toBe(CPU_TOLERANCE);
  });

  it.each(QUANTIZE_CASES)("$id uses no more colors than its capacity", (kase) => {
    const actual = quantizedImage(input, kase);
    const colors = new Set<number>();
    for (let i = 0; i < actual.data.length; i += 4) {
      if ((actual.data[i + 3] ?? 0) === 0) continue;
      colors.add(
        ((actual.data[i] ?? 0) << 16) |
          ((actual.data[i + 1] ?? 0) << 8) |
          (actual.data[i + 2] ?? 0),
      );
    }
    expect(colors.size).toBeLessThanOrEqual(kase.capacity);
  });
});
