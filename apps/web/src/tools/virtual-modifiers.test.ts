import type { PointerSource } from "@openpaint/tools";
import { describe, expect, it, vi } from "vitest";
import { NO_VIRTUAL_MODIFIERS, VirtualModifiers, withVirtualModifiers } from "./virtual-modifiers";

const event = (button: number, buttons: number, shiftKey = false): PointerSource => ({
  clientX: 1,
  clientY: 2,
  button,
  buttons,
  pressure: 0.5,
  pointerType: "touch",
  shiftKey,
  altKey: false,
  ctrlKey: false,
});

describe("withVirtualModifiers", () => {
  it("leaves the event alone with every toggle off", () => {
    const source = event(0, 1);
    expect(withVirtualModifiers(source, NO_VIRTUAL_MODIFIERS)).toBe(source);
  });

  it("adds the held keys to the event's own", () => {
    const state = { ...NO_VIRTUAL_MODIFIERS, ctrl: true, alt: true };
    const mapped = withVirtualModifiers(event(0, 1, true), state);
    expect(mapped).toMatchObject({ shiftKey: true, ctrlKey: true, altKey: true, button: 0 });
  });

  it("turns primary presses and held buttons into secondary ones, coalesced samples too", () => {
    const state = { ...NO_VIRTUAL_MODIFIERS, secondary: true };
    const move = { ...event(-1, 1), getCoalescedEvents: () => [event(-1, 1), event(-1, 1)] };
    expect(withVirtualModifiers(event(0, 1), state)).toMatchObject({ button: 2, buttons: 2 });
    const mapped = withVirtualModifiers(move, state);
    expect(mapped).toMatchObject({ button: -1, buttons: 2 });
    expect(mapped.getCoalescedEvents?.().map((sample) => sample.buttons)).toEqual([2, 2]);
    // The pen eraser end keeps its own button.
    expect(withVirtualModifiers(event(5, 32), state)).toMatchObject({ button: 5, buttons: 32 });
  });
});

describe("VirtualModifiers", () => {
  it("toggles a key and tells its listeners", () => {
    const modifiers = new VirtualModifiers();
    const listener = vi.fn();
    const stop = modifiers.subscribe(listener);
    modifiers.toggle("shift");
    expect(modifiers.state.shift).toBe(true);
    modifiers.toggle("shift");
    expect(modifiers.state.shift).toBe(false);
    stop();
    modifiers.toggle("alt");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
