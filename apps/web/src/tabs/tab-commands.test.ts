import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY } from "../commands/catalog";
import { ShortcutController, type ShortcutKeyEvent } from "../commands/shortcuts";
import { ImageTabs } from "./image-tabs";
import { registerTabCommands } from "./tab-commands";

function keyEvent(code: string, modifiers: Partial<ShortcutKeyEvent> = {}) {
  const preventDefault = vi.fn();
  const event = {
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault,
    ...modifiers,
  };
  return { event, preventDefault };
}

function setup(names: string[]) {
  const controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
  const tabs = new ImageTabs<string>();
  const ids = names.map((name) => tabs.open(name));
  const close = vi.fn((ids: readonly string[]) => {
    for (const id of ids) tabs.close(id);
  });
  const release = registerTabCommands(controller, tabs, close);
  return { controller, tabs, ids, close, release };
}

function active(tabs: ImageTabs<string>): string | undefined {
  return tabs.active?.value;
}

describe("registerTabCommands", () => {
  it("switches tabs with Ctrl+Tab, Ctrl+PageDown and their Alt+Shift alternates", () => {
    const { controller, tabs } = setup(["a", "b", "c"]);
    tabs.goTo(1);
    const { event, preventDefault } = keyEvent("Tab", { ctrlKey: true });
    expect(controller.handleKeyDown(event, { editing: false })).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(active(tabs)).toBe("b");
    controller.handleKeyDown(keyEvent("PageDown", { ctrlKey: true }).event, { editing: false });
    expect(active(tabs)).toBe("c");
    controller.handleKeyDown(keyEvent("PageDown", { altKey: true, shiftKey: true }).event, {
      editing: false,
    });
    expect(active(tabs)).toBe("a");
  });

  it("switches backwards with Ctrl+Shift+Tab and Ctrl+PageUp", () => {
    const { controller, tabs } = setup(["a", "b"]);
    controller.handleKeyDown(keyEvent("Tab", { ctrlKey: true, shiftKey: true }).event, {
      editing: false,
    });
    expect(active(tabs)).toBe("a");
    controller.handleKeyDown(keyEvent("PageUp", { ctrlKey: true }).event, { editing: false });
    expect(active(tabs)).toBe("b");
  });

  it("jumps to tabs 1 to 9 with Ctrl+digit or Alt+digit and to the tenth with Alt+0", () => {
    const names = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);
    const { controller, tabs } = setup(names);
    controller.handleKeyDown(keyEvent("Digit3", { ctrlKey: true }).event, { editing: false });
    expect(active(tabs)).toBe("t3");
    controller.handleKeyDown(keyEvent("Digit5", { altKey: true }).event, { editing: false });
    expect(active(tabs)).toBe("t5");
    controller.handleKeyDown(keyEvent("Digit0", { altKey: true }).event, { editing: false });
    expect(active(tabs)).toBe("t10");
  });

  it("leaves the jump command disabled when there is no such tab", () => {
    const { controller } = setup(["a", "b"]);
    expect(controller.isEnabled("view.goToTab3")).toBe(false);
    expect(controller.isEnabled("view.goToTab2")).toBe(true);
  });

  it("moves the active tab with Ctrl+Shift+PageDown and Ctrl+Shift+PageUp", () => {
    const { controller, tabs } = setup(["a", "b", "c"]);
    tabs.goTo(1);
    controller.handleKeyDown(keyEvent("PageDown", { ctrlKey: true, shiftKey: true }).event, {
      editing: false,
    });
    expect(tabs.state.items.map((item) => item.value)).toEqual(["b", "a", "c"]);
    controller.handleKeyDown(keyEvent("PageUp", { ctrlKey: true, shiftKey: true }).event, {
      editing: false,
    });
    expect(tabs.state.items.map((item) => item.value)).toEqual(["a", "b", "c"]);
  });

  it("closes the active image with Ctrl+W and its Alt+W alternate", () => {
    const { controller, close, tabs } = setup(["a", "b"]);
    controller.handleKeyDown(keyEvent("KeyW", { ctrlKey: true }).event, { editing: false });
    expect(close).toHaveBeenLastCalledWith([expect.stringMatching(/^tab-/)]);
    expect(tabs.count).toBe(1);
    controller.handleKeyDown(keyEvent("KeyW", { altKey: true }).event, { editing: false });
    expect(tabs.count).toBe(0);
    expect(controller.isEnabled("file.close")).toBe(false);
  });

  it("asks to close every image with File > Close All, in tab order", () => {
    const { controller, close, tabs, ids } = setup(["a", "b", "c"]);
    expect(controller.isEnabled("file.closeAll")).toBe(true);
    expect(controller.invoke("file.closeAll")).toBe(true);
    expect(close).toHaveBeenLastCalledWith(ids);
    expect(tabs.count).toBe(0);
    expect(controller.isEnabled("file.closeAll")).toBe(false);
  });

  it("stops handling the keys after release", () => {
    const { controller, tabs, release } = setup(["a", "b"]);
    release();
    expect(controller.isEnabled("view.nextTab")).toBe(false);
    controller.handleKeyDown(keyEvent("Tab", { ctrlKey: true }).event, { editing: false });
    expect(active(tabs)).toBe("b");
  });
});
