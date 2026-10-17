import { afterEach, describe, expect, it, vi } from "vitest";
import { measured } from "./user-timing";

describe("measured", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the result and records nothing when disabled", () => {
    const measure = vi.spyOn(performance, "measure");
    expect(measured("x", () => 42, false)).toBe(42);
    expect(measure).not.toHaveBeenCalled();
  });

  it("records an openpaint measure around the call, also when it throws, and clears it", () => {
    const measure = vi.spyOn(performance, "measure");
    const clear = vi.spyOn(performance, "clearMeasures");
    expect(measured("tool pointer down", () => "done", true)).toBe("done");
    expect(() =>
      measured(
        "engine sync",
        () => {
          throw new Error("boom");
        },
        true,
      ),
    ).toThrow("boom");
    expect(measure.mock.calls.map(([name]) => name)).toEqual([
      "openpaint:tool pointer down",
      "openpaint:engine sync",
    ]);
    expect(clear).toHaveBeenCalledWith("openpaint:engine sync");
    expect(performance.getEntriesByType("measure")).toEqual([]);
  });
});
