import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { RgbaImage } from "@openpaint/codecs";
import { compositeRgba8, initCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { BLEND_CASES, BLEND_INPUTS } from "./cases";
import { CPU_TOLERANCE, diffImages } from "./compare";
import { readReference, writeActual } from "./node-io";

describe("blend modes: Rust/WASM kernel against the stored references", () => {
  let dst: RgbaImage;
  let src: RgbaImage;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    dst = await readReference(BLEND_INPUTS.dst);
    src = await readReference(BLEND_INPUTS.src);
  });

  it.each(BLEND_CASES)("$id matches its reference exactly", async (kase) => {
    const expected = await readReference(kase.expected);
    const actual: RgbaImage = { ...dst, data: new Uint8Array(dst.data) };
    compositeRgba8(actual.data, src.data, kase.mode, kase.opacity);

    const diff = diffImages(actual, expected);
    if (diff.maxDifference > CPU_TOLERANCE) {
      const saved = await writeActual(kase.id, actual);
      expect.fail(`${kase.id}: max difference ${diff.maxDifference}; actual saved to ${saved}`);
    }
    expect(diff.maxDifference).toBe(CPU_TOLERANCE);
  });
});
