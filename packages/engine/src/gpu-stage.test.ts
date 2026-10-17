/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Surface } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { initCpu } from "./cpu";
import { GpuInkSketch, GpuPencilSketch } from "./gpu-artistic";
import { GpuGlow, GpuSoftenPortrait } from "./gpu-photo";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initCpu(await readFile(wasmPath));
});

/** A device that accepts every call and counts submissions, readbacks and buffers alive. */
function countingDevice() {
  const counts = { submits: 0, maps: 0, alive: 0 };
  const buffer = (size: number) => {
    counts.alive += 1;
    return {
      size,
      mapAsync: async () => {
        counts.maps += 1;
      },
      getMappedRange: (_offset = 0, length = size) => new ArrayBuffer(length),
      unmap: () => undefined,
      destroy: () => {
        counts.alive -= 1;
      },
    };
  };
  const pass = {
    setPipeline: () => undefined,
    setBindGroup: () => undefined,
    dispatchWorkgroups: () => undefined,
    end: () => undefined,
  };
  const device = {
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: ({ size }: { size: number }) => buffer(size),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      copyBufferToBuffer: () => undefined,
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: () => undefined,
      submit: () => {
        counts.submits += 1;
      },
    },
  };
  return { device: device as unknown as GPUDevice, counts };
}

describe("multi-stage GPU effects", () => {
  const input = new Surface(40, 30);
  const cases = {
    "Ink Sketch": (device: GPUDevice) =>
      new GpuInkSketch(device).run(input, { inkOutline: 50, coloring: 50 } as never),
    "Pencil Sketch": (device: GPUDevice) =>
      new GpuPencilSketch(device).run(input, { tipSize: 2, range: 0 } as never),
    Glow: (device: GPUDevice) =>
      new GpuGlow(device).run(input, { radius: 6, brightness: 10, contrast: 10 } as never),
    "Soften Portrait": (device: GPUDevice) =>
      new GpuSoftenPortrait(device).run(input, { softness: 5, lighting: 0, warmth: 10 } as never),
  };
  for (const [name, run] of Object.entries(cases)) {
    it(`${name} records every stage in one submission with one readback`, async () => {
      const { device, counts } = countingDevice();
      const before = counts.alive;
      const out = await run(device);
      expect(out.width).toBe(40);
      expect(counts.submits).toBe(1);
      expect(counts.maps).toBe(1);
      // The stages' buffers are freed; only the pooled readback stays for the next run.
      expect(counts.alive - before).toBe(1);
    });
  }
});
