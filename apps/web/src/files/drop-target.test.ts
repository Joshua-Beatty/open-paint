import { describe, expect, it, vi } from "vitest";
import { installDropTarget } from "./drop-target";

/** A window stand-in: the listeners are real, and events carry a data transfer. */
function setup() {
  const target = new EventTarget() as unknown as Window;
  const onDrop = vi.fn();
  const release = installDropTarget(target, onDrop);
  return { target, onDrop, release };
}

function dispatch(target: Window, type: string, types: readonly string[]): Event {
  const event = new Event(type, { cancelable: true });
  const data = { types, dropEffect: "none" };
  Object.defineProperty(event, "dataTransfer", { value: data });
  (target as unknown as EventTarget).dispatchEvent(event);
  return event;
}

describe("installDropTarget (UI-DOC-02)", () => {
  it("accepts a drag of files and marks it as a copy", () => {
    const { target } = setup();

    const event = dispatch(target, "dragover", ["Files"]);

    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves a drag of text alone", () => {
    const { target } = setup();

    const event = dispatch(target, "dragover", ["text/plain"]);

    expect(event.defaultPrevented).toBe(false);
  });

  it("hands a drop of files to the handler, with its data transfer", () => {
    const { target, onDrop } = setup();

    const event = dispatch(target, "drop", ["Files"]);

    expect(event.defaultPrevented).toBe(true);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("ignores a drop of text", () => {
    const { target, onDrop } = setup();

    dispatch(target, "drop", ["text/plain"]);

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("stops listening when released", () => {
    const { target, onDrop, release } = setup();
    release();

    dispatch(target, "drop", ["Files"]);

    expect(onDrop).not.toHaveBeenCalled();
  });
});
