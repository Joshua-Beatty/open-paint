/** The URL switches of the benchmark harness. All are off by default. */
export interface PerfFlags {
  /** `?perf=1`: record presents, inputs and long tasks into `window.__openpaintPerf`. */
  readonly perf: boolean;
  /** `?bench=1`: expose the scenario helpers as `window.__openpaintBench`. */
  readonly bench: boolean;
  /** `?engine=`: the engine name the results are filed under. `v1` when absent. */
  readonly engine: string;
  /** `?gpu-fault=present`: every GPU present fails, to test the CPU fallback end to end. */
  readonly gpuFault: "present" | undefined;
}

export function perfFlags(search: string): PerfFlags {
  const params = new URLSearchParams(search);
  return {
    perf: params.get("perf") === "1",
    bench: params.get("bench") === "1",
    engine: params.get("engine") || "v1",
    gpuFault: params.get("gpu-fault") === "present" ? "present" : undefined,
  };
}

/** The flags of this page load. */
export const PERF_FLAGS: PerfFlags = perfFlags(
  typeof location === "undefined" ? "" : location.search,
);
