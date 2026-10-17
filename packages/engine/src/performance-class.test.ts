import { describe, expect, it } from "vitest";
import {
  benchmarkPerformanceClass,
  classifyBenchmark,
  GOOD_BUDGET_MS,
  gpuTimeOf,
} from "./performance-class";

describe("GPU performance class", () => {
  it("is Good within one frame budget, otherwise Low", () => {
    expect(classifyBenchmark(3)).toBe("Good");
    expect(classifyBenchmark(GOOD_BUDGET_MS)).toBe("Good");
    expect(classifyBenchmark(GOOD_BUDGET_MS + 0.1)).toBe("Low");
  });

  it("takes the browser's delay in reporting work done out of timed runs", () => {
    // A browser that reports 30 ms late: 8 passes of 4 ms each read 62 ms, 16 passes 94 ms.
    expect(gpuTimeOf([66, 62, 70], [94, 99, 96])).toBe(32);
    expect(classifyBenchmark(gpuTimeOf([40, 41], [52, 53]))).toBe("Good");
    // Noise never makes the work negative.
    expect(gpuTimeOf([40], [39])).toBe(0);
  });

  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu as GPU | undefined;

  it.skipIf(!gpu)("benchmarks a real WebGPU device", async () => {
    const adapter = await gpu?.requestAdapter();
    if (!adapter) return;
    const device = await adapter.requestDevice();
    try {
      expect(["Low", "Good"]).toContain(await benchmarkPerformanceClass(device));
    } finally {
      device.destroy();
    }
  });
});
