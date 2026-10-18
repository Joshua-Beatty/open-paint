// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, LayerBlendMode, OutOfMemoryError, rect, Surface } from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import {
  cloneStrokeCpu,
  recolorStrokeCpu,
  type StrokeCommit,
  strokeBrush,
  strokePencilCpu,
} from "@openpaint/engine";
import type { ToolDescriptor, ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import { cloneSourceMarker, readCloneSource } from "./clone-source";
import { BRUSH_POINTER_CURSOR, CLONE_ANCHOR_CURSOR } from "./cursors";
import { engineStrokesPending, engineStrokesSettled } from "./engine-stroke";
import type { EngineStrokeChannel } from "./engine-strokes";
import { brushOptionsFor } from "./paint-stroke";
import { builtinToolRuntime, type PaintHost } from "./paint-tools";
import { TOOL_REGISTRY } from "./roster";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const BLACK = { r: 0, g: 0, b: 0, a: 255 };
const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };

/** Settings with the stored `tools.*` values, keyed by their full path. */
function settingsWith(values: Record<string, unknown>): ColorSettings {
  return {
    get: (path: string) => values[path],
    set: () => undefined,
    onChange: () => () => undefined,
  } as unknown as ColorSettings;
}

/** Factory values for the stroke options, with a hard, aliased tip so pixels are exact. */
const HARD_TIP = {
  "tools.brush.size": 4,
  "tools.brush.hardness": 1,
  "tools.antialiasing": false,
  "tools.brush.pressure": false,
  "tools.inputSmoothing": "Disabled",
  "tools.primaryColor": BLACK,
  "tools.secondaryColor": RED,
};

function toolNamed(id: string): ToolDescriptor {
  const tool = TOOL_REGISTRY.get(id);
  if (tool === undefined) throw new Error(`no tool ${id}`);
  return tool;
}

function event(
  type: ToolPointerEvent["type"],
  point: readonly [number, number],
  button: number,
  predicted?: boolean,
): ToolPointerEvent {
  return {
    type,
    x: point[0],
    y: point[1],
    button,
    pressure: 1,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...(predicted === undefined ? {} : { predicted }),
  };
}

/** A pointer press, its moves and its release, the way the canvas delivers them. */
function drag(
  runtime: ToolRuntime,
  path: readonly (readonly [number, number])[],
  button = 0,
): void {
  const [first, ...rest] = path;
  if (first === undefined) return;
  runtime.pointer(event("down", first, button));
  for (const point of rest.slice(0, -1)) runtime.pointer(event("move", point, button));
  const last = rest.at(-1) ?? first;
  runtime.pointer(event("up", last, button));
}

function pixel(doc: Document, x: number, y: number): number[] {
  const layer = doc.activeLayer;
  if (layer === undefined) throw new Error("no active layer");
  return [...layer.pixels.readRegion(rect(x, y, 1, 1)).data];
}

describe("paint tools", () => {
  let doc: Document;
  const notify = vi.fn<(messageId: MessageId) => void>();
  const report = vi.fn<(cause: unknown) => void>();

  function runtimeFor(id: string, values: Record<string, unknown> = HARD_TIP): ToolRuntime {
    const host: PaintHost = {
      settings: () => settingsWith(values),
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
    };
    const runtime = builtinToolRuntime(toolNamed(id), host);
    if (runtime === undefined) throw new Error(`no runtime for ${id}`);
    runtime.activate();
    return runtime;
  }

  beforeEach(() => {
    doc = Document.createBlank({ width: 32, height: 32 });
    notify.mockClear();
    report.mockClear();
  });

  it("gives no runtime to the tools that do not paint on pixels", () => {
    const noop: PaintHost = {
      settings: () => null,
      document: () => undefined,
      translate: (id) => id,
      notify: () => undefined,
      report: () => undefined,
    };
    expect(builtinToolRuntime(toolNamed("zoom"), noop)).toBeUndefined();
    expect(builtinToolRuntime(toolNamed("paintbrush"), noop)).toBeDefined();
  });

  it("shows a small pointer in the brush outline, a crosshair for the Pencil and the Clone Stamp's anchor with Ctrl", () => {
    const view = { canPan: false, panning: false };
    for (const id of ["paintbrush", "eraser", "recolor", "cloneStamp"]) {
      expect(runtimeFor(id).cursor?.(view)).toBe(BRUSH_POINTER_CURSOR);
    }
    expect(runtimeFor("pencil").cursor?.(view)).toBe("crosshair");
    expect(runtimeFor("cloneStamp").cursor?.({ ...view, ctrlKey: true })).toBe(CLONE_ANCHOR_CURSOR);
    expect(runtimeFor("paintbrush").cursor?.({ ...view, ctrlKey: true })).toBe(
      BRUSH_POINTER_CURSOR,
    );
    expect(runtimeFor("paintbrush").cursor?.({ ...view, panning: true })).toBeUndefined();
  });

  it("paints the primary color with the left button as one Paintbrush step", () => {
    const runtime = runtimeFor("paintbrush");
    const before = doc.history.entries.length;
    drag(runtime, [
      [5, 5],
      [12, 5],
      [20, 5],
    ]);
    expect(pixel(doc, 10, 5)).toEqual([0, 0, 0, 255]);
    expect(doc.history.entries.length).toBe(before + 1);
    expect(doc.history.entries.at(-1)?.name).toBe("history.paintbrush");
    expect(doc.dirty).toBe(true);
  });

  it("paints the secondary color with the right button", () => {
    const runtime = runtimeFor("paintbrush");
    drag(
      runtime,
      [
        [5, 10],
        [20, 10],
      ],
      2,
    );
    expect(pixel(doc, 10, 10)).toEqual([255, 0, 0, 255]);
  });

  it("shows the stroke as a preview without history, and cancel restores the layer", () => {
    const runtime = runtimeFor("paintbrush");
    const before = doc.history.entries.length;
    runtime.pointer(event("down", [5, 5], 0));
    runtime.pointer(event("move", [15, 5], 0));
    expect(pixel(doc, 10, 5)).toEqual([0, 0, 0, 255]);
    expect(doc.history.entries.length).toBe(before);
    expect(doc.dirty).toBe(false);
    runtime.cancel?.();
    expect(pixel(doc, 10, 5)).toEqual([255, 255, 255, 255]);
    runtime.pointer(event("up", [15, 5], 0));
    expect(doc.history.entries.length).toBe(before);
  });

  it("draws the moves of one frame as one preview, and still records every sample", () => {
    const frames: (() => void)[] = [];
    let cancelled = 0;
    const host: PaintHost = {
      settings: () => settingsWith(HARD_TIP),
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return () => {
          cancelled++;
        };
      },
    };
    const runtime = builtinToolRuntime(toolNamed("paintbrush"), host);
    if (runtime === undefined) throw new Error("no runtime");
    const notified = vi.fn();
    const unsubscribe = doc.subscribe(notified);

    runtime.pointer(event("down", [5, 5], 0));
    notified.mockClear();
    runtime.pointer(event("move", [10, 5], 0));
    runtime.pointer(event("move", [15, 5], 0));
    runtime.pointer(event("move", [20, 5], 0));
    expect(frames).toHaveLength(1);
    expect(notified).not.toHaveBeenCalled();
    expect(pixel(doc, 18, 5)).toEqual([255, 255, 255, 255]);

    frames.shift()?.();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(pixel(doc, 18, 5)).toEqual([0, 0, 0, 255]);

    runtime.pointer(event("move", [25, 5], 0));
    expect(frames).toHaveLength(1);
    runtime.pointer(event("up", [28, 5], 0));
    expect(cancelled).toBe(1);
    expect(pixel(doc, 26, 5)).toEqual([0, 0, 0, 255]);
    expect(doc.history.entries.at(-1)?.name).toBe("history.paintbrush");
    unsubscribe();
  });

  it("records only the stroke's own area, not the room its region grew by (L2)", () => {
    const frames: (() => void)[] = [];
    const host: PaintHost = {
      settings: () => settingsWith({ ...HARD_TIP, "tools.brush.size": 5 }),
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return () => frames.splice(frames.indexOf(callback), 1);
      },
    };
    doc = Document.createBlank({ width: 2000, height: 2000 });
    const runtime = builtinToolRuntime(toolNamed("paintbrush"), host);
    if (runtime === undefined) throw new Error("no runtime");
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no layer");
    runtime.pointer(event("down", [20, 20], 0));
    for (let x = 30; x <= 1500; x += 10) {
      runtime.pointer(event("move", [x, 20], 0));
      frames.shift()?.();
    }
    layer.pixels.clearDirty();
    runtime.pointer(event("up", [1500, 20], 0));
    // The grown region reaches past y = 256, but the stroke stays within the top row of tiles.
    expect(layer.pixels.dirtyTiles().every(({ ty }) => ty === 0)).toBe(true);
    expect(pixel(doc, 1000, 20)).toEqual([0, 0, 0, 255]);
  });

  it("paints a long stroke a few dabs per frame, matching the whole-stroke render", () => {
    const soft = {
      ...HARD_TIP,
      "tools.brush.size": 5,
      "tools.brush.hardness": 0.75,
      "tools.antialiasing": true,
    };
    const frames: (() => void)[] = [];
    const host: PaintHost = {
      settings: () => settingsWith(soft),
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return () => frames.splice(frames.indexOf(callback), 1);
      },
    };
    doc = Document.createBlank({ width: 1200, height: 200 });
    const runtime = builtinToolRuntime(toolNamed("paintbrush"), host);
    if (runtime === undefined) throw new Error("no runtime");
    const path: [number, number][] = [];
    for (let i = 0; i <= 120; i++) path.push([20 + i * 9, 100 + Math.sin(i / 5) * 40]);
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no layer");
    const before = layer.pixels.readRegion(layer.pixels.bounds);
    const reads = vi.spyOn(layer.pixels, "readRegion");

    runtime.pointer(event("down", path[0] ?? [0, 0], 0));
    for (const [index, point] of path.slice(1, -1).entries()) {
      runtime.pointer(event("move", point, 0));
      if (index % 4 === 3) frames.shift()?.();
      if (index === 100) layer.pixels.clearDirty();
    }
    frames.shift()?.();
    // A frame late in the stroke writes only the tiles near its new dabs, not the whole stroke.
    expect(layer.pixels.dirtyTileCount).toBeLessThanOrEqual(2);
    // The region grows by a share of its size, so it is read a few times, not every few frames
    // (31 reads before L2 was fixed).
    expect(reads.mock.calls.length).toBeLessThanOrEqual(12);
    reads.mockRestore();
    runtime.pointer(event("up", path.at(-1) ?? [0, 0], 0));

    const expected = strokeBrush(
      before,
      new Float32Array(path.flatMap(([x, y]) => [x, y, 1])),
      brushOptionsFor((name) => soft[`tools.${name}` as keyof typeof soft], "paint", BLACK, RED),
    );
    expect([...layer.pixels.readRegion(layer.pixels.bounds).data]).toEqual([...expected.data]);
    expect(doc.history.entries.at(-1)?.name).toBe("history.paintbrush");
  });

  it("paints a stroke that loops over itself a few samples per frame, matching the whole stroke", () => {
    const soft = {
      ...HARD_TIP,
      "tools.brush.size": 40,
      "tools.brush.hardness": 0,
      "tools.antialiasing": true,
      "tools.inputSmoothing": "Enabled",
    };
    const frames: (() => void)[] = [];
    const host: PaintHost = {
      settings: () => settingsWith(soft),
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return () => frames.splice(frames.indexOf(callback), 1);
      },
    };
    doc = Document.createBlank({ width: 300, height: 200 });
    const runtime = builtinToolRuntime(toolNamed("paintbrush"), host);
    if (runtime === undefined) throw new Error("no runtime");
    // Rightwards, round a loop of radius 50 and on past where the loop began.
    const path: [number, number][] = [];
    for (let i = 0; i <= 10; i++) path.push([20 + i * 8, 150]);
    for (let i = 1; i < 40; i++) {
      const a = Math.PI / 2 - (2 * Math.PI * i) / 40;
      path.push([100 + 50 * Math.cos(a), 100 + 50 * Math.sin(a)]);
    }
    for (let i = 0; i <= 10; i++) path.push([100 + i * 8, 150]);
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no layer");
    const before = layer.pixels.readRegion(layer.pixels.bounds);

    runtime.pointer(event("down", path[0] ?? [0, 0], 0));
    for (const [index, point] of path.slice(1, -1).entries()) {
      runtime.pointer(event("move", point, 0));
      if (index % 3 === 2) frames.shift()?.();
    }
    frames.shift()?.();
    runtime.pointer(event("up", path.at(-1) ?? [0, 0], 0));

    const read = (name: string) => soft[`tools.${name}` as keyof typeof soft];
    const options = brushOptionsFor(read, "paint", BLACK, RED);
    const expected = strokeBrush(
      before,
      new Float32Array(path.flatMap(([x, y]) => [x, y, 1])),
      options,
    );
    expect([...layer.pixels.readRegion(layer.pixels.bounds).data]).toEqual([...expected.data]);
  });

  describe("long Pencil, Recolor and Clone Stamp strokes, a few samples per frame", () => {
    const SMOOTH_SOFT = {
      ...HARD_TIP,
      "tools.brush.size": 7,
      "tools.brush.hardness": 0.5,
      "tools.antialiasing": true,
      "tools.inputSmoothing": "Enabled",
      "tools.primaryColor": BLUE,
      "tools.tolerance": 0.6,
      "tools.toleranceAlphaMode": "Premultiplied",
      "tools.recolor.samplingMode": "Once",
    };
    const read = (name: string) => SMOOTH_SOFT[`tools.${name}` as keyof typeof SMOOTH_SOFT];

    /** A wavy path across a 1200 × 200 image. */
    const path: [number, number][] = [];
    for (let i = 0; i <= 120; i++) path.push([20.25 + i * 9, 100.5 + Math.sin(i / 5) * 40]);
    const path3 = new Float32Array(path.flatMap(([x, y]) => [x, y, 1]));

    beforeEach(() => {
      doc = Document.createBlank({ width: 1200, height: 200 });
      // Stripes of reds, so the Recolor matches some and the Clone Stamp copies something.
      const layer = doc.activeLayer;
      if (layer === undefined) throw new Error("no layer");
      const stripes = new Surface(1200, 200);
      for (let y = 0; y < 200; y++) {
        for (let x = 0; x < 1200; x++) {
          const i = (y * 1200 + x) * 4;
          stripes.data.set([((x >> 3) % 4) * 60 + 40, (y * 3) % 256, 0, 200 + (x % 56)], i);
        }
      }
      doc.editLayerPixels("paint", layer, layer.pixels.bounds, (pixels) => {
        pixels.writeRegion(stripes, 0, 0);
      });
    });

    /**
     * Strokes `path` with the tool, drawing a frame every four samples, and returns the layer
     * before the stroke and the number of tiles a late frame wrote.
     */
    function strokeLive(id: string, setup?: (runtime: ToolRuntime) => void) {
      const frames: (() => void)[] = [];
      const host: PaintHost = {
        settings: () => settingsWith(SMOOTH_SOFT),
        document: () => doc,
        translate: (messageId) => messageId,
        notify,
        report,
        scheduleFrame: (callback) => {
          frames.push(callback);
          return () => frames.splice(frames.indexOf(callback), 1);
        },
      };
      const runtime = builtinToolRuntime(toolNamed(id), host);
      const layer = doc.activeLayer;
      if (runtime === undefined || layer === undefined) throw new Error("no runtime");
      runtime.activate();
      setup?.(runtime);
      const before = layer.pixels.readRegion(layer.pixels.bounds);
      runtime.pointer(event("down", path[0] ?? [0, 0], 0));
      let lateTiles = 0;
      for (const [index, point] of path.slice(1, -1).entries()) {
        runtime.pointer(event("move", point, 0));
        if (index === 100) layer.pixels.clearDirty();
        if (index % 4 === 3) {
          frames.shift()?.();
          if (index === 103) lateTiles = layer.pixels.dirtyTileCount;
        }
      }
      frames.shift()?.();
      runtime.pointer(event("up", path.at(-1) ?? [0, 0], 0));
      expect(report).not.toHaveBeenCalled();
      return { layer, before, lateTiles };
    }

    function layerData(): number[] {
      const layer = doc.activeLayer;
      if (layer === undefined) throw new Error("no layer");
      return [...layer.pixels.readRegion(layer.pixels.bounds).data];
    }

    it("matches the whole-stroke Pencil", () => {
      const { before, lateTiles } = strokeLive("pencil");
      // A frame late in the stroke writes only the tiles near its new samples.
      expect(lateTiles).toBeGreaterThan(0);
      expect(lateTiles).toBeLessThanOrEqual(2);
      const expected = strokePencilCpu(
        before,
        new Float32Array(path.flat()),
        BLUE,
        LayerBlendMode.normal,
      );
      expect(layerData()).toEqual([...expected.data]);
      expect(doc.history.entries.at(-1)?.name).toBe("history.pencil");
    });

    it("matches the whole-stroke Recolor, clipped to the selection", () => {
      doc.combineSelection([[0, 0, 1000, 0, 1000, 120, 0, 120]], "replace");
      const { before, lateTiles } = strokeLive("recolor");
      expect(lateTiles).toBeGreaterThan(0);
      expect(lateTiles).toBeLessThanOrEqual(2);
      const first = path[0] ?? [0, 0];
      const i = (Math.floor(first[1]) * 1200 + Math.floor(first[0])) * 4;
      const [r = 0, g = 0, b = 0, a = 0] = before.data.subarray(i, i + 4);
      const recolored = recolorStrokeCpu(before, path3, brushOptionsFor(read, "paint", BLUE, RED), {
        basis: { r, g, b, a },
        fill: BLUE,
        tolerance: 0.6,
        straight: false,
      });
      const coverage = doc.selection.mask(before.bounds);
      const expected = clipToCoverage(before, recolored, coverage);
      expect(layerData()).toEqual([...expected.data]);
      expect(layerData()).not.toEqual([...before.data]);
      expect(doc.history.entries.at(-1)?.name).toBe("history.recolor");
    });

    it.each([
      ["paintbrush", false, "history.paintbrush"],
      ["eraser", true, "history.eraser"],
    ] as const)("matches the whole-stroke %s over existing pixels", (id, erase, history) => {
      const { before, lateTiles } = strokeLive(id);
      expect(lateTiles).toBeGreaterThan(0);
      expect(lateTiles).toBeLessThanOrEqual(2);
      const options = brushOptionsFor(read, erase ? "erase" : "paint", BLUE, RED);
      const expected = strokeBrush(before, path3, options);
      expect(layerData()).toEqual([...expected.data]);
      expect(layerData()).not.toEqual([...before.data]);
      expect(doc.history.entries.at(-1)?.name).toBe(history);
    });

    it("matches the whole-stroke Clone Stamp from the same layer", () => {
      const { before, lateTiles } = strokeLive("cloneStamp", (runtime) => {
        runtime.pointer({ ...event("down", [40, 30], 0), ctrlKey: true });
        runtime.pointer({ ...event("up", [40, 30], 0), ctrlKey: true });
      });
      expect(lateTiles).toBeGreaterThan(0);
      expect(lateTiles).toBeLessThanOrEqual(2);
      const offset = cloneSourceMarker.state.offset ?? { x: 0, y: 0 };
      const layer = doc.activeLayer;
      if (layer === undefined) throw new Error("no layer");
      const source = readCloneSource({ layer, offset, snapshot: before }, before.bounds);
      const expected = cloneStrokeCpu(
        before,
        source,
        path3,
        brushOptionsFor(read, "paint", BLUE, RED),
      );
      expect(layerData()).toEqual([...expected.data]);
      expect(layerData()).not.toEqual([...before.data]);
      expect(doc.history.entries.at(-1)?.name).toBe("history.cloneStamp");
    });
  });

  it("drops a pending preview frame when the stroke is cancelled", () => {
    const frames: (() => void)[] = [];
    const host: PaintHost = {
      settings: () => settingsWith(HARD_TIP),
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return () => frames.splice(frames.indexOf(callback), 1);
      },
    };
    const runtime = builtinToolRuntime(toolNamed("paintbrush"), host);
    if (runtime === undefined) throw new Error("no runtime");
    runtime.pointer(event("down", [5, 5], 0));
    runtime.pointer(event("move", [20, 5], 0));
    runtime.cancel?.();
    expect(frames).toHaveLength(0);
    expect(pixel(doc, 15, 5)).toEqual([255, 255, 255, 255]);
  });

  it("undoes and redoes a stroke as one step", async () => {
    const runtime = runtimeFor("paintbrush");
    drag(runtime, [
      [5, 5],
      [20, 5],
    ]);
    await doc.history.undo();
    expect(pixel(doc, 10, 5)).toEqual([255, 255, 255, 255]);
    await doc.history.redo();
    expect(pixel(doc, 10, 5)).toEqual([0, 0, 0, 255]);
  });

  it("erases alpha with either button, and records an Eraser step", () => {
    const runtime = runtimeFor("eraser");
    drag(
      runtime,
      [
        [5, 5],
        [20, 5],
      ],
      2,
    );
    expect(pixel(doc, 10, 5)).toEqual([255, 255, 255, 0]);
    expect(doc.history.entries.at(-1)?.name).toBe("history.eraser");
  });

  it("draws a one-pixel pencil line in the primary color as a Pencil step", () => {
    const runtime = runtimeFor("pencil");
    drag(runtime, [
      [4, 8],
      [9, 8],
    ]);
    for (let x = 4; x <= 9; x++) expect(pixel(doc, x, 8)).toEqual([0, 0, 0, 255]);
    expect(pixel(doc, 7, 9)).toEqual([255, 255, 255, 255]);
    expect(doc.history.entries.at(-1)?.name).toBe("history.pencil");
  });

  it("records nothing for a stroke that lies wholly off the image", () => {
    const runtime = runtimeFor("paintbrush");
    const before = doc.history.entries.length;
    drag(runtime, [
      [-50, -50],
      [-40, -40],
    ]);
    expect(doc.history.entries.length).toBe(before);
    expect(doc.dirty).toBe(false);
  });

  it("clips the stroke to the selection", () => {
    doc.combineSelection([[0, 0, 10, 0, 10, 32, 0, 32]], "replace");
    const runtime = runtimeFor("paintbrush");
    drag(runtime, [
      [5, 5],
      [25, 5],
    ]);
    expect(pixel(doc, 5, 5)).toEqual([0, 0, 0, 255]);
    expect(pixel(doc, 20, 5)).toEqual([255, 255, 255, 255]);
  });

  it("ignores predicted samples and moves that come without a press", () => {
    const runtime = runtimeFor("paintbrush");
    runtime.pointer(event("move", [5, 5], -1));
    runtime.pointer(event("down", [5, 5], 0));
    runtime.pointer(event("move", [25, 5], -1, true));
    runtime.pointer(event("up", [5, 5], 0));
    expect(pixel(doc, 20, 5)).toEqual([255, 255, 255, 255]);
    expect(doc.history.entries.at(-1)?.name).toBe("history.paintbrush");
  });

  it("reports a refused memory operation as a message, not as an error", () => {
    const runtime = runtimeFor("paintbrush");
    const spy = vi.spyOn(doc, "previewLayerPixels").mockImplementation(() => {
      throw new OutOfMemoryError(10, 1);
    });
    runtime.pointer(event("down", [5, 5], 0));
    expect(notify).toHaveBeenCalledWith("edit.outOfMemory");
    expect(report).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("finishes a stroke while a session checkpoint of the document is still being written", async () => {
    const runtime = runtimeFor("paintbrush");
    runtime.pointer(event("down", [5, 5], 0));
    runtime.pointer(event("move", [10, 5], 0));
    const checkpoint = doc.checkpoint();
    runtime.pointer(event("move", [15, 5], 0));
    runtime.pointer(event("up", [20, 5], 0));
    await checkpoint;
    expect(report).not.toHaveBeenCalled();
    expect(pixel(doc, 18, 5)).toEqual([0, 0, 0, 255]);
    expect(doc.history.entries.at(-1)?.name).toBe("history.paintbrush");
  });

  it("restores the whole layer and tells the user when a preview frame fails", () => {
    const runtime = runtimeFor("paintbrush");
    const before = doc.history.entries.length;
    runtime.pointer(event("down", [5, 5], 0));
    runtime.pointer(event("move", [12, 5], 0));
    expect(pixel(doc, 10, 5)).toEqual([0, 0, 0, 255]);
    // A background job holds the document, so the next preview write is refused.
    const release = doc.history.hold();
    runtime.pointer(event("move", [25, 5], 0));
    release();

    expect(pixel(doc, 10, 5)).toEqual([255, 255, 255, 255]);
    expect(pixel(doc, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(report).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("edit.toolFailed");
    runtime.pointer(event("up", [25, 5], 0));
    expect(doc.history.entries.length).toBe(before);
    expect(pixel(doc, 20, 5)).toEqual([255, 255, 255, 255]);
  });

  describe("Recolor (TL-BRUSH-RC-01)", () => {
    const GREEN = { r: 0, g: 255, b: 0, a: 255 };
    const RECOLOR = {
      ...HARD_TIP,
      "tools.primaryColor": BLUE,
      "tools.secondaryColor": GREEN,
      "tools.tolerance": 0,
      "tools.toleranceAlphaMode": "Premultiplied",
      "tools.recolor.samplingMode": "Once",
    };

    /** Paints a solid rectangle of the active layer, as an earlier edit would. */
    function paintRect(x: number, y: number, width: number, height: number, color: typeof RED) {
      const layer = doc.activeLayer;
      if (layer === undefined) throw new Error("no active layer");
      const surface = new Surface(width, height);
      surface.fill(color);
      doc.editLayerPixels("paint", layer, rect(x, y, width, height), (pixels) => {
        pixels.writeRegion(surface, x, y);
      });
    }

    beforeEach(() => {
      paintRect(0, 0, 16, 32, RED);
    });

    it("shifts the pixels of the basis color under the stroke, as one Recolor step", () => {
      const runtime = runtimeFor("recolor", RECOLOR);
      const before = doc.history.entries.length;
      drag(runtime, [
        [2, 5],
        [12, 5],
      ]);
      expect(pixel(doc, 6, 5)).toEqual([0, 0, 255, 255]);
      expect(pixel(doc, 20, 5)).toEqual([255, 255, 255, 255]);
      expect(doc.history.entries.length).toBe(before + 1);
      expect(doc.history.entries.at(-1)?.name).toBe("history.recolor");
    });

    it("undoes a recolor as one step", async () => {
      const runtime = runtimeFor("recolor", RECOLOR);
      drag(runtime, [
        [2, 5],
        [12, 5],
      ]);
      await doc.history.undo();
      expect(pixel(doc, 6, 5)).toEqual([255, 0, 0, 255]);
    });

    it("takes the basis from the pixel under the first point with Once sampling", () => {
      const runtime = runtimeFor("recolor", RECOLOR);
      drag(runtime, [
        [20, 5],
        [10, 5],
      ]);
      expect(pixel(doc, 18, 5)).toEqual([0, 0, 255, 255]);
      expect(pixel(doc, 10, 5)).toEqual([255, 0, 0, 255]);
    });

    it("uses the secondary color as the basis with Secondary color sampling", () => {
      const runtime = runtimeFor("recolor", {
        ...RECOLOR,
        "tools.secondaryColor": RED,
        "tools.recolor.samplingMode": "SecondaryColor",
      });
      drag(runtime, [
        [20, 5],
        [10, 5],
      ]);
      expect(pixel(doc, 10, 5)).toEqual([0, 0, 255, 255]);
      expect(pixel(doc, 18, 5)).toEqual([255, 255, 255, 255]);
    });

    it("fills with the primary color under Secondary color sampling, for either button", () => {
      const runtime = runtimeFor("recolor", {
        ...RECOLOR,
        "tools.secondaryColor": RED,
        "tools.recolor.samplingMode": "SecondaryColor",
      });
      drag(
        runtime,
        [
          [20, 5],
          [10, 5],
        ],
        2,
      );
      expect(pixel(doc, 10, 5)).toEqual([0, 0, 255, 255]);
    });

    it("fills with the secondary color from the right button under Once sampling", () => {
      const runtime = runtimeFor("recolor", RECOLOR);
      drag(
        runtime,
        [
          [2, 5],
          [12, 5],
        ],
        2,
      );
      expect(pixel(doc, 6, 5)).toEqual([0, 255, 0, 255]);
    });

    it("uses the tolerance: a near shade shifts and a far one stays", () => {
      paintRect(4, 0, 4, 32, { r: 200, g: 0, b: 0, a: 255 });
      paintRect(8, 0, 8, 32, { r: 120, g: 0, b: 0, a: 255 });
      const runtime = runtimeFor("recolor", { ...RECOLOR, "tools.tolerance": 0.5 });
      drag(runtime, [
        [2, 5],
        [12, 5],
      ]);
      expect(pixel(doc, 5, 5)).toEqual([0, 0, 255, 255]);
      expect(pixel(doc, 10, 5)).toEqual([120, 0, 0, 255]);
    });

    it("records nothing for a stroke that lies wholly off the image", () => {
      const runtime = runtimeFor("recolor", RECOLOR);
      const before = doc.history.entries.length;
      drag(runtime, [
        [-50, -50],
        [-40, -40],
      ]);
      expect(doc.history.entries.length).toBe(before);
    });
  });

  describe("Clone Stamp (TL-BRUSH-CS-01)", () => {
    const CLONE = { ...HARD_TIP, "tools.primaryColor": BLACK };
    const WHITE_PIXEL = [255, 255, 255, 255];
    const RED_PIXEL = [255, 0, 0, 255];

    /** Fills a rectangle of the active layer, as an earlier edit would. */
    function fillRect(x: number, y: number, width: number, height: number, color: typeof RED) {
      const layer = doc.activeLayer;
      if (layer === undefined) throw new Error("no active layer");
      const surface = new Surface(width, height);
      surface.fill(color);
      doc.editLayerPixels("paint", layer, rect(x, y, width, height), (pixels) => {
        pixels.writeRegion(surface, x, y);
      });
    }

    /** A Ctrl+click at `point`, which sets the anchor and paints nothing. */
    function ctrlClick(runtime: ToolRuntime, point: readonly [number, number]): void {
      runtime.pointer({ ...event("down", point, 0), ctrlKey: true });
      runtime.pointer({ ...event("up", point, 0), ctrlKey: true });
    }

    beforeEach(() => {
      cloneSourceMarker.set({});
    });

    it("asks for an anchor and paints nothing while none is set", () => {
      const runtime = runtimeFor("cloneStamp", CLONE);
      const before = doc.history.entries.length;
      drag(runtime, [
        [12, 5],
        [20, 5],
      ]);
      expect(notify).toHaveBeenCalledWith("clone.noAnchor");
      expect(doc.history.entries.length).toBe(before);
      expect(pixel(doc, 12, 5)).toEqual(WHITE_PIXEL);
    });

    it("sets the anchor with Ctrl+click without painting or recording", () => {
      fillRect(0, 0, 8, 8, RED);
      const runtime = runtimeFor("cloneStamp", CLONE);
      const before = doc.history.entries.length;
      ctrlClick(runtime, [2, 2]);
      expect(doc.history.entries.length).toBe(before);
      expect(pixel(doc, 2, 2)).toEqual(RED_PIXEL);
      expect(cloneSourceMarker.state.offset).toBeUndefined();
    });

    it("fixes the offset on the first stroke and reuses it across tool switches", () => {
      fillRect(0, 0, 8, 8, RED);
      const cloner = runtimeFor("cloneStamp", CLONE);
      ctrlClick(cloner, [2, 2]);
      drag(cloner, [
        [12, 2],
        [14, 2],
      ]);
      expect(pixel(doc, 12, 2)).toEqual(RED_PIXEL);
      expect(cloneSourceMarker.state.offset).toEqual({ x: -10, y: 0 });

      fillRect(8, 8, 8, 8, BLUE);
      const later = runtimeFor("cloneStamp", CLONE);
      drag(later, [
        [20, 10],
        [22, 10],
      ]);
      expect(pixel(doc, 20, 10)).toEqual([0, 0, 255, 255]);
    });

    it("reads the source from before the stroke when a stroke grows past its first region", () => {
      doc = Document.createBlank({ width: 128, height: 32 });
      fillRect(0, 0, 4, 32, RED);
      const runtime = runtimeFor("cloneStamp", CLONE);
      ctrlClick(runtime, [0, 4]);
      drag(runtime, [
        [4, 4],
        [100, 4],
      ]);
      expect(pixel(doc, 5, 4)).toEqual(RED_PIXEL);
      expect(pixel(doc, 60, 4)).toEqual(WHITE_PIXEL);
    });

    it("applies the blend mode to the cloned pixels", () => {
      fillRect(0, 0, 8, 8, { r: 0, g: 0, b: 255, a: 128 });
      const runtime = runtimeFor("cloneStamp", { ...CLONE, "tools.blendMode": "overwrite" });
      ctrlClick(runtime, [2, 2]);
      drag(runtime, [
        [12, 2],
        [14, 2],
      ]);
      expect(pixel(doc, 12, 2)).toEqual([0, 0, 255, 128]);
    });

    it("clones with the left button only", () => {
      fillRect(0, 0, 8, 8, RED);
      const runtime = runtimeFor("cloneStamp", CLONE);
      ctrlClick(runtime, [2, 2]);
      const before = doc.history.entries.length;
      drag(
        runtime,
        [
          [12, 2],
          [14, 2],
        ],
        2,
      );
      expect(pixel(doc, 12, 2)).toEqual(WHITE_PIXEL);
      expect(doc.history.entries.length).toBe(before);
    });

    it("records one Clone Stamp step that undo reverts", async () => {
      fillRect(0, 0, 8, 8, RED);
      const runtime = runtimeFor("cloneStamp", CLONE);
      ctrlClick(runtime, [2, 2]);
      drag(runtime, [
        [12, 2],
        [14, 2],
      ]);
      expect(doc.history.entries.at(-1)?.name).toBe("history.cloneStamp");
      await doc.history.undo();
      expect(pixel(doc, 12, 2)).toEqual(WHITE_PIXEL);
    });

    it("samples the anchor's layer and paints the active one", () => {
      fillRect(0, 0, 8, 8, RED);
      const source = doc.activeLayer;
      const runtime = runtimeFor("cloneStamp", CLONE);
      ctrlClick(runtime, [2, 2]);
      const target = doc.addLayer();
      doc.setActiveLayer(target);
      drag(runtime, [
        [12, 2],
        [14, 2],
      ]);
      expect([...target.pixels.readRegion(rect(12, 2, 1, 1)).data]).toEqual(RED_PIXEL);
      expect([...(source?.pixels.readRegion(rect(12, 2, 1, 1)).data ?? [])]).toEqual(WHITE_PIXEL);
    });
  });

  describe("under engine v2", () => {
    /** A stroke channel that records calls and commits one red tile at (0, 0). */
    function fakeChannel() {
      const red = new Uint8Array(256 * 256 * 4);
      for (let i = 0; i < red.length; i += 4) red.set([255, 0, 0, 255], i);
      const calls: string[] = [];
      const samples: number[][] = [];
      const acknowledged: { tx: number; ty: number }[][] = [];
      let finish: (commit: StrokeCommit) => void = () => undefined;
      const channel: EngineStrokeChannel = {
        begin: (begin) => calls.push(`begin ${begin.layerId} ${begin.options.erase}`),
        samples: (batch) => {
          calls.push("samples");
          samples.push([...batch]);
        },
        end: () => {
          calls.push("end");
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        cancel: () => calls.push("cancel"),
        acknowledge: (_document, _store, tiles) => acknowledged.push([...tiles]),
      };
      const commit = (layerId: number) =>
        finish({ layerId, tiles: [{ tx: 0, ty: 0, pixels: red.slice() }] });
      return { channel, calls, samples, acknowledged, commit };
    }

    function v2Runtime(id: string, channel: EngineStrokeChannel, frames: (() => void)[]) {
      const host: PaintHost = {
        settings: () => settingsWith(HARD_TIP),
        document: () => doc,
        translate: (messageId) => messageId,
        notify,
        report,
        scheduleFrame: (callback) => {
          frames.push(callback);
          return () => frames.splice(frames.indexOf(callback), 1);
        },
        engineStrokes: () => channel,
      };
      const runtime = builtinToolRuntime(toolNamed(id), host);
      if (runtime === undefined) throw new Error(`no runtime for ${id}`);
      return runtime;
    }

    it("forwards samples once per frame and leaves the document alone until the commit", async () => {
      const fake = fakeChannel();
      const frames: (() => void)[] = [];
      const runtime = v2Runtime("paintbrush", fake.channel, frames);
      const notified = vi.fn();
      const unsubscribe = doc.subscribe(notified);
      const before = doc.history.entries.length;

      runtime.pointer(event("down", [5, 5], 0));
      runtime.pointer(event("move", [10, 5], 0));
      runtime.pointer(event("move", [15, 5], 0));
      expect(frames).toHaveLength(1);
      frames.shift()?.();
      expect(fake.samples).toEqual([[5, 5, 1, 10, 5, 1, 15, 5, 1]]);
      runtime.pointer(event("up", [20, 5], 0));
      expect(frames).toHaveLength(0);
      expect(fake.calls).toEqual([
        `begin ${doc.activeLayer?.id} false`,
        "samples",
        "samples",
        "end",
      ]);
      expect(notified).not.toHaveBeenCalled();
      expect(pixel(doc, 10, 5)).toEqual([255, 255, 255, 255]);
      expect(engineStrokesPending()).toBe(1);
      // Save and Undo wait for the stroke to reach the history.
      let settled = false;
      const waiting = engineStrokesSettled().then(() => {
        settled = true;
        expect(doc.history.entries.length).toBe(before + 1);
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      fake.commit(doc.activeLayer?.id ?? 0);
      await waiting;
      expect(engineStrokesPending()).toBe(0);
      expect(doc.history.entries.length).toBe(before + 1);
      expect(doc.history.entries.at(-1)?.name).toBe("history.paintbrush");
      expect(pixel(doc, 10, 5)).toEqual([255, 0, 0, 255]);
      expect(fake.acknowledged).toEqual([[{ tx: 0, ty: 0, pixels: expect.any(Uint8Array) }]]);
      await doc.history.undo();
      expect(pixel(doc, 10, 5)).toEqual([255, 255, 255, 255]);
      unsubscribe();
    });

    it("sends the Eraser too, and cancels in the engine", () => {
      const fake = fakeChannel();
      const frames: (() => void)[] = [];
      const runtime = v2Runtime("eraser", fake.channel, frames);
      runtime.pointer(event("down", [5, 5], 0));
      runtime.pointer(event("move", [10, 5], 0));
      runtime.cancel?.();
      runtime.pointer(event("up", [12, 5], 0));
      expect(frames).toHaveLength(0);
      expect(fake.calls).toEqual([`begin ${doc.activeLayer?.id} true`, "cancel"]);
    });

    it("keeps the Pencil on the main thread", () => {
      const fake = fakeChannel();
      const runtime = v2Runtime("pencil", fake.channel, []);
      drag(runtime, [
        [5, 5],
        [20, 5],
      ]);
      expect(fake.calls).toEqual([]);
      expect(doc.history.entries.at(-1)?.name).toBe("history.pencil");
    });
  });
});
