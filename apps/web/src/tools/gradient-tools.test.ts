// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, rect, rectPolygon, Selection, Surface } from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import { gradientCpu } from "@openpaint/engine";
import type { ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import type { SettingChange } from "@openpaint/storage";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import { settleColorEdits } from "./color-edits";
import { gradientHandles } from "./gradient-handles";
import {
  type GradientLanes,
  type GradientTileJob,
  type GradientTileReply,
  InlineGradientLanes,
} from "./gradient-tiles";
import { constrainEnd, gradientMeasure, gradientToolRuntime } from "./gradient-tools";
import type { PaintHost } from "./paint-tools";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };
const GREEN = { r: 0, g: 255, b: 0, a: 255 };
const YELLOW = { r: 255, g: 255, b: 0, a: 255 };

/** A settings fake that reports its own changes to the listeners, as the store does. */
class FakeSettings {
  readonly values: Record<string, unknown>;
  readonly #listeners = new Set<(change: SettingChange) => void>();

  constructor() {
    this.values = {
      "tools.primaryColor": GREEN,
      "tools.secondaryColor": YELLOW,
      "tools.gradient.type": "LinearClamped",
      "tools.gradient.repeatType": "NoRepeat",
      "tools.gradient.alphaOnly": false,
      "tools.antialiasing": false,
      "tools.blendMode": "normal",
      "tools.selection.renderingQuality": "Antialiased",
    };
  }

  get = (path: string): unknown => this.values[path];

  set(path: string, value: unknown): void {
    this.values[path] = value;
    this.emit({ path, value: value as SettingChange["value"], source: "local" });
  }

  emit(change: SettingChange): void {
    for (const listener of this.#listeners) listener(change);
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
  modifiers: { readonly shift?: boolean } = {},
): ToolPointerEvent {
  return {
    type,
    x,
    y,
    button,
    pressure: 1,
    shiftKey: modifiers.shift === true,
    altKey: false,
    ctrlKey: false,
    // At 10 CSS pixels per canvas pixel, even a one-pixel drag leaves the click dead zone.
    clientX: x * 10,
    clientY: y * 10,
  };
}

describe("constrainEnd (TL-GRAD-01 Shift)", () => {
  it("keeps the end point without Shift", () => {
    expect(constrainEnd({ x: 0, y: 0 }, { x: 10, y: 1 }, false)).toEqual({ x: 10, y: 1 });
  });

  it("snaps the angle to 15 degree steps and keeps the length", () => {
    const end = constrainEnd({ x: 0, y: 0 }, { x: 10, y: 1 }, true);
    expect(end.y).toBeCloseTo(0, 9);
    expect(end.x).toBeCloseTo(Math.hypot(10, 1), 9);
    const diagonal = constrainEnd({ x: 0, y: 0 }, { x: 10, y: 9 }, true);
    expect(Math.atan2(diagonal.y, diagonal.x)).toBeCloseTo(Math.PI / 4, 9);
  });
});

describe("gradientMeasure (TL-GRAD-01 status)", () => {
  it("reports the offset, the diagonal and the angle in whole units", () => {
    expect(gradientMeasure({ x: 0, y: 0 }, { x: 3, y: 4 })).toEqual({
      dx: 3,
      dy: 4,
      length: 5,
      angle: 53,
    });
    expect(gradientMeasure({ x: 10, y: 10 }, { x: 0, y: 10 })).toEqual({
      dx: -10,
      dy: 0,
      length: 10,
      angle: 180,
    });
  });
});

describe("Gradient tool (TL-GRAD-01, TL-FRAME-01, TL-FRAME-02)", () => {
  let doc: Document;
  let settings: FakeSettings;
  let runtime: ToolRuntime;
  let status: ReturnType<typeof vi.fn<(text: string) => void>>;
  const notify = vi.fn();
  const report = vi.fn();

  function paint(x: number, y: number, width: number, height: number, color: typeof RED): void {
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    const surface = new Surface(width, height);
    surface.fill(color);
    doc.editLayerPixels("paint", layer, rect(x, y, width, height), (pixels) => {
      pixels.writeRegion(surface, x, y);
    });
  }

  function pixel(x: number, y: number) {
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    return layer.pixels.getPixel(x, y);
  }

  /** Draws a gradient from (x0, y0) to (x1, y1) with the given button. */
  function drag(x0: number, y0: number, x1: number, y1: number, button = 0, shift = false): void {
    const modifiers = { shift };
    runtime.pointer(event("down", x0, y0, button, modifiers));
    runtime.pointer(event("move", x1, y1, button, modifiers));
    runtime.pointer(event("up", x1, y1, button, modifiers));
  }

  beforeEach(() => {
    doc = Document.createBlank({ width: 32, height: 32 });
    paint(0, 0, 16, 32, RED);
    paint(16, 0, 16, 32, BLUE);
    settings = new FakeSettings();
    status = vi.fn();
    const host: PaintHost = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (messageId, values) =>
        values === undefined ? messageId : `${messageId} ${JSON.stringify(values)}`,
      notify,
      report,
      status,
    };
    runtime = gradientToolRuntime(host);
    runtime.activate();
    notify.mockClear();
    report.mockClear();
  });

  afterEach(() => {
    runtime.deactivate();
  });

  it("draws the gradient on drag, and Finish keeps it", () => {
    drag(2, 16, 30, 16);
    expect(pixel(0, 16)).toEqual(GREEN);
    expect(pixel(31, 16)).toEqual(YELLOW);
    expect(doc.history.undoName).toBe("history.gradient");
    expect(runtime.hasPending?.()).toBe(true);

    runtime.commit?.();
    expect(runtime.hasPending?.()).toBe(false);
    expect(doc.history.undoName).toBe("history.finishGradient");
    expect(pixel(0, 16)).toEqual(GREEN);
  });

  it("re-renders the pending gradient in new colors as one Change Color step (TL-FRAME-01)", async () => {
    drag(2, 16, 30, 16);
    const before = doc.history.entries.length;
    settings.set("tools.primaryColor", RED);
    settings.set("tools.secondaryColor", BLUE);
    await vi.waitFor(() => expect(pixel(31, 16)).toEqual(BLUE));
    expect(pixel(0, 16)).toEqual(RED);
    expect(doc.history.entries.length).toBe(before);
    settleColorEdits();
    await vi.waitFor(() => expect(doc.history.undoName).toBe("history.changeColor"));
    expect(doc.history.entries.length).toBe(before + 1);
    expect(runtime.hasPending?.()).toBe(true);
    runtime.commit?.();
    await vi.waitFor(() => expect(doc.history.undoName).toBe("history.finishGradient"));
    expect(pixel(0, 16)).toEqual(RED);
  });

  it("with a selection, gives the whole-layer clip's pixels and undoes them (L2)", async () => {
    settings.set("tools.antialiasing", true);
    doc.replaceSelection(new Selection([[3.5, 4.25, 27.5, 6, 20, 29.75]]), "select");
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    const before = layer.pixels.readRegion(layer.pixels.bounds);
    const filled = gradientCpu(before, {
      shape: "LinearClamped",
      repeat: "NoRepeat",
      start: { x: 2, y: 3 },
      end: { x: 29, y: 25 },
      startColor: GREEN,
      endColor: YELLOW,
      alphaOnly: false,
      antialias: true,
      blend: 0,
      seed: 0x4f50_454e,
    });
    const expected = clipToCoverage(before, filled, doc.selection.mask(before.bounds));

    runtime.pointer(event("down", 2, 3));
    runtime.pointer(event("move", 10, 30));
    runtime.pointer(event("move", 29, 25));
    runtime.pointer(event("up", 29, 25));
    expect([...layer.pixels.readRegion(layer.pixels.bounds).data]).toEqual([...expected.data]);

    settings.set("tools.selection.renderingQuality", "Aliased");
    const aliased = clipToCoverage(
      before,
      filled,
      doc.selection.mask(before.bounds).map((value) => (value >= 128 ? 255 : 0)),
    );
    expect([...layer.pixels.readRegion(layer.pixels.bounds).data]).toEqual([...aliased.data]);
    await doc.history.undo();
    await doc.history.undo();
    expect([...layer.pixels.readRegion(layer.pixels.bounds).data]).toEqual([...before.data]);
  });

  it("the right button reverses the colors", () => {
    drag(2, 16, 30, 16, 2);
    expect(pixel(0, 16)).toEqual(YELLOW);
    expect(pixel(31, 16)).toEqual(GREEN);
  });

  it("shows a crosshair, a hand on the nubs and the move arrows on the move handle (TL-FRAME-06)", () => {
    const view = { canPan: false, panning: false };
    runtime.pointer(event("move", 16, 16));
    expect(runtime.cursor?.(view)).toBe("crosshair");
    drag(2, 16, 30, 16);
    runtime.pointer(event("move", 3, 17));
    expect(runtime.cursor?.(view)).toBe("grab");
    runtime.pointer(event("move", 16, 16));
    expect(runtime.cursor?.(view)).toBe("move");
    runtime.pointer(event("move", 16, 26));
    expect(runtime.cursor?.(view)).toBe("crosshair");
    runtime.pointer(event("down", 30, 16));
    expect(runtime.cursor?.(view)).toBe("grabbing");
    runtime.pointer(event("up", 30, 16));
    expect(runtime.cursor?.({ ...view, panning: true })).toBeUndefined();
  });

  it("hit-tests the nubs in CSS pixels, so they are as easy to grab at any zoom", () => {
    const view = { canPan: false, panning: false };
    drag(2, 16, 30, 16);
    // 4 canvas pixels from the end nub: 16 CSS px at 400 % misses, 1 CSS px at 25 % hits.
    runtime.pointer({ ...event("move", 30, 20), viewScale: 4 });
    expect(runtime.cursor?.(view)).toBe("crosshair");
    runtime.pointer({ ...event("move", 30, 20), viewScale: 0.25 });
    expect(runtime.cursor?.(view)).toBe("grab");
    runtime.pointer({ ...event("move", 30, 36), viewScale: 0.25 });
    expect(runtime.cursor?.(view)).toBe("grab");
    runtime.pointer({ ...event("down", 30, 36), viewScale: 0.25 });
    runtime.pointer({ ...event("up", 30, 46), viewScale: 0.25 });
    expect(doc.history.undoName).toBe("history.editGradient");
  });

  it("a click without a drag draws nothing", () => {
    runtime.pointer(event("down", 5, 5));
    runtime.pointer(event("up", 5, 5));
    expect(runtime.hasPending?.()).toBe(false);
    expect(doc.history.undoName).toBe("paint");
  });

  it("a click that jitters within 4 CSS pixels draws nothing and moves no handle", () => {
    // At 100 % zoom: a canvas pixel is a CSS pixel.
    const at = (type: ToolPointerEvent["type"], x: number, y: number) => ({
      ...event(type, x, y),
      clientX: x,
      clientY: y,
    });
    runtime.pointer(at("down", 5, 5));
    runtime.pointer(at("move", 7, 6));
    runtime.pointer(at("up", 7, 7));
    expect(runtime.hasPending?.()).toBe(false);
    expect(doc.history.undoName).toBe("paint");

    drag(2, 16, 30, 16);
    runtime.pointer(at("down", 16, 16));
    runtime.pointer(at("move", 18, 18));
    runtime.pointer(at("up", 18, 18));
    expect(doc.history.undoName).toBe("history.gradient");
    expect(gradientHandles.state.start).toEqual({ x: 2, y: 16 });

    runtime.pointer(at("down", 16, 16));
    runtime.pointer(at("up", 16, 22));
    expect(doc.history.undoName).toBe("history.moveGradient");
    expect(gradientHandles.state.start).toEqual({ x: 2, y: 22 });
  });

  it("Shift snaps the drawn end to a 15 degree step", () => {
    drag(2, 16, 30, 17, 0, true);
    expect(gradientHandles.state.end?.y).toBeCloseTo(16, 9);
    expect(gradientHandles.state.end?.x).toBeCloseTo(2 + Math.hypot(28, 1), 9);
  });

  it("an option change re-renders the pending gradient as one step", () => {
    drag(2, 16, 30, 16);
    settings.set("tools.gradient.repeatType", "RepeatWrapped");
    expect(doc.history.undoName).toBe("history.changeRepeatType");
    expect(runtime.hasPending?.()).toBe(true);
    expect(pixel(31, 16)).not.toEqual(YELLOW);
  });

  it("dragging the end handle edits the gradient as one Edit Gradient step", () => {
    drag(2, 16, 30, 16);
    runtime.pointer(event("down", 30, 16));
    runtime.pointer(event("move", 15, 16));
    runtime.pointer(event("up", 15, 16));
    expect(doc.history.undoName).toBe("history.editGradient");
    expect(gradientHandles.state.end).toEqual({ x: 15, y: 16 });
    expect(pixel(29, 16)).toEqual(YELLOW);
  });

  it("dragging the move handle translates both ends as one Move Gradient step", () => {
    drag(2, 16, 30, 16);
    runtime.pointer(event("down", 16, 16));
    runtime.pointer(event("move", 16, 20));
    runtime.pointer(event("up", 16, 20));
    expect(doc.history.undoName).toBe("history.moveGradient");
    expect(gradientHandles.state.start).toEqual({ x: 2, y: 20 });
    expect(gradientHandles.state.end).toEqual({ x: 30, y: 20 });
  });

  it("a right-click on a handle swaps the colors as Reverse Colors", () => {
    drag(2, 16, 30, 16);
    runtime.pointer(event("down", 2, 16, 2));
    runtime.pointer(event("up", 2, 16, 2));
    expect(doc.history.undoName).toBe("history.reverseColors");
    expect(pixel(0, 16)).toEqual(YELLOW);
    expect(runtime.hasPending?.()).toBe(true);
  });

  it("a click elsewhere commits the pending gradient first, then draws a new one", () => {
    drag(2, 16, 30, 16);
    drag(20, 2, 20, 30);
    const names = doc.history.entries.map((entry) => entry.name).slice(-3);
    expect(names).toEqual(["history.gradient", "history.finishGradient", "history.gradient"]);
  });

  it("an undo ends the pending gradient", async () => {
    drag(2, 16, 30, 16);
    expect(await doc.history.undo()).toBe(true);
    expect(runtime.hasPending?.()).toBe(false);
    expect(pixel(0, 16)).toEqual(RED);
  });

  it("undoing Finish makes the gradient pending again with its handles and options, and edits continue (owner request)", async () => {
    drag(2, 16, 30, 16);
    settings.set("tools.gradient.repeatType", "RepeatWrapped");
    runtime.commit?.();
    expect(gradientHandles.state).toEqual({});
    const finished = pixel(31, 16);
    settings.set("tools.gradient.repeatType", "NoRepeat");

    await doc.history.undo();
    expect(runtime.hasPending?.()).toBe(true);
    expect(gradientHandles.state.start).toEqual({ x: 2, y: 16 });
    expect(gradientHandles.state.end).toEqual({ x: 30, y: 16 });
    expect(settings.get("tools.gradient.repeatType")).toBe("RepeatWrapped");
    expect(doc.history.undoName).toBe("history.changeRepeatType");
    expect(pixel(31, 16)).toEqual(finished);

    await doc.history.redo();
    expect(runtime.hasPending?.()).toBe(false);
    expect(gradientHandles.state).toEqual({});

    await doc.history.undo();
    await doc.history.undo();
    expect(runtime.hasPending?.()).toBe(true);
    expect(settings.get("tools.gradient.repeatType")).toBe("NoRepeat");
    expect(pixel(31, 16)).toEqual(YELLOW);
    runtime.pointer(event("down", 30, 16));
    runtime.pointer(event("move", 15, 16));
    runtime.pointer(event("up", 15, 16));
    expect(doc.history.undoName).toBe("history.editGradient");
    expect(doc.history.canRedo).toBe(false);
    expect(pixel(29, 16)).toEqual(YELLOW);
    expect(pixel(0, 16)).toEqual(GREEN);

    await doc.history.undo();
    await doc.history.undo();
    expect(runtime.hasPending?.()).toBe(false);
    expect(pixel(0, 16)).toEqual(RED);
  });

  it("a cancelled draw restores the layer and records nothing", () => {
    runtime.pointer(event("down", 2, 16));
    runtime.pointer(event("move", 30, 16));
    runtime.cancel?.();
    expect(pixel(0, 16)).toEqual(RED);
    expect(doc.history.undoName).toBe("paint");
    expect(runtime.hasPending?.()).toBe(false);
  });

  it("the status line shows the measurements while the gradient is drawn", () => {
    runtime.pointer(event("down", 2, 16));
    runtime.pointer(event("move", 30, 16));
    expect(status).toHaveBeenLastCalledWith(
      `tool.status.gradientAdjust ${JSON.stringify({ dx: 28, dy: 0, length: 28, angle: 0 })}`,
    );
    runtime.pointer(event("up", 30, 16));
    expect(status).toHaveBeenLastCalledWith("tool.status.gradientPending");
  });

  it("clips the gradient to the selection", () => {
    doc.replaceSelection(new Selection([rectPolygon(rect(0, 0, 4, 32))]), "select");
    drag(2, 16, 30, 16);
    expect(pixel(0, 16)).toEqual(GREEN);
    expect(pixel(10, 16)).toEqual(RED);
  });

  it("transparency mode ramps the alpha from the primary to the transparent end", () => {
    settings.set("tools.gradient.alphaOnly", true);
    drag(2, 16, 30, 16);
    expect(pixel(0, 16)).toEqual(RED);
    expect(pixel(31, 16).a).toBe(0);
    expect(pixel(31, 16).r).toBe(BLUE.r);
    expect(pixel(31, 16).b).toBe(BLUE.b);
    expect(doc.history.undoName).toBe("history.gradient");
  });

  it("the history names of the option changes follow the spec", () => {
    drag(2, 16, 30, 16);
    settings.set("tools.gradient.type", "Radial");
    expect(doc.history.undoName).toBe("history.changeGradientType");
    settings.set("tools.gradient.alphaOnly", true);
    expect(doc.history.undoName).toBe("history.toggleAlphaMode");
    settings.set("tools.antialiasing", true);
    expect(doc.history.undoName).toBe("history.toggleAntialiasing");
  });
});

/** Lanes that render only when told to, the way workers answer later. */
class DeferredLanes implements GradientLanes {
  readonly count = 1;
  readonly inline = false;
  readonly #inner = new InlineGradientLanes();
  readonly #queue: GradientTileJob[] = [];

  post(_lane: number, job: GradientTileJob): void {
    this.#queue.push(job);
  }

  listen(session: number, listener: (reply: GradientTileReply) => void): () => void {
    return this.#inner.listen(session, listener);
  }

  answerAll(): void {
    for (let job = this.#queue.shift(); job !== undefined; job = this.#queue.shift()) {
      this.#inner.post(0, job);
    }
  }
}

describe("Gradient tool with tiles rendered in workers (L7)", () => {
  it("records once the render has landed, holding the document meanwhile", async () => {
    const doc = Document.createBlank({ width: 600, height: 40 });
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    const settings = new FakeSettings();
    const lanes = new DeferredLanes();
    const host: PaintHost = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (messageId) => messageId,
      notify: vi.fn(),
      report: vi.fn(),
      gradientLanes: () => lanes,
    };
    const runtime = gradientToolRuntime(host);
    runtime.activate();
    const before = doc.history.undoName;
    runtime.pointer(event("down", 2, 20));
    runtime.pointer(event("move", 590, 20));
    runtime.pointer(event("up", 590, 20));
    // Nothing is recorded until the tiles land, and nothing else may edit meanwhile.
    expect(doc.history.undoName).toBe(before);
    const settling = runtime.settling?.();
    expect(settling).toBeDefined();
    expect(runtime.hasPending?.()).toBe(true);
    expect(() => doc.history.assertIdle()).toThrow();
    lanes.answerAll();
    await settling;
    expect(runtime.settling?.()).toBeUndefined();
    expect(doc.history.undoName).toBe("history.gradient");
    expect(layer.pixels.getPixel(0, 20)).toEqual(GREEN);
    expect(layer.pixels.getPixel(599, 20)).toEqual(YELLOW);
    // Finish needs no new render: the layer already shows the recorded gradient.
    runtime.commit?.();
    expect(doc.history.undoName).toBe("history.finishGradient");
    await doc.history.undo();
    await doc.history.undo();
    expect(layer.pixels.getPixel(0, 20)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    runtime.deactivate();
  });
});
