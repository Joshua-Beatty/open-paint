// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, Selection } from "@openpaint/document";
import type { ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import type { SettingChange } from "@openpaint/storage";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import { COLOR_MERGE_MS, settleColorEdits } from "./color-edits";
import { finishOnLayerSwitch } from "./finish-on-switch";
import { NUDGE_MERGE_MS, settleNudges } from "./nudge-burst";
import type { PaintHost } from "./paint-tools";
import { shapeHandles } from "./shape-handles";
import { shapeToolRuntime } from "./shape-tools";
import { transformFrame } from "./transform-frame";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const GREEN = { r: 0, g: 255, b: 0, a: 255 };
const YELLOW = { r: 255, g: 255, b: 0, a: 255 };
/** The background of a blank document, which an undrawn pixel keeps. */
const PAPER = { r: 255, g: 255, b: 255, a: 255 };

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
      "tools.shapes.shape": { name: "rectangle" },
      "tools.shapes.drawType": "Outline",
      "tools.shapes.radius": 10,
      "tools.pen.dashStyle": "Solid",
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

describe("Shapes (TL-SHAPE-01)", () => {
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

  /** The box of an unturned shape, from its transform frame. */
  function frameBox() {
    const corners = transformFrame.state?.corners;
    const [topLeft, , bottomRight] = corners ?? [];
    if (topLeft === undefined || bottomRight === undefined) return undefined;
    return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
  }

  function setup(overrides: Record<string, unknown> = {}): void {
    for (const [path, value] of Object.entries(overrides)) settings.set(path, value);
  }

  beforeEach(() => {
    doc = Document.createBlank({ width: 60, height: 60 });
    settings = new FakeSettings();
    const host: PaintHost = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (id, values) => (values === undefined ? id : `${id}:${JSON.stringify(values)}`),
      notify,
      report,
      status,
    };
    runtime = shapeToolRuntime(host);
    runtime.activate();
    status.mockClear();
    notify.mockClear();
    report.mockClear();
  });

  afterEach(() => {
    runtime.deactivate();
    shapeHandles.set({});
  });

  it("draws an outline in the primary color and records one step named after the shape", () => {
    const before = doc.history.entries.length;
    drag([5, 5], [25, 15]);
    expect(pixel(5, 10)).toEqual(GREEN);
    expect(pixel(15, 10)).toEqual(PAPER);
    expect(doc.history.entries.length).toBe(before + 1);
    expect(doc.history.undoName).toContain("history.drawShape");
    expect(doc.history.undoName).toContain("shape.rectangle");
    expect(runtime.hasPending?.()).toBe(true);
  });

  it("draws nothing for a click that jitters within 4 CSS pixels, and moves no corner", () => {
    // At 100 % zoom: a canvas pixel is a CSS pixel.
    const at = (type: ToolPointerEvent["type"], x: number, y: number) => ({
      ...event(type, x, y),
      clientX: x,
      clientY: y,
    });
    const before = doc.history.entries.length;
    runtime.pointer(at("down", 5, 5));
    runtime.pointer(at("move", 7, 7));
    runtime.pointer(at("up", 7.5, 7.5));
    expect(doc.history.entries.length).toBe(before);
    expect(runtime.hasPending?.()).toBe(false);
    expect(pixel(5, 5)).toEqual(PAPER);

    drag([5, 5], [25, 15]);
    const drawn = doc.history.entries.length;
    runtime.pointer(at("down", 25, 15));
    runtime.pointer(at("up", 27, 17));
    expect(doc.history.entries.length).toBe(drawn);
  });

  it("fills the interior only in Filled mode, with the primary color", () => {
    setup({ "tools.shapes.drawType": "Interior" });
    drag([5, 5], [25, 15]);
    expect(pixel(15, 10)).toEqual(GREEN);
    expect(pixel(5, 10)).toEqual(GREEN);
    expect(pixel(24, 14)).toEqual(GREEN);
  });

  it("fills the interior with the secondary color and draws the outline in the primary one in Both mode", () => {
    setup({ "tools.shapes.drawType": "Both" });
    drag([5, 5], [25, 15]);
    expect(pixel(5, 10)).toEqual(GREEN);
    expect(pixel(15, 10)).toEqual(YELLOW);
  });

  it("uses the secondary color for a right-button shape, with the fill and outline swapped in Both mode", () => {
    drag([5, 5], [25, 15], 2);
    expect(pixel(5, 10)).toEqual(YELLOW);
    setup({ "tools.shapes.drawType": "Both" });
    runtime.commit?.();
    drag([30, 5], [50, 15], 2);
    expect(pixel(30, 10)).toEqual(YELLOW);
    expect(pixel(40, 10)).toEqual(GREEN);
  });

  it("gives the same pixels after a long drag as a direct one, and undo restores the layer (L2)", async () => {
    setup({
      "tools.shapes.drawType": "Both",
      "tools.brush.fillType": "Hatch",
      "tools.brush.size": 3,
      "tools.antialiasing": true,
    });
    doc.replaceSelection(new Selection([[2.5, 3.5, 50, 1, 57, 55.5, 9, 40]]), "select");
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    const all = () => [...layer.pixels.readRegion(layer.pixels.bounds).data];
    const before = all();
    drag([9, 7], [41, 37]);
    const direct = all();
    expect(direct).not.toEqual(before);
    runtime.commit?.();
    while (doc.history.undoName?.includes("shape.rectangle")) await doc.history.undo();
    expect(all()).toEqual(before);

    runtime.pointer(event("down", 9, 7));
    for (const [x, y] of [
      [55, 58],
      [12, 9],
      [30, 50],
      [41, 37],
    ] as const) {
      runtime.pointer(event("move", x, y));
    }
    runtime.pointer(event("up", 41, 37));
    expect(all()).toEqual(direct);
  });

  it("finishes a pending shape on its own layer when another layer becomes active (TL-FRAME-01)", () => {
    const bottom = doc.activeLayer;
    if (bottom === undefined) throw new Error("no active layer");
    const top = doc.addLayer();
    doc.setActiveLayer(bottom);
    const stop = finishOnLayerSwitch(doc, () => {
      if (runtime.hasPending?.()) runtime.commit?.();
    });
    drag([5, 5], [25, 15]);
    doc.setActiveLayer(top);
    expect(runtime.hasPending?.()).toBe(false);
    expect(doc.history.undoName).toContain("history.finishShape");
    expect(bottom.pixels.getPixel(5, 10)).toEqual(GREEN);
    expect(top.pixels.getPixel(5, 10).a).toBe(0);

    // A press on the old shape's corner draws a new shape on the new layer instead of adjusting it.
    drag([25, 15], [40, 30]);
    expect(top.pixels.getPixel(25, 20)).toEqual(GREEN);
    expect(bottom.pixels.getPixel(40, 20)).toEqual(PAPER);
    stop();
  });

  it("discards a shape with no area without recording anything", () => {
    const before = doc.history.entries.length;
    drag([10, 10], [10, 30]);
    expect(doc.history.entries.length).toBe(before);
    expect(runtime.hasPending?.()).toBe(false);
  });

  it("keeps the aspect ratio under Shift, and draws from the center under Alt", () => {
    drag([5, 5], [25, 15], 0, { shift: true });
    expect(frameBox()).toEqual({ left: 5, top: 5, right: 25, bottom: 25 });
    runtime.commit?.();
    drag([15, 15], [20, 20], 0, { alt: true });
    expect(frameBox()).toEqual({ left: 10, top: 10, right: 20, bottom: 20 });
  });

  it("adjusts a corner as one step named Adjust, and keeps the opposite corner fixed", () => {
    drag([5, 5], [25, 15]);
    runtime.pointer(event("down", 25, 15));
    runtime.pointer(event("move", 30, 20));
    runtime.pointer(event("up", 30, 20));
    expect(frameBox()).toEqual({ left: 5, top: 5, right: 30, bottom: 20 });
    expect(doc.history.undoName).toContain("history.adjustShape");
  });

  it("shows a crosshair, and the frame's cursors over a pending shape (TL-FRAME-06, TL-MOVE-01)", () => {
    const view = { canPan: false, panning: false };
    const cursorAt = (x: number, y: number) => {
      runtime.pointer(event("move", x, y));
      return runtime.cursor?.(view);
    };
    expect(cursorAt(5, 5)).toBe("crosshair");
    drag([5, 5], [45, 35]);
    expect(cursorAt(45, 35)).toBe("nwse-resize");
    expect(cursorAt(25, 5)).toBe("ns-resize");
    expect(cursorAt(12, 12)).toBe("move");
    expect(cursorAt(25, 20)).toBe("grab");
    expect(cursorAt(52, 12)).toContain("data:image/svg+xml");
    expect(cursorAt(70, 20)).toBe("crosshair");
    runtime.pointer(event("down", 45, 35));
    expect(cursorAt(50, 40)).toBe("nwse-resize");
    runtime.pointer(event("up", 50, 40));
    runtime.pointer(event("down", 12, 12));
    expect(cursorAt(14, 14)).toBe("move");
    runtime.pointer(event("up", 14, 14));
    expect(runtime.cursor?.({ ...view, panning: true })).toBeUndefined();
  });

  describe("moving and rotating a pending shape (TL-SHAPE-01, TL-MOVE-01)", () => {
    function layerPixels(): number[] {
      const layer = doc.activeLayer;
      if (layer === undefined) throw new Error("no active layer");
      return [...layer.pixels.readRegion(layer.pixels.bounds).data];
    }

    it("moves the shape by a whole-pixel drag on its body, as one Adjust step", () => {
      drag([5, 5], [45, 35]);
      const before = doc.history.entries.length;
      drag([12, 12], [20.4, 16.6]);
      expect(frameBox()).toEqual({ left: 13, top: 10, right: 53, bottom: 40 });
      expect(pixel(5, 20)).toEqual(PAPER);
      expect(pixel(13, 20)).toEqual(GREEN);
      expect(doc.history.entries.length).toBe(before + 1);
      expect(doc.history.undoName).toContain("history.adjustShape");
      expect(runtime.hasPending?.()).toBe(true);
    });

    it("moves from anywhere inside the frame, even outside the shape, and rotates from outside it", () => {
      // A circle of radius 50 about (55, 55); the image only shows part of it.
      setup({ "tools.shapes.shape": { name: "ellipse" } });
      drag([5, 5], [105, 105]);
      const view = { canPan: false, panning: false };
      const cursorAt = (x: number, y: number) => {
        runtime.pointer(event("move", x, y));
        return runtime.cursor?.(view);
      };
      // Inside the frame but outside the circle, clear of the corner handle: it moves, as inside a
      // selection (owner request).
      expect(cursorAt(12, 12)).toBe("move");
      expect(cursorAt(40, 55)).toBe("move");
      // Just outside the frame: it rotates.
      expect(cursorAt(1, 35.4)).toContain("data:image/svg+xml");
      // A press inside the frame's empty corner moves the shape.
      drag([12, 12], [20, 15]);
      expect(frameBox()).toEqual({ left: 13, top: 8, right: 113, bottom: 108 });
      expect(doc.history.undoName).toContain("history.adjustShape");
    });

    it("nudges by 1 px per arrow and 10 px with Ctrl, as one Adjust step per burst (TL-MOVE-01)", () => {
      vi.useFakeTimers();
      try {
        drag([5, 5], [25, 15]);
        const before = doc.history.entries.length;
        expect(runtime.nudge?.(1, 0, 1)).toBe(true);
        runtime.nudge?.(1, 0, 1);
        runtime.nudge?.(0, 1, 10);
        expect(frameBox()).toEqual({ left: 7, top: 15, right: 27, bottom: 25 });
        expect(pixel(7, 20)).toEqual(GREEN);
        expect(pixel(5, 10)).toEqual(PAPER);
        expect(doc.history.entries.length).toBe(before);
        vi.advanceTimersByTime(NUDGE_MERGE_MS - 1);
        runtime.nudge?.(-1, 0, 1);
        vi.advanceTimersByTime(NUDGE_MERGE_MS);
        expect(doc.history.entries.length).toBe(before + 1);
        expect(doc.history.undoName).toContain("history.adjustShape");
        expect(frameBox()).toEqual({ left: 6, top: 15, right: 26, bottom: 25 });
        // A nudge burst still merging is recorded before Finish, and before an undo.
        runtime.nudge?.(0, -1, 1);
        runtime.commit?.();
        expect(
          names()
            .slice(-2)
            .map((name) => name.split(":")[0]),
        ).toEqual(["history.adjustShape", "history.finishShape"]);
        expect(runtime.nudge?.(1, 0, 1)).toBe(false);
        drag([40, 40], [50, 50]);
        runtime.nudge?.(1, 0, 1);
        settleNudges();
        expect(doc.history.undoName).toContain("history.adjustShape");
      } finally {
        vi.useRealTimers();
      }
    });

    it("moves from a wide outline where it pokes out of the frame", () => {
      // A 10 px pen pokes 5 px out of the frame; up to 4 CSS px beyond that still picks it up.
      setup({ "tools.brush.size": 10 });
      drag([10, 10], [40, 40]);
      const view = { canPan: false, panning: false };
      runtime.pointer(event("move", 2, 25));
      expect(runtime.cursor?.(view)).toBe("move");
      runtime.pointer(event("move", -3, 25));
      expect(runtime.cursor?.(view)).toContain("data:image/svg+xml");
    });
    it("rotates from outside the shape, redrawn from its turned path with the same pixels as a drawn one", () => {
      // A 40 x 30 rectangle turned 90 degrees about its centre (25, 20) lies on (10, 0)-(40, 40).
      drag([5, 5], [45, 35]);
      const press = { x: 52, y: 12 };
      // The same distance from the centre, a quarter turn clockwise.
      const end = { x: 25 - (press.y - 20), y: 20 + (press.x - 25) };
      drag([press.x, press.y], [end.x, end.y], 0, { shift: true });
      expect(doc.history.undoName).toContain("history.adjustShape");
      expect(status.mock.lastCall?.[0]).toContain('"angle":90');
      // The top-left corner turns to the top right.
      const corners = transformFrame.state?.corners ?? [];
      expect(corners[0]?.x).toBeCloseTo(40, 9);
      expect(corners[0]?.y).toBeCloseTo(0, 9);
      expect(pixel(5, 20)).toEqual(PAPER);
      expect(pixel(10, 20)).toEqual(GREEN);
      const turned = layerPixels();
      runtime.commit?.();

      const fresh = Document.createBlank({ width: 60, height: 60 });
      const turnedDoc = doc;
      doc = fresh;
      drag([10, 0], [40, 40]);
      expect(layerPixels()).toEqual(turned);
      doc = turnedDoc;
    });

    it("snaps the shape's angle to 15 degree steps under Shift", () => {
      drag([5, 5], [45, 35]);
      // About 37 degrees from the press around the centre.
      drag([52, 20], [45, 35]);
      const free = /"angle":(\d+)/.exec(status.mock.lastCall?.[0] ?? "")?.[1];
      expect(Number(free) % 15).not.toBe(0);
      drag([52, 30], [40, 45], 0, { shift: true });
      const snapped = /"angle":(\d+)/.exec(status.mock.lastCall?.[0] ?? "")?.[1];
      expect(Number(snapped) % 15).toBe(0);
    });

    it("moves the rotation anchor as its own step, and the reset button puts it back", () => {
      drag([5, 5], [45, 35]);
      drag([25, 20], [10, 10]);
      expect(doc.history.undoName).toContain("history.moveRotationAnchor");
      expect(transformFrame.state?.anchor).toEqual({ x: 10, y: 10 });
      // The reset button sits 14 CSS px right of and below the anchor.
      runtime.pointer(event("down", 24, 24));
      runtime.pointer(event("up", 24, 24));
      expect(transformFrame.state?.anchor).toEqual({ x: 25, y: 20 });
    });

    it("resizes a turned shape along its own axes", () => {
      drag([5, 5], [45, 35]);
      drag([52, 12], [25 + 8, 20 + 27], 0, { shift: true });
      const corners = transformFrame.state?.corners ?? [];
      // The east handle of the turned frame now points down, at (25, 40).
      const east = transformFrame.state?.handles.e;
      expect(east?.x).toBeCloseTo(25, 9);
      expect(east?.y).toBeCloseTo(40, 9);
      drag([25, 40], [25, 46]);
      const after = transformFrame.state?.corners ?? [];
      const width = (points: typeof corners) =>
        Math.hypot(
          (points[1]?.x ?? 0) - (points[0]?.x ?? 0),
          (points[1]?.y ?? 0) - (points[0]?.y ?? 0),
        );
      const height = (points: typeof corners) =>
        Math.hypot(
          (points[3]?.x ?? 0) - (points[0]?.x ?? 0),
          (points[3]?.y ?? 0) - (points[0]?.y ?? 0),
        );
      expect(width(after)).toBeCloseTo(width(corners) + 6, 9);
      expect(height(after)).toBeCloseTo(height(corners), 9);
    });
  });

  it("drags the corner size handle as an Edit step, and stores the new size", () => {
    setup({
      "tools.shapes.shape": { name: "roundedRectangle" },
      "tools.shapes.drawType": "Interior",
    });
    drag([5, 5], [45, 25]);
    expect(pixel(5, 5)).toEqual(PAPER);
    runtime.pointer(event("down", 15, 5));
    runtime.pointer(event("move", 25, 5));
    runtime.pointer(event("up", 25, 5));
    expect(settings.get("tools.shapes.radius")).toBe(20);
    expect(doc.history.undoName).toContain("history.editShape");
    expect(pixel(5, 5)).toEqual(PAPER);
    expect(pixel(25, 15)).toEqual(GREEN);
  });

  it("does not record the stored radius as a second option change", () => {
    setup({ "tools.shapes.shape": { name: "roundedRectangle" } });
    drag([5, 5], [45, 25]);
    const before = doc.history.entries.length;
    runtime.pointer(event("down", 15, 5));
    runtime.pointer(event("move", 25, 5));
    runtime.pointer(event("up", 25, 5));
    expect(doc.history.entries.length).toBe(before + 1);
  });

  it("drags the callout tail as an Edit step", () => {
    setup({ "tools.shapes.shape": { name: "callout" } });
    drag([5, 5], [45, 35]);
    const tail = shapeHandles.state.tail;
    expect(tail).toEqual({ x: 5 + 0.25 * 40, y: 5 + 1.25 * 30 });
    runtime.pointer(event("down", tail?.x ?? 0, tail?.y ?? 0));
    runtime.pointer(event("move", 20, 60));
    runtime.pointer(event("up", 20, 60));
    expect(shapeHandles.state.tail?.x).toBeCloseTo(20, 9);
    expect(shapeHandles.state.tail?.y).toBeCloseTo(60, 9);
    expect(doc.history.undoName).toContain("history.editShape");
  });

  it("records a changed draw mode as one step and recomputes the shape", () => {
    drag([5, 5], [25, 15]);
    expect(pixel(15, 10)).toEqual(PAPER);
    settings.set("tools.shapes.drawType", "Interior");
    expect(doc.history.undoName).toContain("history.changeDrawMode");
    expect(pixel(15, 10)).toEqual(GREEN);
  });

  describe("color changes while pending (TL-FRAME-01, TL-FRAME-02)", () => {
    const RED = { r: 255, g: 0, b: 0, a: 255 };
    const BLUE = { r: 0, g: 0, b: 255, a: 255 };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("redraws the pending outline in the new primary color and records one Change Color step", () => {
      vi.useFakeTimers();
      drag([5, 5], [25, 15]);
      const before = doc.history.entries.length;
      settings.set("tools.primaryColor", RED);
      expect(pixel(5, 10)).toEqual(RED);
      settings.set("tools.primaryColor", BLUE);
      expect(pixel(5, 10)).toEqual(BLUE);
      expect(doc.history.entries.length).toBe(before);
      vi.advanceTimersByTime(COLOR_MERGE_MS);
      expect(doc.history.entries.length).toBe(before + 1);
      expect(doc.history.undoName).toContain("history.changeColor");
      expect(runtime.hasPending?.()).toBe(true);
      runtime.commit?.();
      expect(pixel(5, 10)).toEqual(BLUE);
      expect(doc.history.entries.length).toBe(before + 2);
    });

    it("follows the secondary color for a right-button shape, and both colors in Both mode", () => {
      setup({ "tools.shapes.drawType": "Both" });
      drag([5, 5], [25, 15], 2);
      expect(pixel(5, 10)).toEqual(YELLOW);
      expect(pixel(15, 10)).toEqual(GREEN);
      settings.set("tools.secondaryColor", RED);
      settings.set("tools.primaryColor", BLUE);
      expect(pixel(5, 10)).toEqual(RED);
      expect(pixel(15, 10)).toEqual(BLUE);
    });

    it("records the waiting change before a commit, a new drawing or an undo", async () => {
      drag([5, 5], [25, 15]);
      settings.set("tools.primaryColor", RED);
      runtime.commit?.();
      expect(names().slice(-2)).toEqual([
        expect.stringContaining("history.changeColor"),
        expect.stringContaining("history.finishShape"),
      ]);

      drag([30, 30], [50, 50]);
      settings.set("tools.primaryColor", BLUE);
      settleColorEdits();
      expect(doc.history.undoName).toContain("history.changeColor");
      await doc.history.undo();
      expect(pixel(30, 40)).toEqual(RED);
    });

    it("ignores a color change with no shape pending", () => {
      const before = doc.history.entries.length;
      settings.set("tools.primaryColor", RED);
      settleColorEdits();
      expect(doc.history.entries.length).toBe(before);
    });
  });

  it("records a shape-type change while pending as one step", () => {
    drag([5, 5], [25, 15]);
    settings.set("tools.shapes.shape", { name: "ellipse" });
    expect(doc.history.undoName).toContain("history.changeToShape");
    expect(doc.history.undoName).toContain("shape.ellipse");
    expect(pixel(15, 10)).toEqual(PAPER);
    expect(pixel(5, 10)).toEqual(GREEN);
  });

  it("commits the pending shape with Finish, and it stays in the history", () => {
    drag([5, 5], [25, 15]);
    runtime.commit?.();
    expect(runtime.hasPending?.()).toBe(false);
    expect(doc.history.undoName).toContain("history.finishShape");
    expect(shapeHandles.state).toEqual({});
  });

  it("commits the pending shape when a new one is drawn elsewhere", () => {
    drag([5, 5], [25, 15]);
    // Farther than the rotate band around the frame (16 CSS px).
    drag([45, 35], [55, 55]);
    expect(
      names()
        .slice(-2)
        .map((name) => name.split(":")[0]),
    ).toEqual(["history.finishShape", "history.drawShape"]);
  });

  it("ends the pending shape when undo takes its step", async () => {
    drag([5, 5], [25, 15]);
    await doc.history.undo();
    expect(runtime.hasPending?.()).toBe(false);
  });

  describe("undo back into editing (owner request)", () => {
    const RED = { r: 255, g: 0, b: 0, a: 255 };

    /** Draws, changes the width, drags a corner, recolours and finishes a rectangle. */
    function drawAndFinish(): void {
      drag([5, 5], [25, 15]);
      settings.set("tools.brush.size", 4);
      drag([25, 15], [35, 25]);
      settings.set("tools.primaryColor", RED);
      settleColorEdits();
      runtime.commit?.();
    }

    it("makes a finished shape pending again with its handles and options, and redo finishes it", async () => {
      drawAndFinish();
      expect(runtime.hasPending?.()).toBe(false);
      expect(transformFrame.state).toBeUndefined();
      const finished = [
        ...(doc.activeLayer?.pixels.readRegion(doc.activeLayer.pixels.bounds).data ?? []),
      ];
      const entries = doc.history.entries.length;
      settings.set("tools.brush.size", 9);
      settings.set("tools.shapes.drawType", "Interior");

      await doc.history.undo();
      expect(runtime.hasPending?.()).toBe(true);
      expect(frameBox()).toEqual({ left: 5, top: 5, right: 35, bottom: 25 });
      expect(settings.get("tools.brush.size")).toBe(4);
      expect(settings.get("tools.shapes.drawType")).toBe("Outline");
      expect(doc.history.undoName).toContain("history.changeColor");
      expect(doc.history.entries.length).toBe(entries);
      expect(status.mock.lastCall?.[0]).toContain("tool.status.shapeFinish");

      await doc.history.redo();
      expect(runtime.hasPending?.()).toBe(false);
      expect(transformFrame.state).toBeUndefined();
      expect([
        ...(doc.activeLayer?.pixels.readRegion(doc.activeLayer.pixels.bounds).data ?? []),
      ]).toEqual(finished);
    });

    it("keeps editing after the undo: a corner drag records Adjust and redraws in the step's colour", async () => {
      drawAndFinish();
      await doc.history.undo();
      drag([5, 5], [2, 2]);
      expect(doc.history.undoName).toContain("history.adjustShape");
      expect(doc.history.canRedo).toBe(false);
      expect(frameBox()).toEqual({ left: 2, top: 2, right: 35, bottom: 25 });
      expect(pixel(2, 10)).toEqual(RED);
      // The old edge's pixels are gone: the step drew over the layer before the shape.
      expect(pixel(5, 10)).toEqual(PAPER);
      runtime.commit?.();
      expect(doc.history.undoName).toContain("history.finishShape");
      expect(runtime.hasPending?.()).toBe(false);
    });

    it("steps back through each pending step with that step's state, and undoing the drawing ends it", async () => {
      drawAndFinish();
      await doc.history.undo(); // Finish
      await doc.history.undo(); // Change Color
      expect(runtime.hasPending?.()).toBe(true);
      expect(pixel(5, 10)).toEqual(GREEN);
      settings.set("tools.primaryColor", GREEN);
      await doc.history.undo(); // Adjust
      expect(frameBox()).toEqual({ left: 5, top: 5, right: 25, bottom: 15 });
      await doc.history.undo(); // Change Brush Size
      expect(settings.get("tools.brush.size")).toBe(2);
      expect(runtime.hasPending?.()).toBe(true);
      await doc.history.undo(); // Draw
      expect(runtime.hasPending?.()).toBe(false);
      expect(transformFrame.state).toBeUndefined();
      expect(pixel(5, 10)).toEqual(PAPER);
      await doc.history.redo();
      expect(runtime.hasPending?.()).toBe(true);
      expect(frameBox()).toEqual({ left: 5, top: 5, right: 25, bottom: 15 });
    });

    it("comes back pending when the tool is active again after a switch", async () => {
      drawAndFinish();
      runtime.deactivate();
      await doc.history.undo();
      expect(transformFrame.state).toBeUndefined();
      runtime.activate();
      expect(runtime.hasPending?.()).toBe(true);
      expect(frameBox()).toEqual({ left: 5, top: 5, right: 35, bottom: 25 });
    });

    it("undoes as plain pixels when its layer is no longer active", async () => {
      const bottom = doc.activeLayer;
      if (bottom === undefined) throw new Error("no active layer");
      const top = doc.addLayer();
      doc.setActiveLayer(bottom);
      drawAndFinish();
      doc.setActiveLayer(top);
      await doc.history.undo();
      expect(runtime.hasPending?.()).toBe(false);
      expect(transformFrame.state).toBeUndefined();
      expect(bottom.pixels.getPixel(5, 10)).toEqual(RED);
    });

    it("undoes as plain pixels when its layer's pixels were replaced", async () => {
      drawAndFinish();
      expect(doc.resize({ width: 30, height: 30 }, { filter: "nearest", linearLight: false })).toBe(
        true,
      );
      await doc.history.undo();
      await doc.history.undo();
      expect(runtime.hasPending?.()).toBe(false);
      expect(report).not.toHaveBeenCalled();
    });
  });

  it("restores the layer when a drawing is cancelled, and records nothing", () => {
    const before = doc.history.entries.length;
    runtime.pointer(event("down", 5, 5));
    runtime.pointer(event("move", 25, 15));
    runtime.cancel?.();
    expect(pixel(5, 10)).toEqual(PAPER);
    expect(doc.history.entries.length).toBe(before);
  });

  it("shows the size and the finish prompt while a shape is pending", () => {
    drag([5, 5], [25, 15]);
    expect(status.mock.lastCall?.[0]).toContain("tool.status.shapeMeasure");
    expect(status.mock.lastCall?.[0]).toContain('"w":20,"h":10');
    expect(status.mock.lastCall?.[0]).toContain("tool.status.shapeFinish");
  });

  it("shows the help text when no shape is pending", () => {
    runtime.commit?.();
    expect(status.mock.lastCall?.[0]).toBe("tool.help.shapes");
  });

  it("sets the handles of a pending shape and clears them when it ends", () => {
    setup({ "tools.shapes.shape": { name: "roundedRectangle" } });
    drag([5, 5], [25, 15]);
    expect(frameBox()).toEqual({ left: 5, top: 5, right: 25, bottom: 15 });
    expect(shapeHandles.state.radius).toEqual({ x: 10, y: 5 });
    // Only the frame's handles show, not its outline, which would hide the shape's stroke.
    expect(transformFrame.state?.outline).toBe(false);
    runtime.commit?.();
    expect(shapeHandles.state).toEqual({});
  });
});
