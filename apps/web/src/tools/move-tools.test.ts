// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import {
  type ClipboardImage,
  composeFloating,
  Document,
  type Layer,
  rect,
  rectPolygon,
  Selection,
  Surface,
} from "@openpaint/document";
import type { ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import type { SettingChange } from "@openpaint/storage";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import { finishOnLayerSwitch } from "./finish-on-switch";
import { NUDGE_MERGE_MS } from "./frame-tool";
import { FloatingHandoff, movePixelsToolRuntime, moveSelectionToolRuntime } from "./move-tools";
import type { PaintHost } from "./paint-tools";
import { transformFrame } from "./transform-frame";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };

/**
 * A 40 x 40 block at (4, 4) on a 64 x 64 canvas. Its frame has its anchor at (24, 24) and its
 * handles at the corners and edge midpoints, so the presses below land on the body, a handle or
 * the anchor as each test needs.
 */
const BLOCK = rect(4, 4, 40, 40);
const BODY_PRESS = { x: 12, y: 34 };
const SE_HANDLE = { x: 44, y: 44 };

/** A settings fake that reports its own changes to the listeners, as the store does. */
class FakeSettings {
  readonly values: Record<string, unknown> = {
    "tools.move.resampling": "HighQualityCubic",
    "tools.gammaMode": "Linear",
  };
  readonly #listeners = new Set<(change: SettingChange) => void>();

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
  modifiers: { readonly ctrl?: boolean; readonly shift?: boolean } = {},
): ToolPointerEvent {
  return {
    type,
    x,
    y,
    button,
    pressure: 1,
    shiftKey: modifiers.shift === true,
    altKey: false,
    ctrlKey: modifiers.ctrl === true,
  };
}

function blueImage(width: number, height: number): ClipboardImage {
  const pixels = new Surface(width, height);
  pixels.fill(BLUE);
  return { pixels };
}

/** A 64 x 64 document with a red block selected at BLOCK. */
function selectedBlock(): Document {
  const doc = Document.createBlank({ width: 64, height: 64 });
  const layer = doc.activeLayer;
  if (layer === undefined) throw new Error("no layer");
  const block = new Surface(BLOCK.width, BLOCK.height);
  block.fill(RED);
  doc.editLayerPixels("paint", layer, BLOCK, (pixels) => {
    pixels.writeRegion(block, BLOCK.x, BLOCK.y);
  });
  doc.replaceSelection(new Selection([rectPolygon(BLOCK)]), "select");
  return doc;
}

describe("Move Selected Pixels (TL-MOVE-PIX-01, TL-FRAME-01)", () => {
  let doc: Document;
  let settings: FakeSettings;
  let handoff: FloatingHandoff;
  let runtime: ToolRuntime;
  const notify = vi.fn();
  const report = vi.fn();

  function host(): PaintHost {
    return {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
    };
  }

  function pixel(x: number, y: number) {
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no layer");
    return layer.pixels.getPixel(x, y);
  }

  /** A press, a move to `to` and a release, as the canvas delivers them. */
  function drag(
    from: { readonly x: number; readonly y: number },
    to: { readonly x: number; readonly y: number },
    button = 0,
    modifiers = {},
  ): void {
    runtime.pointer(event("down", from.x, from.y, button, modifiers));
    runtime.pointer(event("move", to.x, to.y, button, modifiers));
    runtime.pointer(event("up", to.x, to.y, button, modifiers));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    doc = selectedBlock();
    settings = new FakeSettings();
    handoff = new FloatingHandoff();
    runtime = movePixelsToolRuntime(host(), handoff);
    runtime.activate();
    notify.mockClear();
    report.mockClear();
  });

  afterEach(() => {
    runtime.deactivate();
    transformFrame.set(undefined);
    vi.useRealTimers();
  });

  it("moves the selected pixels on a drag and records one Move Pixels item", () => {
    const before = doc.history.appliedCommands.length;
    drag(BODY_PRESS, { x: BODY_PRESS.x + 6, y: BODY_PRESS.y });
    expect(pixel(4, 4).a).toBe(0);
    expect(pixel(10, 4)).toEqual(RED);
    expect(pixel(49, 43)).toEqual(RED);
    expect(doc.history.undoName).toBe("history.movePixels");
    expect(doc.history.appliedCommands.length).toBe(before + 1);
    expect(doc.selection.bounds()).toEqual(rect(10, 4, 40, 40));
  });

  it("previews a rotation over the layer and records it once the worker's result lands", async () => {
    const reference = selectedBlock();
    const plain = movePixelsToolRuntime({ ...host(), document: () => reference }, handoff);
    plain.activate();
    const jobs: (() => void)[] = [];
    runtime.deactivate();
    runtime = movePixelsToolRuntime(
      {
        ...host(),
        floatDisplay: () => ({ available: () => true }),
        floatComposer: () => (job) =>
          new Promise((resolve) => {
            jobs.push(() => resolve(composeFloating(job)));
          }),
      },
      handoff,
    );
    runtime.activate();
    const layer = doc.activeLayer as Layer;
    const before = [...layer.pixels.readRegion(layer.pixels.bounds).data];
    const to = { x: SE_HANDLE.x + 4, y: 10 };
    runtime.pointer(event("down", SE_HANDLE.x + 4, 30, 2));
    runtime.pointer(event("move", to.x, to.y, 2));
    // The drag writes nothing: the canvas draws the float.
    expect([...layer.pixels.readRegion(layer.pixels.bounds).data]).toEqual(before);
    expect(layer.floatPreview).toBeDefined();
    runtime.pointer(event("up", to.x, to.y, 2));
    const settling = runtime.settling?.();
    expect(settling).toBeDefined();
    // Enter finishes while the rotation is still computed: the tool keeps settling until both land.
    runtime.commit?.();
    expect(runtime.settling?.()).toBe(settling);
    jobs.shift()?.();
    await settling;
    expect(runtime.settling?.()).toBeUndefined();
    expect(doc.history.entries.map((entry) => entry.name).slice(-2)).toEqual([
      "history.rotatePixels",
      "history.finishPixels",
    ]);
    plain.pointer(event("down", SE_HANDLE.x + 4, 30, 2));
    plain.pointer(event("move", to.x, to.y, 2));
    plain.pointer(event("up", to.x, to.y, 2));
    plain.commit?.();
    const refLayer = reference.activeLayer as Layer;
    expect([...layer.pixels.readRegion(layer.pixels.bounds).data]).toEqual([
      ...refLayer.pixels.readRegion(refLayer.pixels.bounds).data,
    ]);
    expect(layer.floatPreview).toBeUndefined();
    plain.deactivate();
  });

  describe("a layer switch (TL-FRAME-01)", () => {
    /** Puts a blue copy of the block on a new layer above, then makes the red layer active again. */
    function twoLayers() {
      const red = doc.activeLayer;
      if (red === undefined) throw new Error("no layer");
      const blue = doc.addLayer();
      const block = new Surface(BLOCK.width, BLOCK.height);
      block.fill(BLUE);
      doc.editLayerPixels("paint", blue, BLOCK, (pixels) => {
        pixels.writeRegion(block, BLOCK.x, BLOCK.y);
      });
      doc.setActiveLayer(red);
      return { red, blue };
    }

    it("finishes the float on its own layer, and the next drag lifts from the new layer", () => {
      const { red, blue } = twoLayers();
      const stop = finishOnLayerSwitch(doc, () => {
        if (runtime.hasPending?.()) runtime.commit?.();
      });
      drag(BODY_PRESS, { x: BODY_PRESS.x + 6, y: BODY_PRESS.y });
      expect(runtime.hasPending?.()).toBe(true);

      doc.setActiveLayer(blue);
      expect(runtime.hasPending?.()).toBe(false);
      expect(doc.history.undoName).toBe("history.finishPixels");
      // Only the moved selection's handles stay, ready for the new layer.
      expect(transformFrame.state?.handles.se).toEqual({ x: 50, y: 44 });
      // The outline is document-wide: it stays where the first move left it.
      expect(doc.selection.bounds()).toEqual(rect(10, 4, 40, 40));

      drag({ x: BODY_PRESS.x + 6, y: BODY_PRESS.y }, { x: BODY_PRESS.x + 12, y: BODY_PRESS.y });
      // The blue layer's pixels inside the outline moved; the part outside it stayed.
      expect(blue.pixels.getPixel(5, 4)).toEqual(BLUE);
      expect(blue.pixels.getPixel(12, 4).a).toBe(0);
      expect(blue.pixels.getPixel(49, 4)).toEqual(BLUE);
      expect(doc.selection.bounds()).toEqual(rect(16, 4, 40, 40));
      // The red layer keeps its finished move.
      expect(red.pixels.getPixel(4, 4).a).toBe(0);
      expect(red.pixels.getPixel(10, 4)).toEqual(RED);
      expect(red.pixels.getPixel(49, 43)).toEqual(RED);
      expect(red.pixels.getPixel(52, 43)).not.toEqual(RED);
      stop();
    });
  });

  describe("cursors (TL-MOVE-01, TL-FRAME-06)", () => {
    const view = { canPan: false, panning: false };
    const cursorAt = (x: number, y: number) => {
      runtime.pointer(event("move", x, y));
      return runtime.cursor?.(view);
    };

    it("shows the move arrows inside the selection before anything is lifted", () => {
      expect(cursorAt(BODY_PRESS.x, BODY_PRESS.y)).toBe("move");
      expect(runtime.hasPending?.()).toBe(false);
      expect(doc.activeLayer?.floatPreview).toBeUndefined();
    });

    it("shows a resize arrow along each handle, an open hand on the anchor and a rotate arrow outside", () => {
      expect(cursorAt(SE_HANDLE.x, SE_HANDLE.y)).toBe("nwse-resize");
      expect(cursorAt(4, 44)).toBe("nesw-resize");
      expect(cursorAt(44, 24)).toBe("ew-resize");
      expect(cursorAt(24, 4)).toBe("ns-resize");
      expect(cursorAt(24, 24)).toBe("grab");
      expect(cursorAt(50, 50)).toContain("data:image/svg+xml");
      expect(cursorAt(62, 10)).toBeUndefined();
    });

    it("orients the rotate arrow to the side the pointer is on", () => {
      expect(cursorAt(50, 50)).not.toBe(cursorAt(-2, -2));
      expect(cursorAt(50, 50)).toBe(cursorAt(49, 49));
    });

    it("keeps the gesture's cursor while it is dragged, and the closed hand on the anchor", () => {
      runtime.pointer(event("down", BODY_PRESS.x, BODY_PRESS.y));
      expect(cursorAt(BODY_PRESS.x + 30, BODY_PRESS.y + 20)).toBe("move");
      runtime.pointer(event("up", BODY_PRESS.x + 30, BODY_PRESS.y + 20));
      // The frame moved by (30, 20), so its anchor is at (54, 44).
      runtime.pointer(event("down", 54, 44));
      expect(cursorAt(54, 50)).toBe("grabbing");
      runtime.pointer(event("up", 54, 50));
      expect(runtime.cursor?.({ ...view, panning: true })).toBeUndefined();
    });

    it("shows the move arrows over the whole canvas when nothing is selected", () => {
      doc.deselect();
      expect(cursorAt(52, 10)).toBe("move");
      expect(cursorAt(64, 64)).toBe("nwse-resize");
    });
  });

  it("selects and moves the whole canvas when nothing is selected, as one Move Pixels item", async () => {
    doc.deselect();
    const before = doc.history.appliedCommands.length;
    drag({ x: 20, y: 40 }, { x: 26, y: 40 });
    expect(doc.history.appliedCommands.length).toBe(before + 1);
    expect(doc.history.undoName).toBe("history.movePixels");
    expect(doc.selection.bounds()).toEqual(rect(6, 0, 64, 64));
    expect(pixel(10, 4)).toEqual(RED);
    expect(pixel(2, 4).a).toBe(0);
    await doc.history.undo();
    expect(doc.selection.isEmpty).toBe(true);
    expect(pixel(4, 4)).toEqual(RED);
  });

  it("records nothing for a press that does not move", () => {
    const before = doc.history.appliedCommands.length;
    drag(BODY_PRESS, BODY_PRESS);
    expect(doc.history.appliedCommands.length).toBe(before);
    expect(pixel(4, 4)).toEqual(RED);
  });

  it("moves nothing for a press that jitters within 4 CSS pixels, at any zoom", () => {
    const before = doc.history.appliedCommands.length;
    for (const zoom of [0.25, 1, 8]) {
      const at = (type: ToolPointerEvent["type"], cx: number, cy: number) => ({
        ...event(type, BODY_PRESS.x + cx / zoom, BODY_PRESS.y + cy / zoom),
        clientX: 500 + cx,
        clientY: 500 + cy,
      });
      runtime.pointer(at("down", 0, 0));
      runtime.pointer(at("move", 2, 2));
      runtime.pointer(at("up", 3, 0));
      expect(doc.history.appliedCommands.length).toBe(before);
      expect(pixel(4, 4)).toEqual(RED);
    }
    // Past the zone, the move starts from the press point.
    const at = (type: ToolPointerEvent["type"], cx: number) => ({
      ...event(type, BODY_PRESS.x + cx, BODY_PRESS.y),
      clientX: 500 + cx,
      clientY: 500,
    });
    runtime.pointer(at("down", 0));
    runtime.pointer(at("move", 3));
    runtime.pointer(at("up", 6));
    expect(doc.history.undoName).toBe("history.movePixels");
    expect(doc.selection.bounds()).toEqual(rect(10, 4, 40, 40));
  });

  it("draws the frame while it holds the pixels", () => {
    runtime.pointer(event("down", BODY_PRESS.x, BODY_PRESS.y));
    expect(transformFrame.state).toBeDefined();
    runtime.pointer(event("up", BODY_PRESS.x, BODY_PRESS.y));
    expect(runtime.hasPending?.()).toBe(true);
    runtime.commit?.();
    expect(runtime.hasPending?.()).toBe(false);
    // Finished, the tool shows the selection's handles again; deactivated, nothing.
    expect(transformFrame.state?.handles.se).toEqual(SE_HANDLE);
    runtime.deactivate();
    expect(transformFrame.state).toBeUndefined();
    runtime.activate();
  });

  describe("handles before any press (owner request)", () => {
    /** Lets the tool see the document changes that notified, as it does after each one. */
    const settle = () => Promise.resolve();

    it("shows the selection's handles as soon as it is active, and lifts or records nothing", () => {
      runtime.deactivate();
      transformFrame.set(undefined);
      const changes: string[] = [];
      const unsubscribe = doc.subscribe((change) => changes.push(change));
      const layer = doc.activeLayer as Layer;
      const before = [...layer.pixels.readRegion(layer.pixels.bounds).data];
      const steps = doc.history.appliedCommands.length;
      runtime = movePixelsToolRuntime(host(), handoff);
      runtime.activate();
      const state = transformFrame.state;
      expect(state?.handles.nw).toEqual({ x: 4, y: 4 });
      expect(state?.handles.se).toEqual(SE_HANDLE);
      expect(state?.anchor).toEqual({ x: 24, y: 24 });
      expect(runtime.hasPending?.()).toBe(false);
      expect(layer.floatPreview).toBeUndefined();
      expect([...layer.pixels.readRegion(layer.pixels.bounds).data]).toEqual(before);
      expect(doc.history.appliedCommands.length).toBe(steps);
      expect(changes).toEqual([]);
      // Hovering a handle shows its resize arrow before any press.
      runtime.pointer(event("move", SE_HANDLE.x, SE_HANDLE.y));
      expect(runtime.cursor?.({ canPan: false, panning: false })).toBe("nwse-resize");
      unsubscribe();
    });

    it("hides them without a selection and follows a new or restored selection", async () => {
      doc.deselect();
      await settle();
      expect(transformFrame.state).toBeUndefined();
      doc.selectAll();
      await settle();
      expect(transformFrame.state?.handles.se).toEqual({ x: 64, y: 64 });
      await doc.history.undo();
      await settle();
      expect(transformFrame.state).toBeUndefined();
      await doc.history.undo();
      await settle();
      expect(transformFrame.state?.handles.se).toEqual(SE_HANDLE);
      expect(runtime.hasPending?.()).toBe(false);
    });

    it("shows the restored selection's handles when an undo replaces a move", async () => {
      drag(BODY_PRESS, { x: BODY_PRESS.x + 6, y: BODY_PRESS.y });
      expect(transformFrame.state?.handles.se).toEqual({ x: 50, y: 44 });
      await doc.history.undo();
      await settle();
      expect(transformFrame.state?.handles.se).toEqual(SE_HANDLE);
    });

    it("scales on the first press on a handle, as one Resize Pixels item", () => {
      const before = doc.history.appliedCommands.length;
      drag(SE_HANDLE, { x: SE_HANDLE.x + 16, y: SE_HANDLE.y + 8 });
      expect(doc.history.appliedCommands.length).toBe(before + 1);
      expect(doc.history.undoName).toBe("history.resizePixels");
      expect(doc.selection.bounds()).toEqual(rect(4, 4, 56, 48));
      expect(transformFrame.state?.handles.se).toEqual({ x: 60, y: 52 });
    });

    it("lifts nothing for a press on the reset button of an anchor already at the centre", () => {
      const before = doc.history.appliedCommands.length;
      runtime.pointer(event("down", 24 + 14, 24 + 14));
      runtime.pointer(event("up", 24 + 14, 24 + 14));
      expect(runtime.hasPending?.()).toBe(false);
      expect(doc.history.appliedCommands.length).toBe(before);
    });
  });

  it("finishes as Finish Pixels, which is the Enter and Esc commit", () => {
    drag(BODY_PRESS, { x: BODY_PRESS.x + 6, y: BODY_PRESS.y });
    runtime.commit?.();
    expect(doc.history.undoName).toBe("history.finishPixels");
    expect(pixel(10, 4)).toEqual(RED);
  });

  it("Esc while dragging restores the pixels and records nothing for the drag", () => {
    const before = doc.history.appliedCommands.length;
    runtime.pointer(event("down", BODY_PRESS.x, BODY_PRESS.y));
    runtime.pointer(event("move", BODY_PRESS.x + 9, BODY_PRESS.y));
    runtime.cancel?.();
    runtime.pointer(event("up", BODY_PRESS.x + 9, BODY_PRESS.y));
    expect(pixel(4, 4)).toEqual(RED);
    expect(pixel(50, 4)).not.toEqual(RED);
    expect(doc.history.appliedCommands.length).toBe(before);
  });

  it("draws a drag once per frame at the newest pointer, with no selection re-render of the shell", () => {
    const frames: (() => void)[] = [];
    runtime.deactivate();
    runtime = movePixelsToolRuntime(
      {
        ...host(),
        scheduleFrame: (callback) => {
          frames.push(callback);
          return () => frames.splice(frames.indexOf(callback), 1);
        },
      },
      handoff,
    );
    runtime.activate();
    const changes: string[] = [];
    const unsubscribe = doc.subscribe((change) => changes.push(change));
    const before = doc.history.appliedCommands.length;
    runtime.pointer(event("down", BODY_PRESS.x, BODY_PRESS.y));
    changes.length = 0;
    for (let dx = 1; dx <= 5; dx++) runtime.pointer(event("move", BODY_PRESS.x + dx, BODY_PRESS.y));
    expect(frames).toHaveLength(1);
    expect(changes).toEqual([]);
    frames.shift()?.();
    // One preview: its pixels and its selection, neither of which re-renders the app shell.
    expect(changes).toEqual(["preview", "selection"]);
    expect(pixel(9, 4)).toEqual(RED);
    expect(pixel(4, 4).a).toBe(0);
    runtime.pointer(event("move", BODY_PRESS.x + 7, BODY_PRESS.y));
    runtime.pointer(event("up", BODY_PRESS.x + 8, BODY_PRESS.y));
    expect(frames).toHaveLength(0);
    expect(pixel(12, 4)).toEqual(RED);
    expect(doc.history.appliedCommands.length).toBe(before + 1);
    expect(doc.selection.bounds()).toEqual(rect(12, 4, 40, 40));
    unsubscribe();
  });

  it("leaves a copy behind when the drag starts with Ctrl", () => {
    drag(BODY_PRESS, { x: BODY_PRESS.x + 6, y: BODY_PRESS.y }, 0, { ctrl: true });
    expect(pixel(4, 4)).toEqual(RED);
    expect(pixel(10, 4)).toEqual(RED);
  });

  it("scales from a handle as Resize Pixels", () => {
    drag(SE_HANDLE, { x: SE_HANDLE.x + 16, y: SE_HANDLE.y });
    expect(doc.history.undoName).toBe("history.resizePixels");
    expect(pixel(12, 12)).toEqual(RED);
    expect(pixel(4, 4).a).toBeGreaterThan(0);
  });

  it("rotates from the right button as Rotate Pixels", () => {
    drag({ x: 30, y: 30 }, { x: 30, y: 40 }, 2);
    expect(doc.history.undoName).toBe("history.rotatePixels");
  });

  it("merges nudges that follow each other within 500 ms into one Move Pixels item", () => {
    const before = doc.history.appliedCommands.length;
    runtime.nudge?.(1, 0, 1);
    vi.advanceTimersByTime(NUDGE_MERGE_MS - 100);
    runtime.nudge?.(1, 0, 1);
    vi.advanceTimersByTime(NUDGE_MERGE_MS - 100);
    runtime.nudge?.(1, 0, 1);
    expect(doc.history.appliedCommands.length).toBe(before);
    vi.advanceTimersByTime(NUDGE_MERGE_MS);
    expect(doc.history.appliedCommands.length).toBe(before + 1);
    expect(doc.history.undoName).toBe("history.movePixels");
    expect(pixel(7, 4)).toEqual(RED);
    expect(pixel(6, 4).a).toBe(0);
  });

  it("nudges by 10 px with Ctrl", () => {
    runtime.nudge?.(0, 1, 10);
    runtime.commit?.();
    expect(pixel(4, 14)).toEqual(RED);
    expect(pixel(4, 4).a).toBe(0);
  });

  it("does not nudge while a drag is in progress", () => {
    runtime.pointer(event("down", BODY_PRESS.x, BODY_PRESS.y));
    expect(runtime.nudge?.(1, 0, 1)).toBe(false);
    runtime.pointer(event("up", BODY_PRESS.x, BODY_PRESS.y));
  });

  it("takes over a pasted session and moves the pasted pixels", () => {
    runtime.deactivate();
    const session = doc.pasteFloating(blueImage(20, 20), { x: 1, y: 1 });
    handoff.offer(session);
    runtime = movePixelsToolRuntime(host(), handoff);
    runtime.activate();
    expect(transformFrame.state).toBeDefined();
    drag({ x: 6, y: 17 }, { x: 11, y: 17 });
    expect(doc.history.undoName).toBe("history.movePixels");
    expect(pixel(6, 6)).toEqual(BLUE);
  });

  it("re-records the current transform when the resampling option changes", () => {
    drag(BODY_PRESS, { x: BODY_PRESS.x + 5, y: BODY_PRESS.y });
    settings.set("tools.move.resampling", "Linear");
    expect(doc.history.undoName).toBe("history.changeSampling");
  });

  it("ends when an undo changes the document behind it", async () => {
    drag(BODY_PRESS, { x: BODY_PRESS.x + 6, y: BODY_PRESS.y });
    await doc.history.undo();
    expect(runtime.hasPending?.()).toBe(false);
    // The handles are back on the selection as it was before the move.
    expect(transformFrame.state?.handles.se).toEqual(SE_HANDLE);
  });
});

describe("Move Selection (TL-MOVE-SEL-01)", () => {
  let doc: Document;
  let runtime: ToolRuntime;

  beforeEach(() => {
    doc = selectedBlock();
    runtime = moveSelectionToolRuntime({
      settings: () => null,
      document: () => doc,
      translate: (messageId) => messageId,
      notify: () => undefined,
      report: () => undefined,
    });
    runtime.activate();
  });

  afterEach(() => {
    runtime.deactivate();
  });

  it("shows the selection's handles as soon as it is active, and hides them without one", async () => {
    const before = doc.history.appliedCommands.length;
    expect(transformFrame.state?.handles.se).toEqual(SE_HANDLE);
    expect(doc.history.appliedCommands.length).toBe(before);
    expect(runtime.hasPending?.()).toBe(false);
    doc.deselect();
    await Promise.resolve();
    expect(transformFrame.state).toBeUndefined();
  });

  it("resizes the outline on the first press on a handle, as one Resize Selection item", () => {
    const before = doc.history.appliedCommands.length;
    runtime.pointer(event("down", SE_HANDLE.x, SE_HANDLE.y));
    runtime.pointer(event("move", SE_HANDLE.x + 16, SE_HANDLE.y + 8));
    // The marching ants follow the outline while it is dragged.
    expect(doc.selection.bounds()).toEqual(rect(4, 4, 56, 48));
    runtime.pointer(event("up", SE_HANDLE.x + 16, SE_HANDLE.y + 8));
    expect(doc.history.appliedCommands.length).toBe(before + 1);
    expect(doc.history.undoName).toBe("history.resizeSelection");
    expect(transformFrame.state?.handles.se.x).toBeCloseTo(60);
    expect(transformFrame.state?.handles.se.y).toBeCloseTo(52);
  });

  it("moves the outline and leaves the pixels where they are", () => {
    runtime.pointer(event("down", BODY_PRESS.x, BODY_PRESS.y));
    runtime.pointer(event("move", BODY_PRESS.x + 6, BODY_PRESS.y));
    runtime.pointer(event("up", BODY_PRESS.x + 6, BODY_PRESS.y));
    expect(doc.history.undoName).toBe("history.moveSelection");
    expect(doc.selection.bounds()).toEqual(rect(10, 4, 40, 40));
    expect(doc.activeLayer?.pixels.getPixel(4, 4)).toEqual(RED);
  });

  it("names a resize and a finish of the selection", () => {
    runtime.pointer(event("down", SE_HANDLE.x, SE_HANDLE.y));
    runtime.pointer(event("move", SE_HANDLE.x + 16, SE_HANDLE.y));
    runtime.pointer(event("up", SE_HANDLE.x + 16, SE_HANDLE.y));
    expect(doc.history.undoName).toBe("history.resizeSelection");
    runtime.commit?.();
    expect(doc.history.undoName).toBe("history.finishSelection");
  });

  it("does nothing without a selection", () => {
    doc.deselect();
    const before = doc.history.appliedCommands.length;
    runtime.pointer(event("down", BODY_PRESS.x, BODY_PRESS.y));
    runtime.pointer(event("up", BODY_PRESS.x, BODY_PRESS.y));
    expect(doc.history.appliedCommands.length).toBe(before);
  });

  it("shows the move arrows inside the selection, and the default cursor without one", () => {
    const view = { canPan: false, panning: false };
    runtime.pointer(event("move", BODY_PRESS.x, BODY_PRESS.y));
    expect(runtime.cursor?.(view)).toBe("move");
    doc.deselect();
    expect(runtime.cursor?.(view)).toBeUndefined();
  });
});
