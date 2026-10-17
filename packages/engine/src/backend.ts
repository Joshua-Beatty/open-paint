import { adapterKey, type GpuAdapterSummary, requestDevice, summarizeAdapter } from "./gpu-device";
import type { PerformanceClass } from "./performance-class";

/** The `graphics.backend` setting (SET-DLG-07a, WEB-GPU-04). */
export type BackendSetting = "Automatic" | "WebGPU" | "Cpu";

/** The two rendering backends (WEB-GPU-02). */
export type Backend = "webgpu" | "cpu";

/**
 * Why the active backend was chosen: `chosen` (WebGPU as requested), `turned-off` (setting is CPU
 * only), `unavailable` (no usable adapter or device), `software-adapter` (Automatic avoids
 * fallback adapters, ARC-03-01) or `device-loss` (repeated GPU device loss, WEB-GPU-05, or a GPU
 * canvas that keeps failing to present, which takes the same fallback).
 */
export type BackendReason =
  | "chosen"
  | "turned-off"
  | "unavailable"
  | "software-adapter"
  | "device-loss";

/** Bits of the `graphics.errorFlags` setting (SET-STO-03). */
export const GraphicsErrorFlags = {
  None: 0,
  CpuFallbackAfterDeviceLoss: 1,
} as const;

/** Performance classes already measured, keyed by `adapterKey` (SET-DLG-07). */
export type PerformanceCache = Readonly<Record<string, PerformanceClass>>;

export interface ResolveBackendOptions {
  setting: BackendSetting;
  errorFlags: number;
  gpu: GPU | undefined;
  performanceCache: PerformanceCache;
  benchmark(device: GPUDevice): Promise<PerformanceClass>;
}

export interface ResolvedBackend {
  backend: Backend;
  reason: BackendReason;
  /** Whether a WebGPU adapter can be obtained, i.e. the "WebGPU" choice is offered. */
  webgpuAvailable: boolean;
  adapter?: GpuAdapterSummary;
  performanceClass: PerformanceClass;
  /** The created device when `backend` is "webgpu". */
  device?: GPUDevice;
}

/**
 * Picks the rendering backend (WEB-GPU-01..04, SET-DLG-07a, ARC-03-01). Automatic requests a
 * high-performance adapter and skips fallback adapters; WebGPU uses any adapter; every path ends on
 * the CPU backend when WebGPU is unusable. The performance class is VeryLow for the CPU backend and
 * fallback adapters, otherwise cached per adapter or measured with `benchmark`.
 */
export async function resolveBackend(options: ResolveBackendOptions): Promise<ResolvedBackend> {
  const { setting, gpu } = options;
  const adapter = await gpu
    ?.requestAdapter(setting === "WebGPU" ? undefined : { powerPreference: "high-performance" })
    .catch(() => null);
  const summary = adapter ? summarizeAdapter(adapter) : undefined;
  const cpu = (reason: BackendReason): ResolvedBackend => ({
    backend: "cpu",
    reason,
    webgpuAvailable: summary !== undefined,
    ...(summary && { adapter: summary }),
    performanceClass: "VeryLow",
  });

  if (setting === "Cpu") return cpu("turned-off");
  if (options.errorFlags & GraphicsErrorFlags.CpuFallbackAfterDeviceLoss) return cpu("device-loss");
  if (!adapter || !summary) return cpu("unavailable");
  if (setting === "Automatic" && summary.isFallbackAdapter) return cpu("software-adapter");

  let device: GPUDevice;
  try {
    device = await requestDevice(adapter);
  } catch {
    return cpu("unavailable");
  }
  const performanceClass = summary.isFallbackAdapter
    ? "VeryLow"
    : (options.performanceCache[adapterKey(summary)] ??
      (await options.benchmark(device).catch((): PerformanceClass => "Low")));
  return {
    backend: "webgpu",
    reason: "chosen",
    webgpuAvailable: true,
    adapter: summary,
    performanceClass,
    device,
  };
}
