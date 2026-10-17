import { describe, expect, it } from "vitest";
import { DEVICE_LOSS_WINDOW_MS, DeviceLossTracker } from "./device-loss";

describe("DeviceLossTracker", () => {
  it("falls back on the third loss within 60 s", () => {
    const t = new DeviceLossTracker();
    expect(t.record(0)).toBe(false);
    expect(t.record(30_000)).toBe(false);
    expect(t.record(59_999)).toBe(true);
    expect(t.count).toBe(3);
  });

  it("forgets losses older than the window", () => {
    const t = new DeviceLossTracker();
    t.record(0);
    t.record(10_000);
    expect(t.record(DEVICE_LOSS_WINDOW_MS)).toBe(false);
    expect(t.record(DEVICE_LOSS_WINDOW_MS + 10_000)).toBe(false);
    expect(t.record(DEVICE_LOSS_WINDOW_MS + 10_001)).toBe(true);
  });

  it("keeps the session count across resets", () => {
    const t = new DeviceLossTracker();
    t.record(0);
    t.record(1);
    t.reset();
    expect(t.record(2)).toBe(false);
    expect(t.count).toBe(3);
  });
});
