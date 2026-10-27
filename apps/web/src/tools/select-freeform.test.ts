// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, rect, rectPolygon, Surface } from "@openpaint/document";
import type { ToolDescriptor, ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import type { PaintHost } from "./paint-tools";
import { TOOL_REGISTRY } from "./roster";
import { selectionToolRuntime } from "./select-tools";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };

/** The Selection and Magic Wand defaults, keyed by their full `tools.` path. */
const DEFAULTS: Record<string, unknown> = {
  "tools.selection.combineMode": "Replace",
  "tools.floodMode": "Local",
  "tools.tolerance": 0.5,
  "tools.toleranceAlphaMode": "Premultiplied",
  "tools.sampleAllLayers": false,
};

function settingsWith(values: Record<string, unknown>): ColorSettings {
  return {
    get: (path: string) => values[path],
    set: () => undefined,
    onChange: () => () => undefined,
  } as unknown as ColorSettings;
}

function toolNamed(id: string): ToolDescriptor {
  const tool = TOOL_REGISTRY.get(id);
  if (tool === undefined) throw new Error(`no tool ${id}`);
  return tool;
}

function event(
  type: ToolPointerEvent["type"],
  x: number,
  y: number,
  button = 0,
  modifiers: { readonly shift?: boolean; readonly ctrl?: boolean; readonly alt?: boolean } = {},
): ToolPointerEvent {
  return {
    type,
    x,
    y,
    button,
    pressure: 1,
    shiftKey: modifiers.shift === true,
    altKey: modifiers.alt === true,
    ctrlKey: modifiers.ctrl === true,
    // At 10 CSS pixels per canvas pixel, even a one-pixel drag leaves the click dead zone.
    clientX: x * 10,
    clientY: y * 10,
  };
}

describe("Lasso Select (TL-SEL-LASSO-01)", () => {
  let doc: Document;
  const notify = vi.fn();
  const report = vi.fn();

  function runtimeFor(values: Record<string, unknown> = {}): ToolRuntime {
    const host: PaintHost = {
      settings: () => settingsWith({ ...DEFAULTS, ...values }),
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
    };
    const runtime = selectionToolRuntime(toolNamed("lassoSelect"), host);
    if (runtime === undefined) throw new Error("no lasso runtime");
    runtime.activate();
    return runtime;
  }

  function drag(
    runtime: ToolRuntime,
    path: readonly (readonly [number, number])[],
    button = 0,
    modifiers: { readonly shift?: boolean; readonly ctrl?: boolean; readonly alt?: boolean } = {},
  ): void {
    const [first, ...rest] = path;
    if (first === undefined) return;
    runtime.pointer(event("down", first[0], first[1], button, modifiers));
    for (const [x, y] of rest.slice(0, -1)) runtime.pointer(event("move", x, y, button, modifiers));
    const [lx, ly] = rest.at(-1) ?? first;
    runtime.pointer(event("up", lx, ly, button, modifiers));
  }

  beforeEach(() => {
    doc = Document.createBlank({ width: 32, height: 32 });
    notify.mockClear();
    report.mockClear();
  });

  it("selects the area the freeform path encloses, closed between its last and first points", () => {
    drag(runtimeFor(), [
      [2, 2],
      [10, 2],
      [2, 10],
    ]);
    expect(doc.selection.bounds()).toEqual(rect(2, 2, 8, 8));
    expect(doc.selection.area()).toBeCloseTo(32, 6);
    expect(doc.history.undoName).toBe("history.lassoSelect");
  });

  it("clips the path to the image", () => {
    drag(runtimeFor(), [
      [-4, -4],
      [40, -4],
      [-4, 40],
    ]);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 32, 32));
    expect(doc.selection.area()).toBeCloseTo(632, 6);
  });

  it("previews the path over the selection before release, without history", () => {
    const runtime = runtimeFor();
    const undoBefore = doc.history.undoName;
    runtime.pointer(event("down", 2, 2));
    runtime.pointer(event("move", 10, 2));
    runtime.pointer(event("move", 2, 10));
    expect(doc.selection.area()).toBeCloseTo(32, 6);
    expect(doc.history.undoName).toBe(undoBefore);
    runtime.cancel?.();
    expect(doc.selection.isEmpty).toBe(true);
  });

  it("restores the selection the drag started with when it is canceled", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    const runtime = runtimeFor();
    runtime.pointer(event("down", 10, 10));
    runtime.pointer(event("move", 20, 10));
    runtime.pointer(event("move", 10, 20));
    runtime.deactivate();
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 4, 4));
  });

  it("gives an area-less path, such as a straight line, no selection and deselects in Replace", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    drag(runtimeFor(), [
      [1, 1],
      [5, 1],
      [9, 1],
    ]);
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.history.undoName).toBe("Deselect");
  });

  it("deselects on a click in Replace mode", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    drag(runtimeFor(), [[6, 6]]);
    expect(doc.selection.isEmpty).toBe(true);
  });

  it("records nothing for a click in Add mode", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    const before = doc.history.undoName;
    drag(runtimeFor(), [[6, 6]], 0, { ctrl: true });
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 4, 4));
    expect(doc.history.undoName).toBe(before);
  });

  it("adds the enclosed area with Ctrl and subtracts it with Alt", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    drag(
      runtimeFor(),
      [
        [10, 10],
        [20, 10],
        [10, 20],
      ],
      0,
      { ctrl: true },
    );
    expect(doc.selection.area()).toBeCloseTo(16 + 50, 6);

    drag(
      runtimeFor(),
      [
        [0, 0],
        [4, 0],
        [0, 4],
      ],
      0,
      { alt: true },
    );
    expect(doc.selection.area()).toBeCloseTo(16 + 50 - 8, 6);
  });

  it("moves the whole path when a second button is pressed during the drag", () => {
    const runtime = runtimeFor();
    runtime.pointer(event("down", 2, 2));
    runtime.pointer(event("move", 10, 2));
    runtime.pointer(event("move", 2, 10));
    runtime.pointer(event("down", 2, 10, 2));
    runtime.pointer(event("move", 4, 12, 2));
    runtime.pointer(event("up", 4, 12, 2));
    expect(doc.selection.bounds()).toEqual(rect(4, 4, 8, 8));
  });

  it("snaps each pointer sample to its nearest pixel corner", () => {
    drag(runtimeFor(), [
      [2.4, 1.6],
      [9.6, 2.3],
      [2.2, 9.7],
    ]);
    expect(doc.selection.polygons).toHaveLength(1);
    const ring = doc.selection.polygons[0] ?? [];
    expect([...ring].sort((a, b) => a - b)).toEqual([2, 2, 2, 2, 10, 10]);
    expect(doc.selection.area()).toBe(32);
  });

  it("draws a slow straight drag at any slope as one edge between pixel corners", () => {
    // Many samples along the run from (2, 2) to (9, 5), a slope of 3 in 7, with sub-pixel jitter.
    const path: [number, number][] = [];
    for (let i = 0; i <= 70; i++) {
      const jitter = ((i * 7) % 5) / 25 - 0.08;
      path.push([2 + (7 * i) / 70 + jitter, 2 + (3 * i) / 70 - jitter]);
    }
    for (let i = 1; i <= 30; i++) path.push([9 - (7 * i) / 30, 5 + (5 * i) / 30]);
    drag(runtimeFor(), path);
    const ring = doc.selection.polygons[0] ?? [];
    expect(doc.selection.polygons).toHaveLength(1);
    expect(ring.every((value) => Number.isInteger(value))).toBe(true);
    // The triangle (2, 2), (9, 5), (2, 10): three corners, the slopes kept as single edges.
    expect(ring).toHaveLength(6);
    expect(doc.selection.area()).toBe(28);
  });

  it("keeps every vertex of a freehand path on a pixel corner", () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 200; i++) {
      const t = (i / 200) * 2 * Math.PI;
      path.push([16 + 11 * Math.cos(t) + Math.sin(7 * t), 16 + 8 * Math.sin(t) + 0.37]);
    }
    drag(runtimeFor(), path);
    expect(doc.selection.isEmpty).toBe(false);
    for (const ring of doc.selection.polygons) {
      expect(ring.every((value) => Number.isInteger(value))).toBe(true);
    }
  });

  it("ignores the other buttons", () => {
    drag(
      runtimeFor(),
      [
        [2, 2],
        [10, 2],
        [2, 10],
      ],
      1,
    );
    expect(doc.selection.isEmpty).toBe(true);
  });

  it("is the lasso runtime only for the lasso tool", () => {
    const host: PaintHost = {
      settings: () => null,
      document: () => undefined,
      translate: (id) => id,
      notify: () => undefined,
      report: () => undefined,
    };
    expect(selectionToolRuntime(toolNamed("lassoSelect"), host)).toBeDefined();
    expect(selectionToolRuntime(toolNamed("magicWand"), host)).toBeDefined();
    expect(selectionToolRuntime(toolNamed("zoom"), host)).toBeUndefined();
  });
});

describe("Magic Wand (TL-SEL-WAND-01, TL-ALG-TOL)", () => {
  let doc: Document;
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

  function wandAt(
    values: Record<string, unknown> = {},
    x = 1,
    y = 1,
    modifiers: { readonly shift?: boolean; readonly ctrl?: boolean; readonly alt?: boolean } = {},
  ): void {
    const stored = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name.startsWith("tools.") ? name : `tools.${name}`,
        value,
      ]),
    );
    const host: PaintHost = {
      settings: () => settingsWith({ ...DEFAULTS, ...stored }),
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
    };
    const runtime = selectionToolRuntime(toolNamed("magicWand"), host);
    if (runtime === undefined) throw new Error("no wand runtime");
    runtime.activate();
    runtime.pointer(event("down", x, y, 0, modifiers));
    runtime.pointer(event("up", x, y, 0, modifiers));
  }

  async function settle(check: () => void): Promise<void> {
    await vi.waitFor(check);
  }

  beforeEach(() => {
    doc = Document.createBlank({ width: 8, height: 8 });
    notify.mockClear();
    report.mockClear();
    paint(0, 0, 4, 8, RED);
    paint(4, 0, 4, 8, BLUE);
  });

  it("selects the contiguous region of similar color under the click", async () => {
    wandAt();
    await settle(() => expect(doc.selection.area()).toBe(32));
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 4, 8));
    expect(doc.history.undoName).toBe("history.magicWand");
  });

  it("takes every matching pixel in Global flood mode, and Shift forces Global for one click", async () => {
    paint(4, 0, 4, 8, RED);
    paint(0, 0, 2, 2, BLUE);
    paint(6, 6, 2, 2, BLUE);
    wandAt({ "tools.floodMode": "Global" }, 6, 6);
    await settle(() => expect(doc.selection.area()).toBe(4 + 4));
    doc.deselect();

    wandAt({}, 6, 6);
    await settle(() => expect(doc.selection.area()).toBe(4));
    doc.deselect();

    wandAt({}, 6, 6, { shift: true });
    await settle(() => expect(doc.selection.area()).toBe(4 + 4));
  });

  it("selects everything at tolerance 100 %", async () => {
    wandAt({ tolerance: 1 });
    await settle(() => expect(doc.selection.area()).toBe(64));
  });

  it("selects only identical pixels at tolerance 0 %", async () => {
    paint(0, 0, 1, 1, { r: 254, g: 0, b: 0, a: 255 });
    wandAt({ tolerance: 0 }, 1, 1);
    await settle(() => expect(doc.selection.area()).toBe(31));
    doc.deselect();

    wandAt({ tolerance: 0 }, 0, 0);
    await settle(() => expect(doc.selection.area()).toBe(1));
  });

  it("samples the active layer, or the flattened image with Sample all layers", async () => {
    // The base layer is red. The active layer is transparent on the right and red on the left.
    paint(0, 0, 8, 8, RED);
    const base = doc.activeLayer;
    doc.addLayer();
    paint(0, 0, 4, 8, RED);
    const top = doc.activeLayer;
    expect(top).not.toBe(base);

    wandAt({ tolerance: 0 }, 6, 0);
    await settle(() => expect(doc.selection.area()).toBe(32));
    doc.deselect();

    wandAt({ tolerance: 0, sampleAllLayers: true }, 6, 0);
    await settle(() => expect(doc.selection.area()).toBe(64));
  });

  it("does nothing for a click off the image and records no history", async () => {
    const before = doc.history.undoName;
    wandAt({}, 20, 20);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(doc.history.undoName).toBe(before);
    expect(doc.selection.isEmpty).toBe(true);
  });

  it("combines with the selection by the Selection Mode", async () => {
    wandAt({ "tools.selection.combineMode": "Union" }, 1, 1);
    await settle(() => expect(doc.selection.area()).toBe(32));
    wandAt({ "tools.selection.combineMode": "Union" }, 6, 1);
    await settle(() => expect(doc.selection.area()).toBe(64));
  });

  it("keeps the wand's history name separate from the lasso's", async () => {
    wandAt({}, 1, 1);
    await settle(() => expect(doc.history.undoName).toBe("history.magicWand"));
    expect(report).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
