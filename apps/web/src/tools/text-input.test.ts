// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomTextInput, type TextInputHandlers } from "./text-input";

function handlers(overrides: Partial<TextInputHandlers> = {}) {
  return {
    key: vi.fn((): boolean => false),
    keyUp: vi.fn(),
    text: vi.fn(),
    composition: vi.fn(),
    paste: vi.fn(),
    ...overrides,
  } satisfies TextInputHandlers;
}

function field(): HTMLTextAreaElement {
  const area = document.querySelector("textarea");
  if (area === null) throw new Error("no text input");
  return area;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DomTextInput (TL-TEXT-01)", () => {
  it("creates a labelled hidden text field, focuses it and removes it on dispose", () => {
    const port = new DomTextInput(handlers(), "Text");
    expect(field().getAttribute("aria-label")).toBe("Text");
    port.focus();
    expect(document.activeElement).toBe(field());
    port.blur();
    expect(document.activeElement).not.toBe(field());
    port.dispose();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports key presses, and suppresses the default action only when the tool used the key", () => {
    const h = handlers({ key: vi.fn((key) => key.code === "Enter") });
    const port = new DomTextInput(h, "Text");
    const enter = new KeyboardEvent("keydown", { code: "Enter", cancelable: true });
    field().dispatchEvent(enter);
    expect(h.key).toHaveBeenCalledWith({
      code: "Enter",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    });
    expect(enter.defaultPrevented).toBe(true);
    const letter = new KeyboardEvent("keydown", { code: "KeyA", cancelable: true });
    field().dispatchEvent(letter);
    expect(letter.defaultPrevented).toBe(false);
    port.dispose();
  });

  it("takes typed characters out of the field once, and reports them", () => {
    const h = handlers();
    const port = new DomTextInput(h, "Text");
    field().value = "ab";
    field().dispatchEvent(new Event("input"));
    expect(h.text).toHaveBeenCalledWith("ab");
    expect(field().value).toBe("");
    port.dispose();
  });

  it("follows an IME composition: updates show the preedit, and the end commits it once", () => {
    const h = handlers();
    const port = new DomTextInput(h, "Text");
    const area = field();
    area.dispatchEvent(new CompositionEvent("compositionstart"));
    area.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ni" }));
    expect(h.composition).toHaveBeenLastCalledWith("ni");
    area.value = "ni";
    area.dispatchEvent(new Event("input"));
    expect(h.text).not.toHaveBeenCalled();
    area.dispatchEvent(new CompositionEvent("compositionend", { data: "你" }));
    expect(h.composition).toHaveBeenLastCalledWith(undefined);
    expect(h.text).toHaveBeenCalledTimes(1);
    expect(h.text).toHaveBeenCalledWith("你");
    expect(area.value).toBe("");
    port.dispose();
  });

  it("paste takes the plain text and suppresses the default action", () => {
    const h = handlers();
    const port = new DomTextInput(h, "Text");
    const paste = new Event("paste", { cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "x\ny" : "") },
    });
    field().dispatchEvent(paste);
    expect(h.paste).toHaveBeenCalledWith("x\ny");
    expect(paste.defaultPrevented).toBe(true);
    port.dispose();
  });

  it("reports key releases", () => {
    const h = handlers();
    const port = new DomTextInput(h, "Text");
    field().dispatchEvent(new KeyboardEvent("keyup", { code: "ControlLeft" }));
    expect(h.keyUp).toHaveBeenCalledWith("ControlLeft");
    port.dispose();
  });
});
