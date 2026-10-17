import type { EngineStatus } from "@openpaint/engine";
import { describe, expect, it } from "vitest";
import { canvasRestartSettings } from "./useEngine";

const status = (overrides: Partial<EngineStatus>): EngineStatus => ({
  setting: "Automatic",
  backend: "webgpu",
  reason: "chosen",
  webgpuAvailable: true,
  performanceClass: "Good",
  errorFlags: 0,
  performanceCache: { gpu: "Good" },
  deviceLossCount: 0,
  ...overrides,
});

describe("canvasRestartSettings", () => {
  it("keeps the running engine when its canvas can show its backend", () => {
    expect(canvasRestartSettings(status({}))).toBeUndefined();
    expect(canvasRestartSettings(status({ backend: "cpu", reason: "turned-off" }))).toBeUndefined();
  });

  it("restarts v1 with the status's settings when the canvas holds the other context", () => {
    expect(
      canvasRestartSettings(
        status({ setting: "Cpu", backend: "cpu", reason: "turned-off", restartCanvas: true }),
      ),
    ).toEqual({ backend: "Cpu", errorFlags: 0, performanceCache: { gpu: "Good" } });
    expect(
      canvasRestartSettings(
        status({ backend: "cpu", reason: "device-loss", errorFlags: 1, restartCanvas: true }),
      ),
    ).toEqual({ backend: "Automatic", errorFlags: 1, performanceCache: { gpu: "Good" } });
  });

  it("restarts v1 on the CPU with the fallback flag when v2 gave up its GPU", () => {
    expect(canvasRestartSettings(status({ engine: "v2", backend: "cpu" }))?.errorFlags).toBe(1);
  });
});
