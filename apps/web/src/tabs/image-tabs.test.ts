import { describe, expect, it, vi } from "vitest";
import { ImageTabs } from "./image-tabs";

function tabsWith(...names: string[]) {
  const tabs = new ImageTabs<string>();
  const ids = names.map((name) => tabs.open(name));
  return { tabs, ids };
}

function names(tabs: ImageTabs<string>): string[] {
  return tabs.state.items.map((item) => item.value);
}

describe("ImageTabs", () => {
  it("adds new images at the end and makes them active", () => {
    const { tabs, ids } = tabsWith("a", "b");
    expect(names(tabs)).toEqual(["a", "b"]);
    expect(tabs.state.activeId).toBe(ids[1]);
    expect(tabs.count).toBe(2);
  });

  it("closes the active tab in favour of its right neighbour", () => {
    const { tabs, ids } = tabsWith("a", "b", "c");
    tabs.activate(ids[1] ?? "");
    tabs.close(ids[1] ?? "");
    expect(names(tabs)).toEqual(["a", "c"]);
    expect(tabs.state.activeId).toBe(ids[2]);
  });

  it("falls back to the left neighbour when the closed active tab was last", () => {
    const { tabs, ids } = tabsWith("a", "b", "c");
    expect(tabs.state.activeId).toBe(ids[2]);
    tabs.close(ids[2] ?? "");
    expect(tabs.state.activeId).toBe(ids[1]);
  });

  it("keeps the active tab when another tab closes", () => {
    const { tabs, ids } = tabsWith("a", "b", "c");
    tabs.activate(ids[0] ?? "");
    tabs.close(ids[2] ?? "");
    expect(tabs.state.activeId).toBe(ids[0]);
  });

  it("leaves no active tab after the last image closes", () => {
    const { tabs, ids } = tabsWith("a");
    expect(tabs.close(ids[0] ?? "")).toBe(true);
    expect(tabs.state.activeId).toBeUndefined();
    expect(tabs.count).toBe(0);
  });

  it("refuses to close or activate an unknown id", () => {
    const { tabs } = tabsWith("a");
    expect(tabs.close("missing")).toBe(false);
    expect(tabs.activate("missing")).toBe(false);
    expect(tabs.count).toBe(1);
  });

  it("wraps next and previous around the ends", () => {
    const { tabs, ids } = tabsWith("a", "b", "c");
    tabs.activate(ids[2] ?? "");
    expect(tabs.next()).toBe(true);
    expect(tabs.state.activeId).toBe(ids[0]);
    expect(tabs.previous()).toBe(true);
    expect(tabs.state.activeId).toBe(ids[2]);
  });

  it("does nothing for next and previous with no images", () => {
    const tabs = new ImageTabs<string>();
    expect(tabs.next()).toBe(false);
    expect(tabs.previous()).toBe(false);
  });

  it("jumps to a tab by its 1-based position", () => {
    const { tabs, ids } = tabsWith("a", "b", "c");
    expect(tabs.goTo(1)).toBe(true);
    expect(tabs.state.activeId).toBe(ids[0]);
    expect(tabs.goTo(4)).toBe(false);
    expect(tabs.goTo(0)).toBe(false);
    expect(tabs.goTo(1.5)).toBe(false);
    expect(tabs.state.activeId).toBe(ids[0]);
  });

  it("moves the active tab one place without wrapping", () => {
    const { tabs } = tabsWith("a", "b", "c");
    expect(tabs.moveActive(-1)).toBe(true);
    expect(names(tabs)).toEqual(["a", "c", "b"]);
    expect(tabs.moveActive(1)).toBe(true);
    expect(names(tabs)).toEqual(["a", "b", "c"]);
    expect(tabs.moveActive(1)).toBe(false);
    expect(names(tabs)).toEqual(["a", "b", "c"]);
  });

  it("moves a dragged tab to a final index and clamps the index", () => {
    const { tabs, ids } = tabsWith("a", "b", "c");
    expect(tabs.move(ids[0] ?? "", 2)).toBe(true);
    expect(names(tabs)).toEqual(["b", "c", "a"]);
    expect(tabs.move(ids[0] ?? "", 99)).toBe(false);
    expect(tabs.move(ids[0] ?? "", -4)).toBe(true);
    expect(names(tabs)).toEqual(["a", "b", "c"]);
  });

  it("keeps the active tab when another tab moves", () => {
    const { tabs, ids } = tabsWith("a", "b", "c");
    tabs.move(ids[0] ?? "", 2);
    expect(tabs.active?.value).toBe("c");
  });

  it("notifies listeners on each change and not when nothing changes", () => {
    const tabs = new ImageTabs<string>();
    const listener = vi.fn();
    const stop = tabs.subscribe(listener);
    const id = tabs.open("a");
    expect(listener).toHaveBeenCalledTimes(1);
    tabs.activate(id);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    tabs.open("b");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the same state object until something changes", () => {
    const { tabs, ids } = tabsWith("a", "b");
    const before = tabs.state;
    tabs.activate(ids[1] ?? "");
    expect(tabs.state).toBe(before);
    tabs.activate(ids[0] ?? "");
    expect(tabs.state).not.toBe(before);
  });

  it("replaces an image's value in place, keeping its id, position and active tab", () => {
    const { tabs, ids } = tabsWith("a", "b");
    tabs.activate(ids[1] ?? "");
    expect(tabs.replace(ids[0] ?? "", "renamed")).toBe(true);
    expect(tabs.state.items.map((item) => [item.id, item.value])).toEqual([
      [ids[0], "renamed"],
      [ids[1], "b"],
    ]);
    expect(tabs.state.activeId).toBe(ids[1]);
  });

  it("reports a replace of an image that is not open", () => {
    const { tabs } = tabsWith("a");
    expect(tabs.replace("missing", "x")).toBe(false);
  });
});
