// @vitest-environment jsdom
import { MemorySettingsBackend, SettingsStore } from "@openpaint/storage";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStoredColor } from "../colors/use-colors";
import { usePanelLayout } from "./use-panel-layout";

describe("settings hooks keep their state through unrelated changes (L3)", () => {
  let store: SettingsStore;

  beforeEach(async () => {
    store = await SettingsStore.open({
      backend: new MemorySettingsBackend(),
      channel: null,
      mirror: null,
      lifecycle: null,
      flushDelayMs: 60_000,
    });
  });

  afterEach(async () => {
    cleanup();
    await store.dispose();
  });

  it("usePanelLayout re-renders only for panel settings", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return usePanelLayout(store);
    });
    const before = result.current.layout;
    const rendersBefore = renders;
    act(() => {
      for (let step = 0; step < 10; step++) store.set("tools.brush.hardness", step / 10);
    });
    expect(renders).toBe(rendersBefore);
    expect(result.current.layout).toBe(before);
    act(() => store.set("layout.panels.history.visible", false));
    expect(result.current.layout.visible.history).toBe(false);
  });

  it("useStoredColor re-renders only when its own color changes", () => {
    const fallback = { r: 0, g: 0, b: 0, a: 1 };
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useStoredColor(store, "tools.primaryColor", fallback);
    });
    const rendersBefore = renders;
    act(() => store.set("tools.brush.hardness", 0.3));
    act(() => store.set("tools.primaryColor", { ...result.current[0] }));
    expect(renders).toBe(rendersBefore);
    act(() => store.set("tools.primaryColor", { r: 1, g: 0, b: 0, a: 1 }));
    expect(result.current[0]).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });
});
