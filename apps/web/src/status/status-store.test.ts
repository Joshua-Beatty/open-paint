import { describe, expect, it, vi } from "vitest";
import { StatusStore } from "./status-store";

describe("StatusStore", () => {
  it("replaces its state on each change and notifies subscribers until they unsubscribe", () => {
    const store = new StatusStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.state;

    store.setPointer({ x: 1, y: 2 });
    expect(store.state).not.toBe(before);
    expect(store.state.pointer).toEqual({ x: 1, y: 2 });

    store.setHint({ text: "Pan: drag to move" });
    store.setProgress({ value: 40 });
    expect(store.state.hint?.text).toBe("Pan: drag to move");
    expect(store.state.progress).toEqual({ value: 40 });
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    store.setProgress(undefined);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.state.progress).toBeUndefined();
  });

  it("ignores a hint, pointer or layout equal to the current one (L3)", () => {
    const store = new StatusStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setHint({ text: "Shapes: 10 x 10" });
    store.setHint({ text: "Shapes: 10 x 10" });
    store.setPointer({ x: 3, y: 4 });
    store.setPointer({ x: 3, y: 4 });
    const layout = {
      mode: "fit" as const,
      zoom: 1,
      originX: 0,
      originY: 0,
      documentWidth: 8,
      documentHeight: 8,
    };
    store.setLayout(layout);
    store.setLayout({ ...layout });
    expect(listener).toHaveBeenCalledTimes(3);
    store.setHint({ text: "Shapes: 11 x 10" });
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
