import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLOR_MERGE_MS, ColorEdits, paintColors, settleColorEdits } from "./color-edits";

describe("ColorEdits", () => {
  const frames: (() => void)[] = [];
  const preview = vi.fn();
  const record = vi.fn();
  let edits: ColorEdits;

  beforeEach(() => {
    vi.useFakeTimers();
    frames.length = 0;
    preview.mockClear();
    record.mockClear();
    edits = new ColorEdits({
      scheduleFrame: (callback) => {
        frames.push(callback);
        return () => frames.splice(frames.indexOf(callback), 1);
      },
      preview,
      record,
    });
  });

  afterEach(() => {
    edits.cancel();
    vi.useRealTimers();
  });

  it("draws a burst of changes once, on the next frame (L1)", () => {
    edits.changed();
    edits.changed();
    edits.changed();
    expect(preview).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("records changes that follow each other once, after they stop", () => {
    edits.changed();
    vi.advanceTimersByTime(COLOR_MERGE_MS - 1);
    edits.changed();
    vi.advanceTimersByTime(COLOR_MERGE_MS - 1);
    expect(record).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(edits.pending).toBe(false);
  });

  it("records at once on flush or settle, and not again", () => {
    edits.changed();
    settleColorEdits();
    expect(record).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
    edits.flush();
    vi.advanceTimersByTime(COLOR_MERGE_MS);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("forgets changes on cancel", () => {
    edits.changed();
    edits.cancel();
    vi.advanceTimersByTime(COLOR_MERGE_MS);
    settleColorEdits();
    expect(record).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("paintColors (TL-FRAME-03)", () => {
  const red = { r: 255, g: 0, b: 0, a: 255 };
  const blue = { r: 0, g: 0, b: 255, a: 255 };
  const values: Record<string, unknown> = {
    "tools.primaryColor": red,
    "tools.secondaryColor": blue,
  };
  const settings = {
    get: (path: string) => values[path],
    set: () => undefined,
    onChange: () => () => undefined,
  } as unknown as Parameters<typeof paintColors>[0];

  it("paints with the primary for the left button and the secondary for the right", () => {
    expect(paintColors(settings, 0)).toEqual({ color: red, background: blue });
    expect(paintColors(settings, 2)).toEqual({ color: blue, background: red });
  });
});
