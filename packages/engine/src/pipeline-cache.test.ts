import { describe, expect, it } from "vitest";
import { FakeDevice } from "./fake-gpu";
import {
  type ComputeShader,
  computePipeline,
  computePipelineReady,
  warmComputePipelines,
} from "./pipeline-cache";

const A: ComputeShader = { label: "a", code: "", entryPoint: "main" };
const B: ComputeShader = { label: "b", code: "", entryPoint: "main" };

describe("compute pipeline cache", () => {
  it("compiles warmed pipelines in the background and hands them out without a new creation", async () => {
    const device = new FakeDevice(undefined);
    await warmComputePipelines(device.gpu, [A, B]);
    expect(device.pipelines).toEqual([
      { label: "a", async: true },
      { label: "b", async: true },
    ]);
    expect(computePipelineReady(device.gpu, A)).toBe(true);
    const pipeline = computePipeline(device.gpu, A);
    expect(computePipeline(device.gpu, A)).toBe(pipeline);
    await warmComputePipelines(device.gpu, [A, B]);
    expect(device.pipelines).toHaveLength(2);
  });

  it("creates a pipeline at once when it is needed before its warm-up finished", () => {
    const device = new FakeDevice(undefined);
    void warmComputePipelines(device.gpu, [A]);
    expect(computePipelineReady(device.gpu, A)).toBe(false);
    const pipeline = computePipeline(device.gpu, A);
    expect(device.pipelines.at(-1)).toEqual({ label: "a", async: false });
    expect(computePipeline(device.gpu, A)).toBe(pipeline);
  });

  it("keeps pipelines per device", async () => {
    const first = new FakeDevice(undefined);
    const second = new FakeDevice(undefined);
    await warmComputePipelines(first.gpu, [A]);
    computePipeline(second.gpu, A);
    expect(second.pipelines).toEqual([{ label: "a", async: false }]);
  });
});
