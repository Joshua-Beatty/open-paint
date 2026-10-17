import { describe, expect, it } from "vitest";
import { type BackendSetting, resolveBackend } from "./backend";
import { FakeAdapter, FakeGpu } from "./fake-gpu";
import { adapterKey, summarizeAdapter } from "./gpu-device";
import type { PerformanceClass } from "./performance-class";

function resolve(
  setting: BackendSetting,
  adapter: FakeAdapter | null,
  extra: { errorFlags?: number; cache?: Record<string, PerformanceClass>; noGpu?: boolean } = {},
) {
  const gpu = new FakeGpu(() => adapter);
  const benchmarked: unknown[] = [];
  const result = resolveBackend({
    setting,
    errorFlags: extra.errorFlags ?? 0,
    gpu: extra.noGpu ? undefined : gpu.gpu,
    performanceCache: extra.cache ?? {},
    benchmark: async (device) => {
      benchmarked.push(device);
      return "Good";
    },
  });
  return { result, gpu, benchmarked };
}

describe("resolveBackend", () => {
  it("Automatic requests a high-performance adapter and uses WebGPU with key limits raised", async () => {
    const adapter = new FakeAdapter();
    const { result, gpu, benchmarked } = resolve("Automatic", adapter);
    const resolved = await result;
    expect(gpu.requests).toEqual([{ powerPreference: "high-performance" }]);
    expect(resolved).toMatchObject({
      backend: "webgpu",
      reason: "chosen",
      webgpuAvailable: true,
      performanceClass: "Good",
    });
    expect(resolved.device).toBe(adapter.devices[0]);
    expect(benchmarked).toEqual([resolved.device]);
    expect(adapter.devices[0]?.descriptor?.requiredLimits).toEqual(adapter.limits);
    expect(resolved.adapter).toEqual({
      vendor: "acme",
      architecture: "rdna",
      device: "",
      description: "Acme(R) Graphics(TM)",
      isFallbackAdapter: false,
      features: ["shader-f16", "timestamp-query"],
      limits: adapter.limits,
    });
  });

  it("reuses a cached performance class instead of benchmarking", async () => {
    const adapter = new FakeAdapter();
    const key = adapterKey(summarizeAdapter(adapter as unknown as GPUAdapter));
    const { result, benchmarked } = resolve("Automatic", adapter, { cache: { [key]: "Low" } });
    expect((await result).performanceClass).toBe("Low");
    expect(benchmarked).toEqual([]);
  });

  it("classifies as Low when the benchmark fails", async () => {
    const resolved = await resolveBackend({
      setting: "Automatic",
      errorFlags: 0,
      gpu: new FakeGpu(() => new FakeAdapter()).gpu,
      performanceCache: {},
      benchmark: () => Promise.reject(new Error("lost")),
    });
    expect(resolved.performanceClass).toBe("Low");
  });

  it("CPU only never creates a device but still reports WebGPU availability", async () => {
    const adapter = new FakeAdapter();
    const resolved = await resolve("Cpu", adapter).result;
    expect(resolved).toMatchObject({
      backend: "cpu",
      reason: "turned-off",
      webgpuAvailable: true,
      performanceClass: "VeryLow",
    });
    expect(adapter.devices).toEqual([]);
  });

  it("falls back to CPU without navigator.gpu, an adapter or a device", async () => {
    for (const { setting, adapter, noGpu } of [
      { setting: "Automatic", adapter: new FakeAdapter(), noGpu: true },
      { setting: "WebGPU", adapter: null, noGpu: false },
      { setting: "WebGPU", adapter: new FakeAdapter({ failDevice: true }), noGpu: false },
    ] as const) {
      const resolved = await resolve(setting, adapter, { noGpu }).result;
      expect(resolved).toMatchObject({ backend: "cpu", reason: "unavailable" });
      expect(resolved.webgpuAvailable).toBe(adapter !== null && !noGpu);
    }
  });

  it("Automatic avoids fallback adapters; WebGPU uses them as VeryLow", async () => {
    const software = new FakeAdapter({ isFallbackAdapter: true });
    expect(await resolve("Automatic", software).result).toMatchObject({
      backend: "cpu",
      reason: "software-adapter",
      webgpuAvailable: true,
    });
    const { result, gpu, benchmarked } = resolve("WebGPU", software);
    expect(await result).toMatchObject({ backend: "webgpu", performanceClass: "VeryLow" });
    expect(gpu.requests).toEqual([undefined]);
    expect(benchmarked).toEqual([]);
  });

  it("stays on CPU while the device-loss error flag is set", async () => {
    const adapter = new FakeAdapter();
    const resolved = await resolve("WebGPU", adapter, { errorFlags: 1 }).result;
    expect(resolved).toMatchObject({ backend: "cpu", reason: "device-loss" });
    expect(adapter.devices).toEqual([]);
  });
});
