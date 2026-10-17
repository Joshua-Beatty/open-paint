import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "./catalog";
import { CommandRegistry } from "./registry";
import {
  isEditingTarget,
  listenForShortcuts,
  ShortcutController,
  type ShortcutKeyEvent,
} from "./shortcuts";

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

function controller(platform: "mac" | "other" = "other") {
  return new ShortcutController(BUILT_IN_REGISTRY, platform);
}

describe("ShortcutController", () => {
  it("runs the command for a bound key and prevents the browser's default (WEB-KEY-07)", () => {
    const shortcuts = controller();
    const run = vi.fn();
    shortcuts.register("file.save", { run });
    const { event, preventDefault } = keyEvent("KeyS", { ctrlKey: true });
    expect(shortcuts.handleKeyDown(event, { editing: false })).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("tells its listeners when a command is attached or detached", () => {
    const shortcuts = controller();
    const listener = vi.fn();
    const stop = shortcuts.subscribe(listener);
    const before = shortcuts.version;
    const release = shortcuts.register("file.save", { run: () => undefined });
    expect(listener).toHaveBeenCalledTimes(1);
    release();
    release();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(shortcuts.version).toBe(before + 2);
    stop();
    shortcuts.register("file.save", { run: () => undefined });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("leaves unbound keys alone", () => {
    const shortcuts = controller();
    const run = vi.fn();
    shortcuts.register("file.save", { run });
    const { event, preventDefault } = keyEvent("KeyQ", { ctrlKey: true });
    expect(shortcuts.handleKeyDown(event, { editing: false })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("intercepts a bound key even before its command has a handler", () => {
    const shortcuts = controller();
    const { event, preventDefault } = keyEvent("KeyS", { ctrlKey: true });
    expect(shortcuts.handleKeyDown(event, { editing: false })).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves keys alone while a text field or the Text tool is editing (WEB-KEY-05)", () => {
    const shortcuts = controller();
    const run = vi.fn();
    shortcuts.register("edit.selectAll", { run });
    const { event, preventDefault } = keyEvent("KeyA", { ctrlKey: true });
    expect(shortcuts.handleKeyDown(event, { editing: true })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("uses Command on macOS and ignores Ctrl there", () => {
    const shortcuts = controller("mac");
    const run = vi.fn();
    shortcuts.register("file.save", { run });
    expect(
      shortcuts.handleKeyDown(keyEvent("KeyS", { metaKey: true }).event, { editing: false }),
    ).toBe(true);
    expect(
      shortcuts.handleKeyDown(keyEvent("KeyS", { ctrlKey: true }).event, { editing: false }),
    ).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not run a command whose enable rule says no, but still intercepts its key", () => {
    const shortcuts = controller();
    const run = vi.fn();
    shortcuts.register("edit.undo", { run, enabled: () => false });
    const { event, preventDefault } = keyEvent("KeyZ", { ctrlKey: true });
    expect(shortcuts.handleKeyDown(event, { editing: false })).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("invokes a command from a menu or button through the same enable rule", () => {
    const shortcuts = controller();
    const run = vi.fn();
    let enabled = false;
    shortcuts.register("edit.redo", { run, enabled: () => enabled });
    expect(shortcuts.invoke("edit.redo")).toBe(false);
    enabled = true;
    expect(shortcuts.invoke("edit.redo")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("returns false when a command has no handler", () => {
    expect(controller().invoke("file.open")).toBe(false);
  });

  it("rejects a second handler for the same command", () => {
    const shortcuts = controller();
    shortcuts.register("file.open", { run: () => {} });
    expect(() => shortcuts.register("file.open", { run: () => {} })).toThrow(
      'Command "file.open" already has a handler.',
    );
  });

  it("detaches a handler with the function register returns, and only that handler", () => {
    const shortcuts = controller();
    const first = vi.fn();
    const second = vi.fn();
    const detachFirst = shortcuts.register("file.open", { run: first });
    detachFirst();
    shortcuts.register("file.open", { run: second });
    detachFirst();
    expect(shortcuts.invoke("file.open")).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("refuses to register a handler for an unknown command", () => {
    const shortcuts = new ShortcutController(new CommandRegistry<BuiltInCommandId>([]), "other");
    expect(() => shortcuts.register("file.save", { run: () => {} })).toThrow(
      'Unknown command "file.save".',
    );
  });
});

describe("isEditingTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("is true for text fields and contenteditable areas only", () => {
    document.body.innerHTML =
      '<input id="text"><input id="check" type="checkbox"><textarea id="area"></textarea><div id="rich" contenteditable="true"></div><button id="button"></button>';
    expect(isEditingTarget(document.getElementById("text"))).toBe(true);
    expect(isEditingTarget(document.getElementById("area"))).toBe(true);
    expect(isEditingTarget(document.getElementById("rich"))).toBe(true);
    expect(isEditingTarget(document.getElementById("button"))).toBe(false);
    expect(isEditingTarget(null)).toBe(false);
    expect(isEditingTarget(window)).toBe(false);
  });
});

describe("listenForShortcuts", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it("routes a window keydown to the bound command and reports the interception", () => {
    const shortcuts = controller();
    const run = vi.fn();
    shortcuts.register("file.save", { run });
    const detach = listenForShortcuts(shortcuts);
    const event = press(document.body, { code: "KeyS", ctrlKey: true });
    expect(run).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    detach();
    press(document.body, { code: "KeyS", ctrlKey: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it("skips keys typed into a text field", () => {
    const shortcuts = controller();
    const run = vi.fn();
    shortcuts.register("edit.selectAll", { run });
    const detach = listenForShortcuts(shortcuts);
    const field = document.createElement("input");
    document.body.append(field);
    const event = press(field, { code: "KeyA", ctrlKey: true });
    detach();
    expect(run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("skips keys a component already handled, and IME composition", () => {
    const shortcuts = controller();
    const run = vi.fn();
    shortcuts.register("file.open", { run });
    const detach = listenForShortcuts(shortcuts);
    const handled = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyO",
      ctrlKey: true,
    });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    press(document.body, { code: "KeyO", ctrlKey: true, isComposing: true });
    detach();
    expect(run).not.toHaveBeenCalled();
  });
});
