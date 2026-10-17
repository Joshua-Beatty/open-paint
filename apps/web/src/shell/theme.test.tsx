import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ColorSchemePreference, resolveColorScheme, useColorScheme } from "./theme";

describe("resolveColorScheme (UI-THEME-01)", () => {
  it("uses the explicit choice regardless of the OS preference", () => {
    expect(resolveColorScheme("Light", true)).toBe("light");
    expect(resolveColorScheme("Dark", false)).toBe("dark");
  });

  it("follows the OS preference when Automatic", () => {
    expect(resolveColorScheme("Automatic", true)).toBe("dark");
    expect(resolveColorScheme("Automatic", false)).toBe("light");
  });
});

describe("useColorScheme", () => {
  type Listener = () => void;
  let matches = false;
  let listeners: Listener[] = [];

  function stubMatchMedia() {
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query === "(prefers-color-scheme: dark)" && matches;
      },
      addEventListener: (_: string, listener: Listener) => listeners.push(listener),
      removeEventListener: (_: string, listener: Listener) => {
        listeners = listeners.filter((item) => item !== listener);
      },
    }));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.documentElement.dataset.colorScheme;
    matches = false;
    listeners = [];
  });

  it("sets the scheme on the document root and follows OS changes live", () => {
    stubMatchMedia();
    const { result, rerender } = renderHook(({ preference }) => useColorScheme(preference), {
      initialProps: { preference: "Automatic" as ColorSchemePreference },
    });
    expect(result.current).toBe("light");
    expect(document.documentElement.dataset.colorScheme).toBe("light");

    matches = true;
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(result.current).toBe("dark");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");

    rerender({ preference: "Light" });
    expect(result.current).toBe("light");
    expect(document.documentElement.dataset.colorScheme).toBe("light");
  });

  it("stops listening to the OS preference on unmount", () => {
    stubMatchMedia();
    const { unmount } = renderHook(() => useColorScheme("Automatic"));
    expect(listeners).toHaveLength(1);
    unmount();
    expect(listeners).toHaveLength(0);
  });

  it("falls back to light when matchMedia is unavailable", () => {
    const { result } = renderHook(() => useColorScheme("Automatic"));
    expect(result.current).toBe("light");
  });
});
