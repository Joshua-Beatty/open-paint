import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasStyleOf, useOverscroll } from "./canvas-style";
import { toPropertyValue, toStoredValue } from "./settings-values";
import type { SettingReader } from "./use-setting";

describe("overscroll (UI-VIEW-02)", () => {
  afterEach(() => {
    cleanup();
  });

  it("turns it on by default, and follows the setting", () => {
    const values = new Map<string, unknown>();
    const listeners = new Set<() => void>();
    const settings: SettingReader = {
      get: (path: string) => values.get(path) as ReturnType<SettingReader["get"]>,
      onChange: (listener) => {
        listeners.add(() => listener({} as never));
        return () => {};
      },
    };
    const engine = { view: vi.fn(async () => ({ mode: "fit" as const, zoom: 1 })) };
    renderHook(() => useOverscroll(engine, settings));
    expect(engine.view).toHaveBeenLastCalledWith({ type: "overscroll", enabled: true });
    act(() => {
      values.set("ui.overscroll", false);
      for (const listener of listeners) listener();
    });
    expect(engine.view).toHaveBeenLastCalledWith({ type: "overscroll", enabled: false });
  });
});

describe("canvas style", () => {
  it("uses the factory defaults when nothing is stored", () => {
    expect(
      canvasStyleOf({
        dropShadow: undefined,
        checkerboardBrightness: undefined,
        borderEnabled: undefined,
        borderColor: undefined,
      }),
    ).toEqual({ dropShadow: true, checkerboardBrightness: 0.75, borderColor: null });
  });

  it("draws the border colour only while its checkbox is ticked", () => {
    const color = { r: 10, g: 20, b: 30, a: 255 };
    const values = {
      dropShadow: false,
      checkerboardBrightness: 0.5,
      borderColor: color,
      borderEnabled: false,
    };
    expect(canvasStyleOf(values).borderColor).toBeNull();
    expect(canvasStyleOf({ ...values, borderEnabled: true })).toEqual({
      dropShadow: false,
      checkerboardBrightness: 0.5,
      borderColor: [10, 20, 30],
    });
  });
});

describe("settings values", () => {
  it("converts stored colours to floats and back", () => {
    const stored = { r: 255, g: 128, b: 0, a: 255 };
    const property = toPropertyValue(stored);
    expect(property).toEqual({ r: 1, g: 128 / 255, b: 0, a: 1 });
    expect(toStoredValue(property)).toEqual(stored);
  });

  it("clamps colour channels when storing", () => {
    expect(toStoredValue({ r: 2, g: -1, b: 0.5, a: 1 })).toEqual({ r: 255, g: 0, b: 128, a: 255 });
  });

  it("passes plain values through unchanged", () => {
    expect(toPropertyValue(0.75)).toBe(0.75);
    expect(toStoredValue(true)).toBe(true);
    expect(toStoredValue("Dark")).toBe("Dark");
  });
});
