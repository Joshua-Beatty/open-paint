import { describe, expect, it } from "vitest";
import { TextBlock, type TextMetrics } from "./text-model";

/** Every character is 6 pixels wide, and a line is 14 pixels high. */
const metrics: TextMetrics = {
  measure: (text) => [...text].length * 6,
  ascent: 10,
  lineHeight: 14,
};

describe("TextBlock editing (TL-TEXT-01)", () => {
  it("inserts at the caret and keeps the caret after the new text", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "ac");
    block.moveLeft(false);
    block.insert("b");
    expect(block.text).toBe("abc");
    expect(block.caret).toBe(2);
  });

  it("turns every kind of line break into a newline", () => {
    const block = new TextBlock({ x: 0, y: 0 });
    block.insert("a\r\nb\rc\nd");
    expect(block.text).toBe("a\nb\nc\nd");
  });

  it("deletes one character, or one word, before and after the caret", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "one two  three");
    block.deleteBackward(true);
    expect(block.text).toBe("one two  ");
    block.moveHome();
    block.deleteForward(true);
    expect(block.text).toBe(" two  ");
    block.moveEnd();
    block.deleteBackward(false);
    expect(block.text).toBe(" two ");
  });

  it("deletes a surrogate pair as one character", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "a😀");
    block.deleteBackward(false);
    expect(block.text).toBe("a");
  });

  it("moves by character and by word, across line breaks", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "ab cd\nef");
    block.moveLeft(true);
    expect(block.caret).toBe(6);
    block.moveLeft(true);
    expect(block.caret).toBe(3);
    block.moveRight(true);
    expect(block.caret).toBe(5);
    block.moveRight(false);
    expect(block.caret).toBe(6);
    block.moveRight(false);
    expect(block.caret).toBe(7);
  });

  it("Home and End go to the start and end of the current line", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "first\nsecond");
    block.moveLeft(false);
    block.moveHome();
    expect(block.caret).toBe(6);
    block.moveEnd();
    expect(block.caret).toBe(12);
  });

  it("clamps the caret to the text", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "ab");
    block.moveRight(false);
    expect(block.caret).toBe(2);
    block.moveLeft(true);
    block.moveLeft(true);
    block.moveLeft(true);
    expect(block.caret).toBe(0);
  });
});

describe("TextBlock layout", () => {
  it("lays out one line at the anchor, with the caret at the end", () => {
    const layout = new TextBlock({ x: 4, y: 8 }, "abc").layout(metrics, "Left");
    expect(layout.lines).toEqual([{ text: "abc", start: 0, x: 4, y: 8, width: 18 }]);
    expect(layout.width).toBe(18);
    expect(layout.height).toBe(14);
    expect(layout.caret).toEqual({ x: 22, y: 8, height: 14 });
  });

  it("stacks lines by the line height and tracks each line's start", () => {
    const layout = new TextBlock({ x: 0, y: 0 }, "ab\ncde").layout(metrics, "Left");
    expect(layout.lines.map((line) => [line.start, line.y])).toEqual([
      [0, 0],
      [3, 14],
    ]);
    expect(layout.height).toBe(28);
  });

  it("aligns the lines inside the widest line", () => {
    const block = new TextBlock({ x: 10, y: 0 }, "a\nabcd");
    const centre = block.layout(metrics, "Center").lines.map((line) => line.x);
    expect(centre).toEqual([19, 10]);
    const right = block.layout(metrics, "Right").lines.map((line) => line.x);
    expect(right).toEqual([28, 10]);
  });

  it("puts the caret on the line it belongs to, even after a line break", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "ab\ncd");
    block.moveHome();
    block.moveLeft(false);
    expect(block.layout(metrics, "Left").caret).toEqual({ x: 12, y: 0, height: 14 });
    block.moveLeft(false);
    expect(block.layout(metrics, "Left").caret).toEqual({ x: 6, y: 0, height: 14 });
  });
});

describe("TextBlock vertical moves and clicks", () => {
  it("moves up and down at the same x offset", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "abcdef\nxy\nghijkl");
    block.moveHome();
    block.moveRight(false);
    block.moveRight(false);
    block.moveRight(false);
    block.moveVertical(-1, metrics, "Left");
    expect(block.caret).toBe(9);
    block.moveVertical(-1, metrics, "Left");
    expect(block.caret).toBe(3);
    block.moveVertical(1, metrics, "Left");
    expect(block.caret).toBe(9);
  });

  it("keeps the wanted column across a short line", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "abcdef\nx\nghijkl");
    block.moveHome();
    block.moveRight(false);
    block.moveRight(false);
    block.moveRight(false);
    block.moveRight(false);
    block.moveVertical(-1, metrics, "Left");
    expect(block.caret).toBe(8);
    block.moveVertical(-1, metrics, "Left");
    expect(block.caret).toBe(4);
  });

  it("moves to the start or the end of the text past the first or last line", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "ab\ncd");
    block.moveHome();
    block.moveVertical(-1, metrics, "Left");
    expect(block.caret).toBe(0);
    block.moveVertical(-1, metrics, "Left");
    expect(block.caret).toBe(0);
    block.moveVertical(1, metrics, "Left");
    expect(block.caret).toBe(3);
    block.moveVertical(1, metrics, "Left");
    expect(block.caret).toBe(5);
  });

  it("a click places the caret at the nearest character of the clicked line", () => {
    const block = new TextBlock({ x: 0, y: 0 }, "abcd\nefgh");
    block.caretAt({ x: 13, y: 20 }, metrics, "Left");
    expect(block.caret).toBe(7);
    block.caretAt({ x: 100, y: -50 }, metrics, "Left");
    expect(block.caret).toBe(4);
  });

  it("the anchor moves without changing the text", () => {
    const block = new TextBlock({ x: 1, y: 2 }, "a");
    block.setAnchor({ x: 9, y: 9 });
    expect(block.anchor).toEqual({ x: 9, y: 9 });
    expect(block.clone().text).toBe("a");
  });
});
