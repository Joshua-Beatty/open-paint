import { afterEach, describe, expect, it } from "vitest";
import { guardUnload } from "./unload-guard";

function beforeUnload(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("guardUnload", () => {
  let release: (() => void) | undefined;

  afterEach(() => {
    release?.();
    release = undefined;
  });

  it("asks the browser to confirm while an image has unsaved changes (WEB-UI-06)", () => {
    let dirty = true;
    release = guardUnload(window, () => dirty);
    expect(beforeUnload().defaultPrevented).toBe(true);
    dirty = false;
    expect(beforeUnload().defaultPrevented).toBe(false);
  });

  it("stops asking once the guard is removed", () => {
    release = guardUnload(window, () => true);
    release();
    release = undefined;
    expect(beforeUnload().defaultPrevented).toBe(false);
  });
});
