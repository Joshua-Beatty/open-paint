/** A point in image pixels. */
export interface TextPoint {
  readonly x: number;
  readonly y: number;
}

/** The measurements a text block lays out with, from the text engine in the current font. */
export interface TextMetrics {
  /** The advance width of one line, in pixels. */
  measure(text: string): number;
  /** The distance from the top of a line to its baseline, in pixels. */
  readonly ascent: number;
  /** The distance from one line's top to the next, in pixels. */
  readonly lineHeight: number;
}

/** The horizontal alignment of the lines of a block (TL-OPT-TEXT "Alignment"). */
export type TextAlignment = "Left" | "Center" | "Right";

/** One laid-out line, in image pixels. `start` is the index of its first character in the text. */
export interface TextLine {
  readonly text: string;
  readonly start: number;
  /** The left edge of the line after alignment. */
  readonly x: number;
  /** The top of the line. */
  readonly y: number;
  readonly width: number;
}

export interface TextLayout {
  readonly lines: readonly TextLine[];
  /** The width of the widest line. */
  readonly width: number;
  /** The height of all lines. */
  readonly height: number;
  /** The caret's left edge and top, and its height. */
  readonly caret: { readonly x: number; readonly y: number; readonly height: number };
}

const WORD = /[\p{L}\p{N}_]/u;
const SPACE = /\s/u;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The text of the Text tool while it is being edited (TL-TEXT-01): the characters, the caret, the
 * anchor point in image pixels and the editing keys. Lines are separated by "\n". The block knows
 * nothing about fonts or pixels: layout and hit tests take the metrics of the current font.
 */
export class TextBlock {
  #text: string;
  #caret: number;
  #anchor: TextPoint;
  /** The caret's x offset within its line, kept while moving up and down. */
  #column: number | undefined;

  constructor(anchor: TextPoint, text = "") {
    this.#anchor = { x: anchor.x, y: anchor.y };
    this.#text = text;
    this.#caret = text.length;
  }

  get text(): string {
    return this.#text;
  }

  get caret(): number {
    return this.#caret;
  }

  get anchor(): TextPoint {
    return { ...this.#anchor };
  }

  get isEmpty(): boolean {
    return this.#text.length === 0;
  }

  /** A copy of the block with the same text, caret and anchor. */
  clone(): TextBlock {
    const copy = new TextBlock(this.#anchor, this.#text);
    copy.#caret = this.#caret;
    return copy;
  }

  /** Moves the anchor point to a new position. */
  setAnchor(point: TextPoint): void {
    this.#anchor = { x: point.x, y: point.y };
  }

  /** Inserts text at the caret. Every kind of line break becomes "\n". */
  insert(text: string): void {
    const normal = text.replace(/\r\n?/g, "\n");
    if (normal === "") return;
    this.#text = this.#text.slice(0, this.#caret) + normal + this.#text.slice(this.#caret);
    this.#caret += normal.length;
    this.#column = undefined;
  }

  /** Deletes the character before the caret, or the word before it when `word` is set. */
  deleteBackward(word: boolean): void {
    this.#remove(word ? this.#wordStart(this.#caret) : this.#previous(this.#caret), this.#caret);
  }

  /** Deletes the character after the caret, or the word after it when `word` is set. */
  deleteForward(word: boolean): void {
    this.#remove(this.#caret, word ? this.#wordEnd(this.#caret) : this.#next(this.#caret));
  }

  /** Moves the caret one character, or one word, to the left. */
  moveLeft(word: boolean): void {
    this.#moveCaret(word ? this.#wordStart(this.#caret) : this.#previous(this.#caret));
  }

  /** Moves the caret one character, or one word, to the right. */
  moveRight(word: boolean): void {
    this.#moveCaret(word ? this.#wordEnd(this.#caret) : this.#next(this.#caret));
  }

  /** Moves the caret to the start of its line. */
  moveHome(): void {
    this.#moveCaret(this.#text.lastIndexOf("\n", this.#caret - 1) + 1);
  }

  /** Moves the caret to the end of its line. */
  moveEnd(): void {
    const line = this.#text.indexOf("\n", this.#caret);
    this.#moveCaret(line === -1 ? this.#text.length : line);
  }

  /**
   * Moves the caret to the line above or below, at the same x offset as before. The caret goes to
   * the start or the end of the text when it is already on the first or the last line.
   */
  moveVertical(delta: -1 | 1, metrics: TextMetrics, alignment: TextAlignment): void {
    const { lines, caret } = this.layout(metrics, alignment);
    const current = lineIndexAt(lines, this.#caret);
    const target = current + delta;
    const column = this.#column ?? caret.x - (lines[current]?.x ?? 0);
    if (target < 0) this.#caret = 0;
    else if (target >= lines.length) this.#caret = this.#text.length;
    else {
      const line = lines[target];
      if (line !== undefined) this.#caret = line.start + indexAtOffset(line.text, column, metrics);
    }
    this.#column = column;
  }

  /** Moves the caret to the character nearest to a point, as a click does. */
  caretAt(point: TextPoint, metrics: TextMetrics, alignment: TextAlignment): void {
    const { lines } = this.layout(metrics, alignment);
    const row = Math.floor((point.y - this.#anchor.y) / metrics.lineHeight);
    const line = lines[Math.min(Math.max(row, 0), lines.length - 1)];
    if (line === undefined) return;
    this.#caret = line.start + indexAtOffset(line.text, point.x - line.x, metrics);
    this.#column = undefined;
  }

  /** The lines and the caret in image pixels. Empty text is one empty line at the anchor. */
  layout(metrics: TextMetrics, alignment: TextAlignment): TextLayout {
    const texts = this.#text.split("\n");
    const widths = texts.map((text) => metrics.measure(text));
    const width = widths.reduce((widest, value) => Math.max(widest, value), 0);
    let start = 0;
    const lines = texts.map((text, index): TextLine => {
      const lineWidth = widths[index] ?? 0;
      const offset =
        alignment === "Center"
          ? (width - lineWidth) / 2
          : alignment === "Right"
            ? width - lineWidth
            : 0;
      const line = {
        text,
        start,
        x: this.#anchor.x + offset,
        y: this.#anchor.y + index * metrics.lineHeight,
        width: lineWidth,
      };
      start += text.length + 1;
      return line;
    });
    const current = lines[lineIndexAt(lines, this.#caret)] ?? lines[0];
    const caretX =
      current === undefined
        ? this.#anchor.x
        : current.x + metrics.measure(current.text.slice(0, this.#caret - current.start));
    return {
      lines,
      width,
      height: texts.length * metrics.lineHeight,
      caret: { x: caretX, y: current?.y ?? this.#anchor.y, height: metrics.lineHeight },
    };
  }

  #moveCaret(to: number): void {
    this.#caret = Math.min(Math.max(to, 0), this.#text.length);
    this.#column = undefined;
  }

  #remove(from: number, to: number): void {
    if (to <= from) return;
    this.#text = this.#text.slice(0, from) + this.#text.slice(to);
    this.#caret = from;
    this.#column = undefined;
  }

  /** The index of the character before `index`, stepping over a surrogate pair. */
  #previous(index: number): number {
    if (index <= 0) return 0;
    const before = this.#text.charCodeAt(index - 1);
    const pair = index >= 2 && isLowSurrogate(before);
    return pair && isHighSurrogate(this.#text.charCodeAt(index - 2)) ? index - 2 : index - 1;
  }

  /** The index of the character after `index`, stepping over a surrogate pair. */
  #next(index: number): number {
    if (index >= this.#text.length) return this.#text.length;
    const code = this.#text.charCodeAt(index);
    const pair = isHighSurrogate(code) && index + 1 < this.#text.length;
    return pair && isLowSurrogate(this.#text.charCodeAt(index + 1)) ? index + 2 : index + 1;
  }

  /**
   * The start of the word before `index`. Spaces (line breaks included) are skipped first, then a
   * run of letters and digits, or a run of other symbols, is skipped.
   */
  #wordStart(index: number): number {
    let at = index;
    while (at > 0 && SPACE.test(this.#text.charAt(at - 1))) at--;
    if (at === 0) return 0;
    const word = WORD.test(this.#text.charAt(at - 1));
    while (at > 0) {
      const char = this.#text.charAt(at - 1);
      if (SPACE.test(char) || WORD.test(char) !== word) break;
      at--;
    }
    return at;
  }

  /** The end of the word after `index`, the mirror of `#wordStart`. */
  #wordEnd(index: number): number {
    let at = index;
    const length = this.#text.length;
    while (at < length && SPACE.test(this.#text.charAt(at))) at++;
    if (at === length) return length;
    const word = WORD.test(this.#text.charAt(at));
    while (at < length) {
      const char = this.#text.charAt(at);
      if (SPACE.test(char) || WORD.test(char) !== word) break;
      at++;
    }
    return at;
  }
}

/** The index of the line that holds a caret position. A caret on a line break belongs to its line. */
function lineIndexAt(lines: readonly TextLine[], caret: number): number {
  let index = 0;
  for (let line = 0; line < lines.length; line++) {
    if ((lines[line]?.start ?? 0) <= caret) index = line;
  }
  return index;
}

/**
 * The character offset within a line whose caret is nearest to `offset` pixels from the line's left
 * edge. Candidates are the boundaries between code points.
 */
function indexAtOffset(text: string, offset: number, metrics: TextMetrics): number {
  let best = 0;
  let bestDistance = Math.abs(offset);
  let index = 0;
  for (const glyph of Array.from(text)) {
    index += glyph.length;
    const distance = Math.abs(metrics.measure(text.slice(0, index)) - offset);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}
