import { describe, expect, it } from "vitest";
import {
  chordKey,
  chordMatches,
  formatChord,
  type KeyEventLike,
  parseChord,
  platformFromName,
} from "./keys";

function event(code: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  };
}

describe("parseChord", () => {
  it("reads the primary modifier, Shift and Alt, and the key's layout-independent code", () => {
    expect(parseChord("Ctrl+Shift+N")).toEqual({
      code: "KeyN",
      primary: true,
      shift: true,
      alt: false,
    });
    expect(parseChord("Alt+Shift+H")).toEqual({
      code: "KeyH",
      primary: false,
      shift: true,
      alt: true,
    });
  });

  it("names punctuation, digits, function keys and the numeric keypad", () => {
    expect(parseChord("Ctrl+[").code).toBe("BracketLeft");
    expect(parseChord("Ctrl+-").code).toBe("Minus");
    expect(parseChord("Ctrl+,").code).toBe("Comma");
    expect(parseChord("Alt+0").code).toBe("Digit0");
    expect(parseChord("F12").code).toBe("F12");
    expect(parseChord("Ctrl+NumpadAdd").code).toBe("NumpadAdd");
    expect(parseChord("Ctrl+Numpad0").code).toBe("Numpad0");
  });

  it("rejects unknown keys, unknown modifiers and repeated modifiers", () => {
    expect(() => parseChord("Win+N")).toThrow('Invalid shortcut modifier "Win"');
    expect(() => parseChord("Ctrl+Ctrl+N")).toThrow('Invalid shortcut modifier "Ctrl"');
    expect(() => parseChord("Ctrl+")).toThrow('Unknown shortcut key ""');
    expect(() => parseChord("Ctrl+Hyper")).toThrow('Unknown shortcut key "Hyper"');
  });
});

describe("formatChord (WEB-KEY-06)", () => {
  it("spells the modifiers out on Windows and Linux", () => {
    expect(formatChord(parseChord("Ctrl+Shift+N"), "other")).toBe("Ctrl+Shift+N");
    expect(formatChord(parseChord("Alt+Shift+H"), "other")).toBe("Alt+Shift+H");
    expect(formatChord(parseChord("Ctrl+Alt+S"), "other")).toBe("Ctrl+Alt+S");
    expect(formatChord(parseChord("Shift+Delete"), "other")).toBe("Shift+Delete");
    expect(formatChord(parseChord("Ctrl+0"), "other")).toBe("Ctrl+0");
  });

  it("shows the spec's labels for the numeric keypad and punctuation", () => {
    expect(formatChord(parseChord("Ctrl+NumpadAdd"), "other")).toBe("Ctrl++");
    expect(formatChord(parseChord("Ctrl+="), "other")).toBe("Ctrl+=");
    expect(formatChord(parseChord("Ctrl+,"), "other")).toBe("Ctrl+,");
    expect(formatChord(parseChord("Alt+0"), "other")).toBe("Alt+0");
  });

  it("uses Apple's symbols on macOS, where Ctrl means Command", () => {
    expect(formatChord(parseChord("Ctrl+S"), "mac")).toBe("⌘S");
    expect(formatChord(parseChord("Ctrl+Shift+Alt+C"), "mac")).toBe("⌥⇧⌘C");
    expect(formatChord(parseChord("Alt+X"), "mac")).toBe("⌥X");
  });
});

describe("chordMatches", () => {
  it("matches the primary modifier on Windows and Linux", () => {
    const save = parseChord("Ctrl+S");
    expect(chordMatches(save, event("KeyS", { ctrlKey: true }), "other")).toBe(true);
    expect(chordMatches(save, event("KeyS", { metaKey: true }), "other")).toBe(false);
  });

  it("matches Command, and not Ctrl, on macOS", () => {
    const save = parseChord("Ctrl+S");
    expect(chordMatches(save, event("KeyS", { metaKey: true }), "mac")).toBe(true);
    expect(chordMatches(save, event("KeyS", { ctrlKey: true }), "mac")).toBe(false);
  });

  it("requires every modifier to match exactly", () => {
    const newImage = parseChord("Ctrl+N");
    expect(chordMatches(newImage, event("KeyN", { ctrlKey: true, shiftKey: true }), "other")).toBe(
      false,
    );
    expect(chordMatches(newImage, event("KeyN", { ctrlKey: true, altKey: true }), "other")).toBe(
      false,
    );
    expect(chordMatches(newImage, event("KeyN"), "other")).toBe(false);
  });

  it("ignores a stray Windows key or the other platform's primary key", () => {
    const save = parseChord("Ctrl+S");
    expect(chordMatches(save, event("KeyS", { ctrlKey: true, metaKey: true }), "other")).toBe(
      false,
    );
    expect(chordMatches(save, event("KeyS", { ctrlKey: true, metaKey: true }), "mac")).toBe(false);
  });

  it("matches the same physical key whatever characters the layout types", () => {
    expect(
      chordMatches(parseChord("Ctrl+["), event("BracketLeft", { ctrlKey: true }), "other"),
    ).toBe(true);
    expect(chordMatches(parseChord("Ctrl+["), event("KeyS", { ctrlKey: true }), "other")).toBe(
      false,
    );
  });
});

describe("chordKey", () => {
  it("is equal for two chords exactly when they match the same events", () => {
    expect(chordKey(parseChord("Ctrl+S"))).not.toBe(chordKey(parseChord("Ctrl+Shift+S")));
    expect(chordKey(parseChord("Ctrl+S"))).toBe(chordKey(parseChord("Ctrl+S")));
    expect(chordKey(parseChord("Alt+1"))).not.toBe(chordKey(parseChord("Ctrl+1")));
  });
});

describe("platformFromName", () => {
  it("recognises Apple platforms and treats everything else as the other platform", () => {
    expect(platformFromName("MacIntel")).toBe("mac");
    expect(platformFromName("iPad")).toBe("mac");
    expect(platformFromName("Win32")).toBe("other");
    expect(platformFromName("Linux x86_64")).toBe("other");
  });
});
