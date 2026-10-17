import type { ToolRuntime } from "@openpaint/extension-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_REGISTRY } from "./roster";
import { ACTIVE_TOOL_PATH, ToolController, type ToolSettings } from "./tool-controller";
import { listenForToolKeys } from "./tool-keys";

const detachers: Array<() => void> = [];

afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
});

function keyDown(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

function setup(
  options: {
    pending?: boolean;
    canvasFocus?: boolean;
    canDeselect?: boolean;
    nudge?: (dx: number, dy: number, step: number) => boolean;
    scrollView?: boolean;
  } = {},
) {
  const values = new Map<string, string>();
  const settings: ToolSettings = {
    get: (path) => values.get(path),
    set: (path, value) => {
      values.set(path, String(value));
    },
  };
  const runtime = {
    activate: vi.fn(),
    deactivate: vi.fn(),
    pointer: vi.fn(),
    hasPending: vi.fn(() => options.pending === true),
    commit: vi.fn(),
    cancel: vi.fn(),
    tapCtrl: vi.fn(),
    nudge: options.nudge === undefined ? undefined : vi.fn(options.nudge),
  } satisfies ToolRuntime & Record<string, unknown>;
  const controller = new ToolController({
    registry: TOOL_REGISTRY,
    createRuntime: () => runtime,
  });
  controller.attach(settings);
  const deselect = vi.fn(() => true);
  const scrollView = vi.fn();
  detachers.push(
    listenForToolKeys(window, {
      controller,
      canvasHasFocus: () => options.canvasFocus ?? true,
      canDeselect: () => options.canDeselect ?? false,
      deselect,
      scrollView: options.scrollView === true ? scrollView : undefined,
    }),
  );
  return { controller, runtime, values, deselect, scrollView };
}

describe("listenForToolKeys", () => {
  it("selects a tool by its letter and consumes the key", () => {
    const { controller, values } = setup();
    const event = keyDown("KeyS");
    expect(event.defaultPrevented).toBe(true);
    expect(controller.active.id).toBe("rectangleSelect");
    expect(values.get(ACTIVE_TOOL_PATH)).toBe("rectangleSelect");
  });

  it("reverses the cycle with Shift", () => {
    const { controller, values } = setup();
    values.set(ACTIVE_TOOL_PATH, "rectangleSelect");
    keyDown("KeyS", { shiftKey: true });
    expect(controller.active.id).toBe("magicWand");
  });

  it("consumes a skip-if-active letter without changing the tool", () => {
    const { controller } = setup();
    const event = keyDown("KeyB");
    expect(event.defaultPrevented).toBe(true);
    expect(controller.active.id).toBe("paintbrush");
  });

  it("consumes Alt presses only while a pointer drag is in progress (TL-SEL-01)", () => {
    const { controller } = setup();
    expect(keyDown("AltLeft", { key: "Alt", altKey: true }).defaultPrevented).toBe(false);
    controller.setPointerHeld(true);
    expect(keyDown("AltLeft", { key: "Alt", altKey: true }).defaultPrevented).toBe(true);
  });

  it("ignores modified letters and keys that no tool uses", () => {
    const { controller } = setup();
    expect(keyDown("KeyS", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(keyDown("KeyQ").defaultPrevented).toBe(false);
    expect(controller.active.id).toBe("paintbrush");
  });

  it("nudges the active tool with the arrow keys, by 10 px with Ctrl and 50 px with Shift (TL-MOVE-01)", () => {
    const { runtime } = setup({ nudge: () => true });
    const plain = keyDown("ArrowLeft");
    expect(plain.defaultPrevented).toBe(true);
    expect(runtime.nudge).toHaveBeenLastCalledWith(-1, 0, 1);
    keyDown("ArrowDown", { ctrlKey: true });
    expect(runtime.nudge).toHaveBeenLastCalledWith(0, 1, 10);
    keyDown("ArrowRight", { shiftKey: true });
    expect(runtime.nudge).toHaveBeenLastCalledWith(1, 0, 50);
    keyDown("ArrowUp", { shiftKey: true, ctrlKey: true });
    expect(runtime.nudge).toHaveBeenLastCalledWith(0, -1, 50);
  });

  it("lets an arrow key through when the tool does not use it", () => {
    const { runtime } = setup({ nudge: () => false });
    expect(keyDown("ArrowUp").defaultPrevented).toBe(false);
    expect(runtime.nudge).toHaveBeenCalledWith(0, -1, 1);
  });

  it("scrolls the view with an arrow key the tool does not use (TL-HOTKEY-03)", () => {
    const { scrollView } = setup({ nudge: () => false, scrollView: true });
    expect(keyDown("ArrowLeft").defaultPrevented).toBe(true);
    expect(scrollView).toHaveBeenLastCalledWith(-100, 0);
    keyDown("ArrowDown");
    expect(scrollView).toHaveBeenLastCalledWith(0, 100);
    keyDown("ArrowUp", { ctrlKey: true });
    expect(scrollView).toHaveBeenCalledTimes(2);
  });

  it("ignores tool keys while the canvas does not have focus", () => {
    const { controller } = setup({ canvasFocus: false });
    expect(keyDown("KeyS").defaultPrevented).toBe(false);
    expect(controller.active.id).toBe("paintbrush");
  });

  it("commits a pending result with Enter", () => {
    const { runtime } = setup({ pending: true });
    const event = keyDown("Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(runtime.commit).toHaveBeenCalledTimes(1);
  });

  it("commits a pending result with Esc", () => {
    const { runtime } = setup({ pending: true });
    keyDown("Escape");
    expect(runtime.commit).toHaveBeenCalledTimes(1);
  });

  it("cancels a drawing in progress with Esc before committing", () => {
    const { controller, runtime } = setup({ pending: true });
    controller.setPointerHeld(true);
    keyDown("Escape");
    expect(runtime.cancel).toHaveBeenCalledTimes(1);
    expect(runtime.commit).not.toHaveBeenCalled();
  });

  it("deselects with Enter or Esc when nothing is pending and a selection exists", () => {
    const { deselect } = setup({ canDeselect: true });
    expect(keyDown("Enter").defaultPrevented).toBe(true);
    expect(deselect).toHaveBeenCalledTimes(1);
  });

  it("leaves Enter or Esc alone when there is nothing to do", () => {
    const { deselect, runtime } = setup({ canDeselect: false });
    expect(keyDown("Escape").defaultPrevented).toBe(false);
    expect(deselect).not.toHaveBeenCalled();
    expect(runtime.commit).not.toHaveBeenCalled();
  });

  it("taps a Ctrl press and release with no other input to the runtime (TL-LINE-01)", () => {
    const { runtime } = setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ControlLeft", key: "Control" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "ControlLeft", key: "Control" }));
    expect(runtime.tapCtrl).toHaveBeenCalledTimes(1);
  });

  it("does not count a Ctrl chord as a tap", () => {
    const { runtime } = setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ControlLeft", key: "Control" }));
    keyDown("KeyZ", { ctrlKey: true });
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "ControlLeft", key: "Control" }));
    expect(runtime.tapCtrl).not.toHaveBeenCalled();
  });

  it("does not count a Ctrl press that a pointer press interrupts", () => {
    const { runtime } = setup();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ControlLeft", key: "Control" }));
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "ControlLeft", key: "Control" }));
    expect(runtime.tapCtrl).not.toHaveBeenCalled();
  });

  it("ignores Enter with a modifier", () => {
    const { runtime } = setup({ pending: true });
    expect(keyDown("Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(runtime.commit).not.toHaveBeenCalled();
  });
});
