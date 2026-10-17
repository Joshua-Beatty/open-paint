import { describe, expect, it } from "vitest";
import { MAX_PRESENT_FAILURES, PresentFailureTracker, presentChecked } from "./present-failures";

describe("PresentFailureTracker", () => {
  it("abandons the GPU only after failures in a row", () => {
    const tracker = new PresentFailureTracker();
    for (let i = 1; i < MAX_PRESENT_FAILURES; i++) expect(tracker.failed()).toBe(false);
    expect(tracker.failing).toBe(true);
    tracker.succeeded();
    expect(tracker.failing).toBe(false);
    for (let i = 1; i < MAX_PRESENT_FAILURES; i++) expect(tracker.failed()).toBe(false);
    expect(tracker.failed()).toBe(true);
    expect(tracker.count).toBe(2 * MAX_PRESENT_FAILURES - 1);
  });
});

/** A device whose error scopes report `error` for the frame. */
function scopedDevice(error: GPUError | null) {
  const scopes: string[] = [];
  return {
    scopes,
    device: {
      pushErrorScope: (filter: string) => scopes.push(filter),
      popErrorScope: async () => {
        scopes.pop();
        return error;
      },
    } as unknown as GPUDevice,
  };
}

describe("presentChecked", () => {
  it("resolves when the frame's commands raised no validation error", async () => {
    const { device, scopes } = scopedDevice(null);
    let ran = false;
    await presentChecked(device, () => {
      expect(scopes).toEqual(["validation"]);
      ran = true;
    });
    expect(ran).toBe(true);
    expect(scopes).toEqual([]);
  });

  it("rejects with the GPU's validation error", async () => {
    const { device } = scopedDevice({ message: "Invalid CommandBuffer" } as GPUError);
    await expect(presentChecked(device, () => undefined)).rejects.toThrow("Invalid CommandBuffer");
  });

  it("throws what the present throws and still closes its scope", () => {
    const { device, scopes } = scopedDevice(null);
    expect(() =>
      presentChecked(device, () => {
        throw new Error("Canvas not configured");
      }),
    ).toThrow("Canvas not configured");
    expect(scopes).toEqual([]);
  });
});
