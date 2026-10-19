// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, type Layer, readOverlaid, rect } from "@openpaint/document";
import type { ToolPointerEvent } from "@openpaint/extension-api";
import type { SettingChange } from "@openpaint/storage";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import { finishOnLayerSwitch } from "./finish-on-switch";
import { gradientHandles } from "./gradient-handles";
import { gradientToolRuntime } from "./gradient-tools";
import { lineCurveHandles } from "./line-curve-handles";
import { lineCurveToolRuntime } from "./line-curve-tools";
import type { PaintHost } from "./paint-tools";
import { TOOL_REGISTRY } from "./roster";
import { shapeHandles } from "./shape-handles";
import { shapeToolRuntime } from "./shape-tools";
import { ToolController } from "./tool-controller";
import { bindToolHistory } from "./tool-history";
import { transformFrame } from "./transform-frame";

function shownPixel(layer: Layer | undefined, x: number, y: number) {
  if (layer === undefined) throw new Error("no layer");
  return readOverlaid(layer.pixels, layer.overlay, rect(x, y, 1, 1)).getPixel(0, 0);
}

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const GREEN = { r: 0, g: 255, b: 0, a: 255 };
const PAPER = { r: 255, g: 255, b: 255, a: 255 };

class FakeSettings {
  readonly values: Record<string, unknown> = {
    "tools.activeTool": "shapes",
    "tools.primaryColor": GREEN,
    "tools.secondaryColor": { r: 255, g: 255, b: 0, a: 255 },
    "tools.brush.size": 2,
    "tools.antialiasing": false,
    "tools.shapes.shape": { name: "rectangle" },
    "tools.shapes.drawType": "Outline",
    "tools.shapes.curveType": "Straight",
  };
  readonly #listeners = new Set<(change: SettingChange) => void>();
  get = (path: string): unknown => this.values[path];
  set = (path: string, value: unknown): void => {
    this.values[path] = value;
    for (const listener of [...this.#listeners]) {
      listener({ path, value: value as SettingChange["value"], source: "local" });
    }
  };
  onChange = (listener: (change: SettingChange) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

function event(type: ToolPointerEvent["type"], x: number, y: number): ToolPointerEvent {
  return { type, x, y, button: 0, pressure: 1, shiftKey: false, altKey: false, ctrlKey: false };
}

describe("tool history (TL-FRAME-01, owner request: reversible from the start)", () => {
  let doc: Document;
  let settings: FakeSettings;
  let controller: ToolController;
  let stop: () => void;
  const report = vi.fn();

  function drag(from: [number, number], to: [number, number]): void {
    const runtime = controller.runtime();
    runtime?.pointer(event("down", ...from));
    runtime?.pointer(event("move", ...to));
    runtime?.pointer(event("up", ...to));
  }

  function pixel(x: number, y: number) {
    return shownPixel(doc.activeLayer, x, y);
  }

  beforeEach(() => {
    doc = Document.createBlank({ width: 60, height: 60 });
    settings = new FakeSettings();
    const host: PaintHost = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (id) => id,
      notify: vi.fn(),
      report,
    };
    controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: (tool) => {
        if (tool.id === "shapes") return shapeToolRuntime(host);
        if (tool.id === "lineCurve") return lineCurveToolRuntime(host);
        if (tool.id === "gradient") return gradientToolRuntime(host);
        return undefined;
      },
    });
    controller.attach(settings as unknown as ColorSettings);
    stop = bindToolHistory(doc, controller, report);
    report.mockClear();
  });

  afterEach(() => {
    stop();
    controller.activate("pencil");
    shapeHandles.set({});
    lineCurveHandles.set({});
    gradientHandles.set({});
    transformFrame.set(undefined);
  });

  it("switches back to the tool of a finished result on undo, and redo finishes it there", async () => {
    drag([5, 5], [25, 15]);
    controller.activate("lineCurve");
    expect(doc.history.undoName).toBe("history.finishShape");
    drag([5.5, 40.5], [40.5, 40.5]);
    controller.activate("pencil");
    expect(doc.history.undoName).toBe("history.finishLineCurve");

    await doc.history.undo();
    expect(controller.active.id).toBe("lineCurve");
    expect(controller.runtime()?.hasPending?.()).toBe(true);
    expect(lineCurveHandles.state.end).toEqual({ x: 40.5, y: 40.5 });

    await doc.history.undo(); // Draw Line / Curve
    expect(controller.runtime()?.hasPending?.()).toBe(false);
    await doc.history.undo(); // Finish Rectangle
    expect(controller.active.id).toBe("shapes");
    expect(controller.runtime()?.hasPending?.()).toBe(true);
    expect(transformFrame.state).toBeDefined();

    // Redo goes the same way: redo of the line's drawing switches to Line / Curve.
    await doc.history.redo(); // Finish Rectangle
    expect(controller.runtime()?.hasPending?.()).toBe(false);
    await doc.history.redo(); // Draw Line / Curve
    expect(controller.active.id).toBe("lineCurve");
    expect(controller.runtime()?.hasPending?.()).toBe(true);
    await doc.history.redo(); // Finish Line / Curve
    expect(controller.runtime()?.hasPending?.()).toBe(false);
    expect(pixel(20, 40)).toEqual(GREEN);
    expect(report).not.toHaveBeenCalled();
  });

  it("an edit after re-entry records a normal step on the result's tool", async () => {
    drag([5, 5], [45, 35]);
    controller.activate("gradient");
    await doc.history.undo();
    expect(controller.active.id).toBe("shapes");
    drag([12, 28], [22, 28]);
    expect(doc.history.undoName).toBe("history.adjustShape");
    expect(doc.history.canRedo).toBe(false);
    expect(pixel(15, 10)).toEqual(GREEN);
    expect(pixel(5, 10)).toEqual(PAPER);
  });

  it("makes the result's layer active again on undo, after a layer switch finished it", async () => {
    const bottom = doc.activeLayer;
    if (bottom === undefined) throw new Error("no layer");
    const top = doc.addLayer();
    doc.setActiveLayer(bottom);
    const stopSwitch = finishOnLayerSwitch(doc, () => controller.finishPending());
    drag([5, 5], [45, 35]);
    doc.setActiveLayer(top);
    expect(doc.history.undoName).toBe("history.finishShape");
    await doc.history.undo();
    expect(doc.activeLayer).toBe(bottom);
    expect(controller.runtime()?.hasPending?.()).toBe(true);
    // An edit lands on the result's layer, not on the one that was active.
    drag([12, 28], [12, 48]);
    expect(shownPixel(bottom, 5, 50)).toEqual(GREEN);
    expect(shownPixel(top, 5, 50).a).toBe(0);
    stopSwitch();
  });

  it("cancels a drag in progress before an undo", async () => {
    drag([5, 5], [25, 15]);
    const runtime = controller.runtime();
    controller.setPointerHeld(true);
    runtime?.pointer(event("down", 12, 8));
    runtime?.pointer(event("move", 30, 30));
    await doc.history.undo();
    controller.setPointerHeld(false);
    runtime?.pointer(event("up", 30, 30));
    expect(controller.runtime()?.hasPending?.()).toBe(false);
    expect(pixel(5, 10)).toEqual(PAPER);
    expect(pixel(30, 30)).toEqual(PAPER);
    expect(doc.history.canRedo).toBe(true);
  });

  it("a command finishes the pending result first, and undoing both re-enters it", async () => {
    const stopGuard = doc.setChangeGuard(() => controller.finishBeforeChange());
    drag([5, 5], [25, 15]);
    doc.selectAll();
    expect(doc.history.entries.slice(-3).map((entry) => entry.name)).toEqual([
      "history.drawShape",
      "history.finishShape",
      "Select All",
    ]);
    expect(controller.runtime()?.hasPending?.()).toBe(false);
    await doc.history.undo();
    expect(controller.runtime()?.hasPending?.()).toBe(false);
    await doc.history.undo();
    expect(controller.runtime()?.hasPending?.()).toBe(true);
    stopGuard();
  });

  it("lets go of a result another item replaced, and takes it up again when that item is undone", async () => {
    drag([5, 5], [25, 15]);
    doc.selectAll();
    expect(controller.runtime()?.hasPending?.()).toBe(false);
    await doc.history.undo();
    expect(controller.runtime()?.hasPending?.()).toBe(true);
    expect(transformFrame.state).toBeDefined();
  });
});
