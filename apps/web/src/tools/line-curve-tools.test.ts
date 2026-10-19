// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, rect, rectPolygon } from "@openpaint/document";
import type { ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import type { SettingChange } from "@openpaint/storage";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import { settleEditBursts } from "./edit-burst";
import { lineCurveHandles } from "./line-curve-handles";
import { lineCurveToolRuntime } from "./line-curve-tools";
import { NUDGE_MERGE_MS } from "./nudge-burst";
import type { PaintHost } from "./paint-tools";
import { bindToolHistory, soloSwitcher } from "./tool-history";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const GREEN = { r: 0, g: 255, b: 0, a: 255 };
const YELLOW = { r: 255, g: 255, b: 0, a: 255 };
const WHITE = { r: 255, g: 255, b: 255, a: 255 };

/** A settings fake that reports its own changes to the listeners, as the store does. */
class FakeSettings {
  readonly values: Record<string, unknown>;
  readonly #listeners = new Set<(change: SettingChange) => void>();

  constructor() {
    this.values = {
      "tools.primaryColor": GREEN,
      "tools.secondaryColor": YELLOW,
      "tools.brush.size": 2,
      "tools.brush.fillType": "Solid",
      "tools.brush.hatchStyle": "BackwardDiagonal",
      "tools.blendMode": "normal",
      "tools.antialiasing": false,
      "tools.selection.renderingQuality": "Antialiased",
      "tools.shapes.curveType": "Spline",
      "tools.pen.dashStyle": "Solid",
      "tools.pen.startCap": "Flat",
      "tools.pen.endCap": "Flat",
    };
  }

  get = (path: string): unknown => this.values[path];

  set(path: string, value: unknown): void {
    this.values[path] = value;
    for (const listener of this.#listeners) {
      listener({ path, value: value as SettingChange["value"], source: "local" });
    }
  }

  onChange = (listener: (change: SettingChange) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}

function event(
  type: ToolPointerEvent["type"],
  x: number,
  y: number,
  button = 0,
  modifiers: { readonly shift?: boolean; readonly alt?: boolean } = {},
): ToolPointerEvent {
  return {
    type,
    x,
    y,
    button,
    pressure: 1,
    shiftKey: modifiers.shift === true,
    altKey: modifiers.alt === true,
    ctrlKey: false,
  };
}

describe("Line / Curve (TL-LINE-01)", () => {
  let doc: Document;
  let settings: FakeSettings;
  let runtime: ToolRuntime;
  const status = vi.fn<(text: string) => void>();
  const notify = vi.fn();
  const report = vi.fn();

  function pixel(x: number, y: number) {
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    return layer.pixels.getPixel(x, y);
  }

  function drag(from: [number, number], to: [number, number], button = 0, modifiers = {}): void {
    runtime.pointer(event("down", from[0], from[1], button, modifiers));
    runtime.pointer(event("move", to[0], to[1], button, modifiers));
    runtime.pointer(event("up", to[0], to[1], button, modifiers));
  }

  function names(): string[] {
    return doc.history.entries.map((entry) => entry.name);
  }

  let host: PaintHost;

  beforeEach(() => {
    doc = Document.createBlank({ width: 40, height: 40 });
    settings = new FakeSettings();
    host = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (id, values) => (values === undefined ? id : `${id}:${JSON.stringify(values)}`),
      notify,
      report,
      status,
    };
    runtime = lineCurveToolRuntime(host);
    runtime.activate();
    bindToolHistory(doc, soloSwitcher("lineCurve", runtime));
    status.mockClear();
    notify.mockClear();
    report.mockClear();
  });

  afterEach(() => {
    runtime.deactivate();
    lineCurveHandles.set({});
  });

  it("draws a straight line with the primary color and keeps it pending", () => {
    drag([4.5, 10.5], [30.5, 10.5]);
    expect(doc.history.undoName).toBe("history.drawLineCurve");
    expect(runtime.hasPending?.()).toBe(true);
    expect(pixel(10, 10)).toEqual(GREEN);
    expect(pixel(2, 10)).toEqual(WHITE);
    expect(pixel(33, 10)).toEqual(WHITE);
    expect(pixel(10, 20)).toEqual(WHITE);
  });

  it("uses the secondary color for the right button", () => {
    drag([4.5, 10.5], [30.5, 10.5], 2);
    expect(pixel(10, 10)).toEqual(YELLOW);
  });

  it("redraws the pending line in a new color and records one Change Color step (TL-FRAME-01)", async () => {
    const red = { r: 255, g: 0, b: 0, a: 255 };
    const blue = { r: 0, g: 0, b: 255, a: 255 };
    drag([4.5, 10.5], [30.5, 10.5], 2);
    const before = doc.history.entries.length;
    settings.set("tools.primaryColor", red);
    expect(pixel(10, 10)).toEqual(YELLOW);
    settings.set("tools.secondaryColor", red);
    settings.set("tools.secondaryColor", blue);
    expect(pixel(10, 10)).toEqual(blue);
    expect(doc.history.entries.length).toBe(before);
    runtime.commit?.();
    expect(names().slice(-2)).toEqual(["history.changeColor", "history.finishLineCurve"]);
    expect(pixel(10, 10)).toEqual(blue);
    await doc.history.undo();
    await doc.history.undo();
    expect(pixel(10, 10)).toEqual(YELLOW);
  });

  it("discards a zero-length line without a history item", () => {
    const before = doc.history.entries.length;
    drag([5.5, 5.5], [5.5, 5.5]);
    expect(doc.history.entries.length).toBe(before);
    expect(runtime.hasPending?.()).toBe(false);
  });

  it("draws nothing for a click that jitters within 4 CSS pixels, and moves no handle", () => {
    // At 100 % zoom: a canvas pixel is a CSS pixel.
    const at = (type: ToolPointerEvent["type"], x: number, y: number) => ({
      ...event(type, x, y),
      clientX: x,
      clientY: y,
    });
    const before = doc.history.entries.length;
    runtime.pointer(at("down", 5.5, 5.5));
    runtime.pointer(at("move", 7.5, 6.5));
    runtime.pointer(at("up", 8.5, 5.5));
    expect(doc.history.entries.length).toBe(before);
    expect(runtime.hasPending?.()).toBe(false);

    drag([5.5, 20.5], [35.5, 20.5]);
    const drawn = doc.history.entries.length;
    runtime.pointer(at("down", 15.5, 20.5));
    runtime.pointer(at("up", 15.5, 22.5));
    expect(doc.history.entries.length).toBe(drawn);
    expect(lineCurveHandles.state.end).toEqual({ x: 35.5, y: 20.5 });
  });

  it("snaps endpoints to pixel centers", () => {
    drag([4.9, 10.1], [30.2, 10.8]);
    expect(lineCurveHandles.state.start).toEqual({ x: 4.5, y: 10.5 });
    expect(lineCurveHandles.state.end).toEqual({ x: 30.5, y: 10.5 });
  });

  it("constrains the angle to 15 degree steps with Shift", () => {
    drag([10.5, 20.5], [30.5, 26.5], 0, { shift: true });
    const start = lineCurveHandles.state.start;
    const end = lineCurveHandles.state.end;
    if (start === undefined || end === undefined) throw new Error("no handles");
    const angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
    // The end snaps to a pixel center after the angle is constrained, so allow for that half pixel.
    expect(Math.abs(angle - Math.round(angle / 15) * 15)).toBeLessThan(2);
  });

  it("draws from the center with Alt", () => {
    drag([20.5, 20.5], [30.5, 20.5], 0, { alt: true });
    expect(lineCurveHandles.state.start).toEqual({ x: 10.5, y: 20.5 });
    expect(lineCurveHandles.state.end).toEqual({ x: 30.5, y: 20.5 });
  });

  it("moves an endpoint as an Adjust step, and the line follows", () => {
    drag([5.5, 10.5], [25.5, 10.5]);
    drag([25.5, 10.5], [25.5, 30.5]);
    expect(doc.history.undoName).toBe("history.adjustLineCurve");
    expect(pixel(15, 10)).toEqual(WHITE);
    expect(pixel(15, 20)).toEqual(GREEN);
  });

  it("drags a control point with the left button as a spline, as an Edit step", () => {
    drag([5.5, 20.5], [35.5, 20.5]);
    drag([15.5, 20.5], [15.5, 10.5]);
    expect(doc.history.undoName).toBe("history.editLineCurve");
    expect(lineCurveHandles.state.curve).toBe("Spline");
    expect(pixel(15, 10)).toEqual(GREEN);
  });

  it("shows a crosshair, and a hand on the endpoints and control points (TL-FRAME-06)", () => {
    const view = { canPan: false, panning: false };
    const cursorAt = (x: number, y: number) => {
      runtime.pointer(event("move", x, y));
      return runtime.cursor?.(view);
    };
    expect(cursorAt(5.5, 20.5)).toBe("crosshair");
    drag([5.5, 20.5], [35.5, 20.5]);
    expect(cursorAt(5.5, 20.5)).toBe("grab");
    expect(cursorAt(15.5, 20.5)).toBe("grab");
    expect(cursorAt(20.5, 35.5)).toBe("crosshair");
    runtime.pointer(event("down", 35.5, 20.5));
    expect(cursorAt(35.5, 30.5)).toBe("grabbing");
    runtime.pointer(event("up", 35.5, 30.5));
    runtime.tapCtrl?.();
    expect(cursorAt(5.5, 20.5)).toBe("crosshair");
    expect(runtime.cursor?.({ ...view, panning: true })).toBeUndefined();
  });

  it("moves the whole line by a whole-pixel drag on its body, as one Adjust step", () => {
    const view = { canPan: false, panning: false };
    drag([4.5, 20.5], [44.5, 20.5]);
    runtime.pointer(event("move", 25, 22));
    // Between the handles, within half the pen width plus the 4 px dead zone of the line.
    expect(runtime.cursor?.(view)).toBe("move");
    runtime.pointer(event("move", 25, 28));
    expect(runtime.cursor?.(view)).toBe("crosshair");
    const before = doc.history.entries.length;
    runtime.pointer(event("down", 25, 22));
    runtime.pointer(event("move", 26, 30.6));
    expect(runtime.cursor?.(view)).toBe("move");
    runtime.pointer(event("up", 26.2, 31.4));
    expect(doc.history.entries.length).toBe(before + 1);
    expect(doc.history.undoName).toBe("history.adjustLineCurve");
    expect(lineCurveHandles.state.start).toEqual({ x: 5.5, y: 29.5 });
    expect(lineCurveHandles.state.end).toEqual({ x: 45.5, y: 29.5 });
    expect(pixel(25, 20)).toEqual(WHITE);
    expect(pixel(25, 29)).toEqual(GREEN);
    expect(runtime.hasPending?.()).toBe(true);
  });

  it("nudges the whole line by arrow keys, as one Adjust step per burst (TL-MOVE-01)", () => {
    vi.useFakeTimers();
    try {
      drag([4.5, 20.5], [44.5, 20.5]);
      const before = doc.history.entries.length;
      expect(runtime.nudge?.(0, 1, 1)).toBe(true);
      runtime.nudge?.(0, 1, 10);
      expect(lineCurveHandles.state.start).toEqual({ x: 4.5, y: 31.5 });
      expect(lineCurveHandles.state.end).toEqual({ x: 44.5, y: 31.5 });
      expect(pixel(25, 31)).toEqual(GREEN);
      expect(pixel(25, 20)).toEqual(WHITE);
      expect(doc.history.entries.length).toBe(before);
      vi.advanceTimersByTime(NUDGE_MERGE_MS);
      expect(doc.history.entries.length).toBe(before + 1);
      expect(doc.history.undoName).toBe("history.adjustLineCurve");
      // With the handles hidden (a Ctrl tap), the arrows leave the line alone.
      runtime.tapCtrl?.();
      expect(runtime.nudge?.(1, 0, 1)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drags a control point with the right button as a Bezier", () => {
    drag([5.5, 20.5], [35.5, 20.5]);
    drag([15.5, 20.5], [15.5, 10.5], 2);
    expect(lineCurveHandles.state.curve).toBe("Bezier");
  });

  it("keeps a Bezier a Bezier when a control point is dragged with the left button (owner report)", () => {
    settings.values["tools.shapes.curveType"] = "Bezier";
    drag([5.5, 20.5], [35.5, 20.5]);
    drag([15.5, 20.5], [15.5, 10.5]);
    expect(lineCurveHandles.state.curve).toBe("Bezier");
    drag([25.5, 20.5], [25.5, 30.5]);
    expect(lineCurveHandles.state.curve).toBe("Bezier");
  });

  it("keeps the Curve option's Bezier chosen on a pending line through a left-button drag", () => {
    drag([5.5, 20.5], [35.5, 20.5]);
    settings.set("tools.shapes.curveType", "Bezier");
    drag([15.5, 20.5], [15.5, 10.5]);
    expect(lineCurveHandles.state.curve).toBe("Bezier");
  });

  it("finishes the line with Finish Line / Curve on commit", () => {
    drag([5.5, 10.5], [25.5, 10.5]);
    runtime.commit?.();
    expect(doc.history.undoName).toBe("history.finishLineCurve");
    expect(runtime.hasPending?.()).toBe(false);
    expect(pixel(15, 10)).toEqual(GREEN);
  });

  it("cancels a drawing in progress without recording anything", () => {
    const before = doc.history.entries.length;
    runtime.pointer(event("down", 5.5, 10.5));
    runtime.pointer(event("move", 25.5, 10.5));
    runtime.cancel?.();
    expect(doc.history.entries.length).toBe(before);
    expect(pixel(15, 10)).toEqual(WHITE);
  });

  it("finishes the pending line before a new one is drawn elsewhere", () => {
    drag([5.5, 5.5], [25.5, 5.5]);
    drag([5.5, 30.5], [25.5, 30.5]);
    expect(names().slice(-2)).toEqual(["history.finishLineCurve", "history.drawLineCurve"]);
  });

  it("recomputes the pending line when the width changes, as one step", async () => {
    drag([5.5, 10.5], [25.5, 10.5]);
    expect(pixel(15, 8)).toEqual(WHITE);
    settings.set("tools.brush.size", 6);
    settleEditBursts();
    expect(doc.history.undoName).toBe("history.changeBrushSize");
    expect(pixel(15, 8)).toEqual(GREEN);
    expect(await doc.history.undo()).toBe(true);
    expect(pixel(15, 8)).toEqual(WHITE);
  });

  it("changes the curve type as Change Curve Type", () => {
    drag([5.5, 10.5], [25.5, 10.5]);
    settings.set("tools.shapes.curveType", "Bezier");
    settleEditBursts();
    expect(doc.history.undoName).toBe("history.changeCurveType");
    expect(lineCurveHandles.state.curve).toBe("Bezier");
  });

  it("leaves gaps in a dashed line", () => {
    settings.set("tools.pen.dashStyle", "Dashes");
    drag([5.5, 10.5], [35.5, 10.5]);
    expect(pixel(10, 10)).toEqual(GREEN);
    expect(pixel(15, 10)).toEqual(WHITE);
    expect(pixel(20, 10)).toEqual(GREEN);
  });

  it("draws a filled arrowhead on the end cap", () => {
    settings.set("tools.pen.endCap", "ArrowFilled");
    drag([5.5, 20.5], [25.5, 20.5]);
    expect(pixel(20, 20)).toEqual(GREEN);
    expect(pixel(20, 15)).toEqual(WHITE);
  });

  it("antialiases the edge of a slanted line when antialiasing is on", () => {
    settings.set("tools.antialiasing", true);
    drag([5.5, 5.5], [33.5, 30.5]);
    const partial = [];
    for (let y = 5; y < 31; y++) {
      for (let x = 5; x < 34; x++) {
        const red = pixel(x, y).r;
        if (red > 0 && red < 255) partial.push(red);
      }
    }
    expect(partial.length).toBeGreaterThan(0);
  });

  it("hides the handles on a Ctrl tap and shows them again on the next tap", () => {
    drag([5.5, 10.5], [25.5, 10.5]);
    expect(lineCurveHandles.state.start).toBeDefined();
    runtime.tapCtrl?.();
    expect(lineCurveHandles.state).toEqual({});
    runtime.tapCtrl?.();
    expect(lineCurveHandles.state.start).toEqual({ x: 5.5, y: 10.5 });
  });

  it("does not grab a hidden handle, so a press there draws a new line", () => {
    drag([5.5, 10.5], [25.5, 10.5]);
    runtime.tapCtrl?.();
    drag([25.5, 10.5], [25.5, 30.5]);
    expect(names().slice(-2)).toEqual(["history.finishLineCurve", "history.drawLineCurve"]);
  });

  it("ends the pending line when an undo moves the history", async () => {
    drag([5.5, 10.5], [25.5, 10.5]);
    expect(await doc.history.undo()).toBe(true);
    expect(runtime.hasPending?.()).toBe(false);
  });

  it("clips the line to the selection", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 12, 40))], "replace");
    drag([5.5, 10.5], [30.5, 10.5]);
    expect(pixel(8, 10)).toEqual(GREEN);
    expect(pixel(20, 10)).toEqual(WHITE);
  });

  it("asks to finish the curve once a control point has been dragged", () => {
    drag([5.5, 10.5], [25.5, 10.5]);
    drag([15.5, 10.5], [15.5, 20.5]);
    expect(status.mock.lastCall?.[0]).toBe("tool.status.lineCurve");
  });

  it("reports the prompts and the measurements in the status line", () => {
    settings.set("tools.shapes.curveType", "Straight");
    runtime.pointer(event("down", 5.5, 10.5));
    runtime.pointer(event("move", 25.5, 10.5));
    expect(status.mock.lastCall?.[0]).toContain("tool.status.lineMeasure");
    runtime.pointer(event("up", 25.5, 10.5));
    expect(status.mock.lastCall?.[0]).toBe("tool.status.lineDragHandles");
    drag([25.5, 10.5], [25.5, 30.5]);
    expect(status.mock.lastCall?.[0]).toContain("tool.status.lineFinish");
  });

  describe("undo back into editing (owner request)", () => {
    /** Draws a line, bends it, widens it and finishes it. */
    function drawAndFinish(): void {
      drag([5.5, 10.5], [25.5, 10.5]);
      drag([15.5, 10.5], [15.5, 20.5]);
      settings.set("tools.brush.size", 4);
      settleEditBursts();
      runtime.commit?.();
    }

    it("makes a finished line pending again with its handles and options, and redo finishes it", async () => {
      drawAndFinish();
      expect(runtime.hasPending?.()).toBe(false);
      expect(lineCurveHandles.state).toEqual({});
      const entries = doc.history.entries.length;
      settings.set("tools.brush.size", 1);
      settings.set("tools.shapes.curveType", "Straight");

      await doc.history.undo();
      expect(runtime.hasPending?.()).toBe(true);
      expect(lineCurveHandles.state.start).toEqual({ x: 5.5, y: 10.5 });
      expect(lineCurveHandles.state.end).toEqual({ x: 25.5, y: 10.5 });
      expect(lineCurveHandles.state.curve).toBe("Spline");
      expect(lineCurveHandles.state.controls).toBeDefined();
      expect(settings.get("tools.brush.size")).toBe(4);
      expect(settings.get("tools.shapes.curveType")).toBe("Spline");
      expect(doc.history.undoName).toBe("history.changeBrushSize");
      expect(doc.history.entries.length).toBe(entries);

      // Left without an edit: redo finishes it again and the user's options come back.
      await doc.history.redo();
      expect(runtime.hasPending?.()).toBe(false);
      expect(lineCurveHandles.state).toEqual({});
      expect(settings.get("tools.brush.size")).toBe(1);
      expect(settings.get("tools.shapes.curveType")).toBe("Straight");
    });

    it("keeps editing after the undo: an endpoint drag records Adjust", async () => {
      drawAndFinish();
      await doc.history.undo();
      drag([25.5, 10.5], [32.5, 10.5]);
      expect(doc.history.undoName).toBe("history.adjustLineCurve");
      expect(doc.history.canRedo).toBe(false);
      expect(lineCurveHandles.state.end).toEqual({ x: 32.5, y: 10.5 });
      expect(pixel(31, 10)).toEqual(GREEN);
    });

    it("steps back through each pending step, and undoing the drawing ends it", async () => {
      drawAndFinish();
      await doc.history.undo(); // Finish
      await doc.history.undo(); // Change Brush Size
      expect(settings.get("tools.brush.size")).toBe(2);
      expect(runtime.hasPending?.()).toBe(true);
      await doc.history.undo(); // Edit (the bend)
      expect(runtime.hasPending?.()).toBe(true);
      expect(lineCurveHandles.state.start).toEqual({ x: 5.5, y: 10.5 });
      expect(pixel(15, 20)).toEqual(WHITE);
      await doc.history.undo(); // Draw
      expect(runtime.hasPending?.()).toBe(false);
      expect(lineCurveHandles.state).toEqual({});
      expect(pixel(10, 10)).toEqual(WHITE);
    });

    it("is taken up by a new runtime (after a tool switch) over the layer before it", async () => {
      drawAndFinish();
      runtime.deactivate();
      runtime = lineCurveToolRuntime(host);
      runtime.activate();
      bindToolHistory(doc, soloSwitcher("lineCurve", runtime));
      await doc.history.undo();
      expect(runtime.hasPending?.()).toBe(true);
      expect(lineCurveHandles.state.end).toEqual({ x: 25.5, y: 10.5 });
      drag([5.5, 10.5], [5.5, 30.5]);
      expect(doc.history.undoName).toBe("history.adjustLineCurve");
      // The old start's pixels are gone: the step drew over the layer before the line.
      expect(pixel(5, 10)).toEqual(WHITE);
      expect(pixel(5, 29)).toEqual(GREEN);
    });
  });
});
