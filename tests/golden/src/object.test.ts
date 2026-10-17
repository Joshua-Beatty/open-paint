import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { RgbaImage } from "@openpaint/codecs";
import { Surface } from "@openpaint/document";
import { alignObjectCpu, dropShadowCpu } from "@openpaint/effects";
import { initCpu } from "@openpaint/engine";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ALIGN_OBJECT_CASES,
  alignObjectCoverage,
  alignObjectInput,
  BLUR_INPUT,
  DROP_SHADOW_CASES,
} from "./cases";
import { CPU_TOLERANCE, diffImages } from "./compare";
import { readReference, writeActual } from "./node-io";

describe("Object effects: Rust/WASM against the stored references", () => {
  let input: Surface;

  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
    const image: RgbaImage = await readReference(BLUR_INPUT);
    input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  });

  const check = async (id: string, expectedPath: string, out: Surface) => {
    const expected = await readReference(expectedPath);
    const actual: RgbaImage = {
      width: out.width,
      height: out.height,
      data: new Uint8Array(out.data),
    };
    const diff = diffImages(actual, expected);
    if (diff.maxDifference > CPU_TOLERANCE) {
      const saved = await writeActual(id, actual);
      expect.fail(`${id}: max difference ${diff.maxDifference}; actual saved to ${saved}`);
    }
    expect(diff.maxDifference).toBe(CPU_TOLERANCE);
  };

  it.each(DROP_SHADOW_CASES)("$id matches its reference exactly", async (kase) => {
    await check(kase.id, kase.expected, dropShadowCpu(input, kase.params));
  });

  it.each(ALIGN_OBJECT_CASES)("$id matches its reference exactly", async (kase) => {
    const source = alignObjectInput();
    const surface = new Surface(source.width, source.height, new Uint8ClampedArray(source.data));
    const coverage = alignObjectCoverage(kase, source.width, source.height);
    await check(kase.id, kase.expected, alignObjectCpu(surface, kase.params, coverage));
  });
});
