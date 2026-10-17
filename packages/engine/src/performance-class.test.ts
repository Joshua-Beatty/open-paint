import { describe, expect, it } from "vitest";
import { benchmarkPerformanceClass, classifyBenchmark, GOOD_BUDGET_MS } from "./performance-class";

describe("GPU performance class", () => {
  it("is Good within one frame budget, otherwise Low", () => {
    expect(classifyBenchmark(3)).toBe("Good");
    expect(classifyBenchmark(GOOD_BUDGET_MS)).toBe("Good");
    expect(classifyBenchmark(GOOD_BUDGET_MS + 0.1)).toBe("Low");
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
