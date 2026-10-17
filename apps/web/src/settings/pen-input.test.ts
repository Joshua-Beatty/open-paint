import type { SettingsStore } from "@openpaint/storage";
import { describe, expect, it, vi } from "vitest";
import { PEN_DETECTED_PATH, PenInputTracker, rememberPenInput } from "./pen-input";

function pointer(type: string, name = "pointerdown"): Event {
  const event = new Event(name);
  Object.defineProperty(event, "pointerType", { value: type });
  return event;
}

describe("pen input tracker", () => {
  it("is not detected until a pen sends a pointer event", () => {
    const target = new EventTarget();
    const tracker = new PenInputTracker();
    tracker.start(target);
    target.dispatchEvent(pointer("mouse"));
    expect(tracker.detected).toBe(false);
    target.dispatchEvent(pointer("pen", "pointermove"));
    expect(tracker.detected).toBe(true);
  });

  it("notifies subscribers once, when the pen is first seen", () => {
    const target = new EventTarget();
    const tracker = new PenInputTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);
    tracker.start(target);
    target.dispatchEvent(pointer("pen"));
    target.dispatchEvent(pointer("pen"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("knows a pen remembered from an earlier session, but not as detected in this one", () => {
    const tracker = new PenInputTracker();
    const listener = vi.fn();
    tracker.subscribe(listener);
    expect(tracker.known).toBe(false);
    tracker.remember();
    expect(tracker.known).toBe(true);
    expect(tracker.detected).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops listening when stopped", () => {
    const target = new EventTarget();
    const tracker = new PenInputTracker();
    tracker.start(target);
    tracker.stop();
    target.dispatchEvent(pointer("pen"));
    expect(tracker.detected).toBe(false);
  });
});

function storeWith(values: Record<string, unknown>): SettingsStore {
  return {
    get: (path: string) => values[path],
    set: (path: string, value: unknown) => {
      values[path] = value;
    },
  } as unknown as SettingsStore;
}

describe("rememberPenInput", () => {
  it("stores the first pen seen, so the next session knows it", () => {
    const values: Record<string, unknown> = {};
    const target = new EventTarget();
    const tracker = new PenInputTracker();
    tracker.start(target);
    rememberPenInput(tracker, storeWith(values));
    expect(values[PEN_DETECTED_PATH]).toBeUndefined();
    target.dispatchEvent(pointer("pen"));
    expect(values[PEN_DETECTED_PATH]).toBe(true);

    const next = new PenInputTracker();
    rememberPenInput(next, storeWith(values));
    expect(next.known).toBe(true);
  });

  it("leaves the pen unknown when no session has seen one", () => {
    const tracker = new PenInputTracker();
    rememberPenInput(tracker, storeWith({ [PEN_DETECTED_PATH]: false }));
    expect(tracker.known).toBe(false);
  });
});
