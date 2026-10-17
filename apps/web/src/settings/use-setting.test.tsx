import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type SettingReader, useSetting } from "./use-setting";

function fakeSettings() {
  const values = new Map<string, unknown>([["workspace.measurementUnit", "Pixel"]]);
  const listeners = new Set<() => void>();
  const settings: SettingReader = {
    get: (path: string) => values.get(path) as ReturnType<SettingReader["get"]>,
    onChange: (listener) => {
      listeners.add(() => listener({} as never));
      return () => {};
    },
  };
  return {
    settings,
    change(path: string, value: unknown) {
      values.set(path, value);
      for (const listener of listeners) listener();
    },
  };
}

describe("useSetting", () => {
  afterEach(() => {
    cleanup();
  });

  it("reads the setting and re-renders when it changes", () => {
    const fake = fakeSettings();
    const { result } = renderHook(() => useSetting(fake.settings, "workspace.measurementUnit"));
    expect(result.current).toBe("Pixel");
    act(() => fake.change("workspace.measurementUnit", "Inch"));
    expect(result.current).toBe("Inch");
  });

  it("returns undefined before the settings have opened", () => {
    const { result } = renderHook(() => useSetting(null, "workspace.measurementUnit"));
    expect(result.current).toBeUndefined();
  });
});
