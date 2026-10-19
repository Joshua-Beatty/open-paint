import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_MERGE_MS, EditBurst, paintColors, settleEditBursts } from "./edit-burst";

describe("EditBurst", () => {
  const frames: (() => void)[] = [];
  const preview = vi.fn();
  const record = vi.fn();
  let edits: EditBurst;

  beforeEach(() => {
    vi.useFakeTimers();
    frames.length = 0;
    preview.mockClear();
    record.mockClear();
    edits = new EditBurst({
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
    edits.changed("history.changeColor");
    edits.changed("history.changeColor");
    edits.changed("history.changeColor");
    expect(preview).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("records changes that follow each other once, after they stop, named after the latest", () => {
    edits.changed("history.changeColor");
    vi.advanceTimersByTime(EDIT_MERGE_MS - 1);
    edits.changed("history.changeBrushSize");
    vi.advanceTimersByTime(EDIT_MERGE_MS - 1);
    expect(record).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("history.changeBrushSize");
    expect(edits.pending).toBe(false);
  });

  it("keeps the burst open while a mouse button is held, and records on its release", () => {
    window.dispatchEvent(new MouseEvent("pointerdown", { buttons: 1 }));
    edits.changed("history.changeTolerance");
    vi.advanceTimersByTime(EDIT_MERGE_MS * 4);
    expect(record).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("pointerup", { buttons: 0 }));
    expect(record).toHaveBeenCalledWith("history.changeTolerance");
  });

  it("records at once on flush or settle, and not again", () => {
    edits.changed("history.changeColor");
    settleEditBursts();
    expect(record).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
    edits.flush();
    vi.advanceTimersByTime(EDIT_MERGE_MS);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("forgets changes on cancel", () => {
    edits.changed("history.changeColor");
    edits.cancel();
    vi.advanceTimersByTime(EDIT_MERGE_MS);
    settleEditBursts();
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
