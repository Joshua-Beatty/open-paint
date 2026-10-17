/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "../cpu";
import { V2_COMPOSITE_CASES, V2_STROKE_CASES } from "./gpu-cases";
import { checkCompositeV2, checkPartialSyncV2, checkStrokeV2 } from "./gpu-checks";

/** Skips every test in this file when the runtime has no WebGPU adapter (e.g. plain Node). */
async function requestTestDevice(): Promise<GPUDevice | undefined> {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) return undefined;
  try {
    const adapter = await gpu.requestAdapter();
    return await adapter?.requestDevice();
  } catch {
    return undefined;
  }
}

const device = await requestTestDevice();

describe.runIf(device !== undefined)("engine v2 on WebGPU against the Rust reference", () => {
  beforeAll(async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));
  });

  for (const kase of V2_COMPOSITE_CASES) {
    it(`composites ${kase.id} within ±1 of compositeCpu`, async () => {
      const result = await checkCompositeV2(
        device as GPUDevice,
        kase.width,
        kase.height,
        kase.layers,
        kase.pageSlices,
      );
      expect(result.maxDifference).toBeLessThanOrEqual(1);
    });
  }

  it("uploads partial tile syncs exactly (L9)", async () => {
    const result = await checkPartialSyncV2(device as GPUDevice);
    expect(result.maxDifference).toBe(0);
  });

  for (const kase of V2_STROKE_CASES) {
    it(`commits the ${kase.id} stroke within ±1 of strokeBrushCpu`, async () => {
      const result = await checkStrokeV2(device as GPUDevice, kase);
      expect(result.maxDifference).toBeLessThanOrEqual(1);
    });
  }
});
