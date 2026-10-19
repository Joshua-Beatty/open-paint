// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import {
  Document,
  HATCH_PATTERNS,
  rect,
  rectPolygon,
  Selection,
  Surface,
} from "@openpaint/document";
import { clipToCoverage } from "@openpaint/effects";
import { bucketFillCpu } from "@openpaint/engine";
import type { ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import type { SettingChange } from "@openpaint/storage";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import { settleColorEdits } from "./color-edits";
import { paintBucketToolRuntime } from "./paint-bucket-tools";
import type { PaintHost } from "./paint-tools";
import { bindToolHistory, soloSwitcher } from "./tool-history";
import { wandHandles } from "./wand-handles";

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
      "tools.floodMode": "Local",
      "tools.tolerance": 0.5,
      "tools.toleranceAlphaMode": "Premultiplied",
      "tools.sampleAllLayers": false,
      "tools.brush.fillType": "Solid",
      "tools.brush.hatchStyle": "BackwardDiagonal",
      "tools.blendMode": "normal",
      "tools.antialiasing": false,
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
  };
}

describe("Paint Bucket (TL-BUCKET-01, TL-FRAME-01, TL-FRAME-02)", () => {
  let doc: Document;
  let settings: FakeSettings;
  let runtime: ToolRuntime;
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

  function click(x: number, y: number, button = 0, modifiers = {}): void {
    runtime.pointer(event("down", x, y, button, modifiers));
    runtime.pointer(event("up", x, y, button, modifiers));
  }

  /** Waits for the fill, and for the flood to finish, so the next pointer input is accepted. */
  async function settle(check: () => void): Promise<void> {
    await vi.waitFor(check);
    await vi.waitFor(() => expect(wandHandles.state.busy).toBeUndefined());
  }

  let host: PaintHost;

  beforeEach(() => {
    doc = Document.createBlank({ width: 32, height: 32 });
    paint(0, 0, 16, 32, RED);
    paint(16, 0, 16, 32, BLUE);
    settings = new FakeSettings();
    host = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
    };
    runtime = paintBucketToolRuntime(host);
    runtime.activate();
    bindToolHistory(doc, soloSwitcher("paintBucket", runtime));
    notify.mockClear();
    report.mockClear();
  });

  afterEach(() => {
    runtime.deactivate();
  });

  it("fills the contiguous region with the primary color, and Finish keeps it", async () => {
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));
    expect(pixel(20, 1)).toEqual(BLUE);
    expect(doc.history.undoName).toBe("history.paintBucket");
    expect(runtime.hasPending?.()).toBe(true);

    runtime.commit?.();
    expect(runtime.hasPending?.()).toBe(false);
    expect(doc.history.undoName).toBe("history.finishPaintBucket");
    expect(pixel(1, 1)).toEqual(GREEN);
  });

  it("shows a crosshair, and a hand on the origin handle (TL-FRAME-06)", async () => {
    const view = { canPan: false, panning: false };
    const cursorAt = (x: number, y: number) => {
      runtime.pointer(event("move", x, y));
      return runtime.cursor?.(view);
    };
    expect(cursorAt(1, 1)).toBe("crosshair");
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));
    expect(cursorAt(1.5, 1.5)).toBe("grab");
    expect(cursorAt(20, 20)).toBe("crosshair");
    runtime.pointer(event("down", 1.5, 1.5));
    expect(cursorAt(4, 4)).toBe("grabbing");
    runtime.cancel?.();
    expect(runtime.cursor?.({ ...view, panning: true })).toBeUndefined();
  });

  it("fills with the secondary color for the right button", async () => {
    click(1, 1, 2);
    await settle(() => expect(pixel(1, 1)).toEqual(YELLOW));
    expect(pixel(1, 31)).toEqual(YELLOW);
  });

  it("fills the pending stencil in a new color, recorded as one Change Color step (TL-FRAME-01)", async () => {
    click(1, 1, 2);
    await settle(() => expect(pixel(1, 1)).toEqual(YELLOW));
    const before = doc.history.entries.length;
    settings.set("tools.secondaryColor", RED);
    settings.set("tools.secondaryColor", BLUE);
    // Shown at once from the kept stencil, with no new flood and no history item yet.
    expect(pixel(1, 1)).toEqual(BLUE);
    expect(pixel(1, 31)).toEqual(BLUE);
    expect(pixel(20, 1)).toEqual(BLUE);
    expect(doc.history.entries.length).toBe(before);
    settleColorEdits();
    expect(doc.history.undoName).toBe("history.changeColor");
    expect(doc.history.entries.length).toBe(before + 1);
    expect(runtime.hasPending?.()).toBe(true);

    // Undo returns the fill to its own color, and it stays pending.
    expect(await doc.history.undo()).toBe(true);
    expect(pixel(1, 1)).toEqual(YELLOW);
    expect(runtime.hasPending?.()).toBe(true);
    settings.set("tools.secondaryColor", GREEN);
    settleColorEdits();
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));
    expect(doc.history.undoName).toBe("history.changeColor");
    runtime.commit?.();
    expect(doc.history.undoName).toBe("history.finishPaintBucket");
    expect(pixel(1, 1)).toEqual(GREEN);
  });

  it("Shift forces a Global fill, which takes every matching pixel", async () => {
    settings.set("tools.tolerance", 0);
    paint(20, 0, 1, 1, RED);
    click(1, 1, 0, { shift: true });
    await settle(() => expect(pixel(20, 0)).toEqual(GREEN));
    expect(pixel(1, 1)).toEqual(GREEN);
    expect(pixel(20, 1)).toEqual(BLUE);
  });

  it("a contiguous fill at zero tolerance leaves a separate matching pixel alone", async () => {
    settings.set("tools.tolerance", 0);
    paint(20, 0, 1, 1, RED);
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));
    expect(pixel(20, 0)).toEqual(RED);
  });

  it("changing the fill re-renders from the layer as one Change Fill step, without stacking", async () => {
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));

    settings.set("tools.brush.fillType", "Hatch");
    settings.set("tools.brush.hatchStyle", "Horizontal");
    await settle(() => expect(pixel(1, 1)).toEqual(YELLOW));
    expect(pixel(1, 0)).toEqual(GREEN);
    expect(pixel(1, 4)).toEqual(GREEN);
    expect(pixel(20, 1)).toEqual(BLUE);
    expect(doc.history.undoName).toBe("history.changeFill");

    expect(await doc.history.undo()).toBe(true);
    expect(pixel(1, 1)).toEqual(GREEN);
    expect(pixel(1, 0)).toEqual(GREEN);
  });

  it("fills only the stencil's area, with the same pixels as a whole-layer fill (L2)", async () => {
    doc.replaceSelection(new Selection([[3.5, 2.25, 30.5, 6, 25, 29.75]]), "select");
    settings.set("tools.antialiasing", true);
    settings.set("tools.brush.fillType", "Hatch");
    settings.set("tools.brush.hatchStyle", "DiagonalCross");
    settings.set("tools.blendMode", "multiply");
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    const before = layer.pixels.readRegion(layer.pixels.bounds);
    // The blue half is the stencil. The fill works over x = 8 to 31: one pixel more for the
    // feather, grown back to the hatch grid.
    const mask = new Uint8Array(32 * 32);
    for (let y = 0; y < 32; y++) mask.fill(255, y * 32 + 16, y * 32 + 32);
    const filled = bucketFillCpu(before, mask, {
      antialias: true,
      blend: 1,
      hatch: HATCH_PATTERNS.rank("DiagonalCross"),
      color: GREEN,
      background: YELLOW,
    });
    const expected = clipToCoverage(before, filled, doc.selection.mask(before.bounds));

    click(21, 5);
    await settle(() => expect(doc.history.undoName).toBe("history.paintBucket"));
    expect([...layer.pixels.readRegion(layer.pixels.bounds).data]).toEqual([...expected.data]);
  });

  it("a tolerance change recomputes the pending fill", async () => {
    click(1, 1);
    await settle(() => expect(pixel(20, 1)).toEqual(BLUE));

    settings.set("tools.tolerance", 1);
    await settle(() => expect(pixel(20, 1)).toEqual(GREEN));
    expect(doc.history.undoName).toBe("history.changeTolerance");
    expect(pixel(1, 1)).toEqual(GREEN);
  });

  it("dragging the origin handle re-seeds the flood as one Move Origin step", async () => {
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));

    runtime.pointer(event("down", 1.5, 1.5));
    runtime.pointer(event("move", 20.5, 1.5));
    runtime.pointer(event("up", 20.5, 1.5));
    await settle(() => expect(pixel(20, 1)).toEqual(GREEN));
    expect(pixel(1, 1)).toEqual(RED);
    expect(doc.history.undoName).toBe("history.moveOrigin");
    expect(wandHandles.state.seed).toEqual({ x: 20, y: 1 });
  });

  it("undo takes the fill back, and redo brings it forward, pending again", async () => {
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));

    expect(await doc.history.undo()).toBe(true);
    expect(pixel(1, 1)).toEqual(RED);
    expect(runtime.hasPending?.()).toBe(false);

    expect(await doc.history.redo()).toBe(true);
    expect(pixel(1, 1)).toEqual(GREEN);
    expect(runtime.hasPending?.()).toBe(true);
    expect(doc.history.undoName).toBe("history.paintBucket");
  });

  it("undo of a Change Fill restores the fill setting, and the fill stays pending", async () => {
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));
    settings.set("tools.brush.fillType", "Hatch");
    settings.set("tools.brush.hatchStyle", "Horizontal");
    await settle(() => expect(pixel(1, 1)).toEqual(YELLOW));

    expect(await doc.history.undo()).toBe(true);
    expect(settings.get("tools.brush.fillType")).toBe("Solid");
    expect(pixel(1, 1)).toEqual(GREEN);
    expect(runtime.hasPending?.()).toBe(true);

    expect(await doc.history.redo()).toBe(true);
    expect(settings.get("tools.brush.fillType")).toBe("Hatch");
    expect(pixel(1, 1)).toEqual(YELLOW);
    expect(runtime.hasPending?.()).toBe(true);
  });

  it("undo after Finish brings the fill back as a Dirty fill that can be edited again", async () => {
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));
    runtime.commit?.();
    expect(runtime.hasPending?.()).toBe(false);

    expect(await doc.history.undo()).toBe(true);
    expect(runtime.hasPending?.()).toBe(true);
    expect(wandHandles.state.seed).toEqual({ x: 1, y: 1 });

    settings.set("tools.tolerance", 1);
    await settle(() => expect(pixel(20, 1)).toEqual(GREEN));
    expect(doc.history.undoName).toBe("history.changeTolerance");
  });

  it("a new runtime (after a tool switch) takes up a finished fill and floods the layer before it", async () => {
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));
    runtime.commit?.();
    runtime.deactivate();
    runtime = paintBucketToolRuntime(host);
    runtime.activate();
    bindToolHistory(doc, soloSwitcher("paintBucket", runtime));

    expect(await doc.history.undo()).toBe(true);
    expect(runtime.hasPending?.()).toBe(true);
    expect(wandHandles.state.seed).toEqual({ x: 1, y: 1 });
    runtime.pointer(event("down", 1.5, 1.5));
    runtime.pointer(event("move", 20, 1));
    runtime.pointer(event("up", 20, 1));
    await settle(() => expect(pixel(20, 1)).toEqual(GREEN));
    expect(doc.history.undoName).toBe("history.moveOrigin");
    // The flood reads the layer before the fill: the left half is red again.
    expect(pixel(1, 1)).toEqual(RED);
  });

  it("an edit that is not one of the fill's steps ends the pending fill", async () => {
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));

    paint(20, 20, 1, 1, RED);
    expect(runtime.hasPending?.()).toBe(false);
  });

  it("a click elsewhere commits the pending fill first, then fills the new region", async () => {
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));

    click(20, 20);
    await settle(() => expect(pixel(20, 20)).toEqual(GREEN));
    const names = doc.history.entries.map((entry) => entry.name).slice(-3);
    expect(names).toEqual([
      "history.paintBucket",
      "history.finishPaintBucket",
      "history.paintBucket",
    ]);
  });

  it("clips the fill to the selection", async () => {
    doc.replaceSelection(new Selection([rectPolygon(rect(0, 0, 4, 32))]), "select");
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));
    expect(pixel(3, 31)).toEqual(GREEN);
    expect(pixel(10, 1)).toEqual(RED);
  });

  it("a click off the image does nothing", () => {
    click(-1, 5);
    expect(runtime.hasPending?.()).toBe(false);
    expect(doc.history.undoName).toBe("paint");
  });

  it("a cancelled origin drag records nothing", async () => {
    click(1, 1);
    await settle(() => expect(pixel(1, 1)).toEqual(GREEN));
    const before = doc.history.undoName;

    runtime.pointer(event("down", 1.5, 1.5));
    runtime.cancel?.();
    expect(doc.history.undoName).toBe(before);
    expect(runtime.hasPending?.()).toBe(true);
  });
});
