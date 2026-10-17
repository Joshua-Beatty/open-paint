/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { checkPresentedEdges } from "./present-checks";

/** The WebGPU device, or undefined where the runtime has no adapter (e.g. plain Node). */
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
const canvases = typeof OffscreenCanvas === "function";

describe.runIf(canvases)(
  "the presented image covers the checkerboard to its edge (UI-VIEW-02)",
  () => {
    beforeAll(async () => {
      const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
      await initCpu(await readFile(wasmPath));
    });

    it("with the Canvas 2D presenter", async () => {
      expect((await checkPresentedEdges()).maxDifference).toBeLessThanOrEqual(1);
    });

    it.runIf(device !== undefined)("with the WebGPU presenter", async () => {
      expect((await checkPresentedEdges(device)).maxDifference).toBeLessThanOrEqual(1);
    });
  },
);
