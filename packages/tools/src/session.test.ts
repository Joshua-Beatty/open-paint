import { describe, expect, it } from "vitest";
import { type CommitKeyEvent, escapeAction, isCommitKey } from "./session";

const plain: CommitKeyEvent = {
  code: "Enter",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
};

describe("escapeAction", () => {
  it("cancels a drawing before anything else", () => {
    expect(escapeAction({ drawing: true, pending: true, canDeselect: true })).toBe("cancelDrawing");
  });

  it("commits a pending result when no pointer is down", () => {
    expect(escapeAction({ drawing: false, pending: true, canDeselect: true })).toBe("commit");
  });

  it("deselects when nothing is pending and a selection exists", () => {
    expect(escapeAction({ drawing: false, pending: false, canDeselect: true })).toBe("deselect");
  });

  it("does nothing without a selection", () => {
    expect(escapeAction({ drawing: false, pending: false, canDeselect: false })).toBe("none");
  });
});

describe("isCommitKey", () => {
  it("accepts Enter, the keypad Enter and Escape without modifiers", () => {
    expect(isCommitKey(plain)).toBe(true);
    expect(isCommitKey({ ...plain, code: "NumpadEnter" })).toBe(true);
    expect(isCommitKey({ ...plain, code: "Escape" })).toBe(true);
  });

  it("rejects modified keys and other keys", () => {
    expect(isCommitKey({ ...plain, code: "Escape", ctrlKey: true })).toBe(false);
    expect(isCommitKey({ ...plain, code: "Enter", shiftKey: true })).toBe(false);
    expect(isCommitKey({ ...plain, code: "Escape", altKey: true })).toBe(false);
    expect(isCommitKey({ ...plain, code: "KeyA" })).toBe(false);
  });
});
