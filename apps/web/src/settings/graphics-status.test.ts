import type { EngineStatus } from "@openpaint/engine";
import { describe, expect, it } from "vitest";
import { adapterName, graphicsStatusLine } from "./graphics-status";

const adapter = {
  vendor: "acme",
  architecture: "",
  device: "",
  description: "Acme Graphics (TM) 9000 (R)",
  isFallbackAdapter: false,
  features: [],
  limits: {},
} as unknown as NonNullable<EngineStatus["adapter"]>;

function status(overrides: Partial<EngineStatus>): EngineStatus {
  return {
    setting: "Automatic",
    backend: "webgpu",
    reason: "chosen",
    webgpuAvailable: true,
    adapter,
    performanceClass: "Good",
    errorFlags: 0,
    performanceCache: {},
    deviceLossCount: 0,
    ...overrides,
  };
}

describe("graphics status line", () => {
  it("names the adapter once its (TM) and (R) marks are removed", () => {
    expect(adapterName(adapter)).toBe("Acme Graphics 9000");
    expect(adapterName(undefined)).toBeUndefined();
  });

  it("shows the active WebGPU backend with its adapter", () => {
    expect(graphicsStatusLine(status({}))).toEqual({
      kind: "active",
      adapter: "Acme Graphics 9000",
    });
  });

  it("shows the active backend without an adapter name when the browser gives none", () => {
    expect(graphicsStatusLine(status({ adapter: undefined }))).toEqual({
      kind: "active",
      adapter: undefined,
    });
  });

  it("says GPU acceleration is turned off for the CPU setting", () => {
    expect(
      graphicsStatusLine(status({ setting: "Cpu", backend: "cpu", reason: "turned-off" })),
    ).toEqual({ kind: "off" });
  });

  it("says GPU acceleration is unavailable when no adapter can be used", () => {
    expect(
      graphicsStatusLine(
        status({
          backend: "cpu",
          reason: "unavailable",
          webgpuAvailable: false,
          adapter: undefined,
        }),
      ),
    ).toEqual({ kind: "unavailable" });
  });

  it("reports the automatic fallback after repeated device loss, from the flag or the reason", () => {
    expect(graphicsStatusLine(status({ errorFlags: 1, backend: "cpu" }))).toEqual({
      kind: "fallback",
    });
    expect(graphicsStatusLine(status({ reason: "device-loss", backend: "cpu" }))).toEqual({
      kind: "fallback",
    });
  });
});
