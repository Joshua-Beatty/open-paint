import { describe, expect, it } from "vitest";
import { wasmThreadCount } from "./threading";

describe("wasmThreadCount", () => {
  const isolated = {
    crossOriginIsolated: true,
    SharedArrayBuffer,
    navigator: { hardwareConcurrency: 8 },
  };

  it("uses every hardware thread when cross-origin isolated", () => {
    expect(wasmThreadCount(isolated)).toBe(8);
  });

  it("falls back to one thread without cross-origin isolation", () => {
    expect(wasmThreadCount({ ...isolated, crossOriginIsolated: false })).toBe(1);
    expect(wasmThreadCount({ ...isolated, crossOriginIsolated: undefined })).toBe(1);
  });

  it("falls back to one thread without SharedArrayBuffer", () => {
    expect(wasmThreadCount({ ...isolated, SharedArrayBuffer: undefined })).toBe(1);
  });

  it("uses one thread when the hardware concurrency is unknown", () => {
    expect(wasmThreadCount({ ...isolated, navigator: {} })).toBe(1);
  });
});
