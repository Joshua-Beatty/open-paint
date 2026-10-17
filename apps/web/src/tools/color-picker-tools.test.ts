// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, rect, Surface } from "@openpaint/document";
import type { ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import { colorPickerToolRuntime } from "./color-picker-tools";
import type { PaintHost } from "./paint-tools";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };
const BLACK = { r: 0, g: 0, b: 0, a: 255 };
const WHITE = { r: 255, g: 255, b: 255, a: 255 };

/** A settings fake that keeps the values and logs every write, as the store would. */
class FakeSettings {
  readonly values = new Map<string, unknown>([
    ["tools.primaryColor", BLACK],
    ["tools.secondaryColor", WHITE],
    ["tools.sampleMode", "PointSample"],
    ["tools.sampleAllLayers", false],
    ["tools.colorPicker.clickBehavior", "NoToolSwitch"],
  ]);
  readonly writes: [string, unknown][] = [];

  get = (path: string): unknown => this.values.get(path);

  set = (path: string, value: unknown): void => {
    this.values.set(path, value);
    this.writes.push([path, value]);
  };

  onChange = () => () => undefined;
}

function event(
  type: ToolPointerEvent["type"],
  x: number,
  y: number,
  button = 0,
  ctrlKey = false,
): ToolPointerEvent {
  return {
    type,
    x,
    y,
    button,
    pressure: 1,
    shiftKey: false,
    altKey: false,
    ctrlKey,
  };
}

describe("Color Picker (TL-PICK-01)", () => {
  let doc: Document;
  let settings: FakeSettings;
  let runtime: ToolRuntime;
  const activateTool = vi.fn<(id: string) => void>();
  const previousTool = vi.fn<() => string | undefined>();
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

  function click(x: number, y: number, button = 0, ctrlKey = false): void {
    runtime.pointer(event("down", x, y, button, ctrlKey));
    runtime.pointer(event("up", x, y, button, ctrlKey));
  }

  function colorWrites(path: string): unknown[] {
    return settings.writes.filter(([written]) => written === path).map(([, value]) => value);
  }

  beforeEach(() => {
    doc = Document.createBlank({ width: 32, height: 32 });
    paint(0, 0, 16, 32, RED);
    paint(16, 0, 16, 32, BLUE);
    settings = new FakeSettings();
    const host: PaintHost = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
      activateTool,
      previousTool,
    };
    runtime = colorPickerToolRuntime(host);
    runtime.activate();
    activateTool.mockClear();
    previousTool.mockReset();
    notify.mockClear();
    report.mockClear();
  });

  it("sets the primary color from the left button and the secondary from the right", () => {
    click(4, 4);
    expect(settings.get("tools.primaryColor")).toEqual(RED);
    click(20, 4, 2);
    expect(settings.get("tools.secondaryColor")).toEqual(BLUE);
    expect(settings.get("tools.primaryColor")).toEqual(RED);
  });

  it("follows the pointer while the button is held, and records no history", () => {
    const before = doc.history.entries.length;
    runtime.pointer(event("down", 4, 4, 0));
    runtime.pointer(event("move", 20, 4, 0));
    runtime.pointer(event("up", 20, 4, 0));
    expect(colorWrites("tools.primaryColor")).toEqual([RED, BLUE]);
    expect(doc.history.entries.length).toBe(before);
  });

  it("ignores moves with no button held and predicted samples", () => {
    runtime.pointer(event("move", 20, 4, 0));
    runtime.pointer(event("down", 4, 4, 0));
    runtime.pointer({ ...event("move", 20, 4, 0), predicted: true });
    runtime.pointer(event("up", 4, 4, 0));
    expect(colorWrites("tools.primaryColor")).toEqual([RED]);
  });

  it("ignores the middle button", () => {
    click(4, 4, 1);
    expect(settings.writes).toEqual([]);
  });

  it("writes nothing when the sampled color is already the stored one", () => {
    settings.values.set("tools.primaryColor", RED);
    click(4, 4);
    expect(colorWrites("tools.primaryColor")).toEqual([]);
  });

  it("averages the sampling square, a 3 × 3 across the color edge", () => {
    settings.values.set("tools.sampleMode", "Average3x3");
    click(16, 4);
    expect(settings.get("tools.primaryColor")).toEqual({ r: 85, g: 0, b: 170, a: 255 });
  });

  it("clips the averaged square to the image at a corner", () => {
    settings.values.set("tools.sampleMode", "Average5x5");
    click(0, 0);
    expect(settings.get("tools.primaryColor")).toEqual(RED);
  });

  it("samples the active layer, which can be clear, unless Ctrl or the setting asks for the image", () => {
    const top = doc.addLayer();
    doc.setActiveLayer(top);
    click(4, 4);
    expect(settings.get("tools.primaryColor")).toEqual({ r: 0, g: 0, b: 0, a: 0 });

    click(4, 4, 0, true);
    expect(settings.get("tools.primaryColor")).toEqual(RED);

    settings.values.set("tools.primaryColor", BLACK);
    settings.values.set("tools.sampleAllLayers", true);
    click(4, 4);
    expect(settings.get("tools.primaryColor")).toEqual(RED);
  });

  it("does nothing for a point off the image", () => {
    click(-5, -5);
    expect(settings.writes).toEqual([]);
  });

  it("keeps the tool after a click by default", () => {
    click(4, 4);
    expect(activateTool).not.toHaveBeenCalled();
  });

  it("takes the Pencil after a click when asked to", () => {
    settings.values.set("tools.colorPicker.clickBehavior", "SwitchToPencilTool");
    click(4, 4);
    expect(activateTool).toHaveBeenCalledWith("pencil");
  });

  it("returns to the last tool after a click when asked to", () => {
    settings.values.set("tools.colorPicker.clickBehavior", "SwitchToLastTool");
    previousTool.mockReturnValue("eraser");
    click(4, 4);
    expect(activateTool).toHaveBeenCalledWith("eraser");
  });

  it("stays put when there is no last tool", () => {
    settings.values.set("tools.colorPicker.clickBehavior", "SwitchToLastTool");
    previousTool.mockReturnValue(undefined);
    click(4, 4);
    expect(activateTool).not.toHaveBeenCalled();
  });

  it("shows the layer cursor for the layer and another cursor for the image", () => {
    const layer = runtime.cursor?.({ canPan: false, panning: false });
    settings.values.set("tools.sampleAllLayers", true);
    const image = runtime.cursor?.({ canPan: false, panning: false });
    expect(layer).toContain("url(");
    expect(image).toContain("url(");
    expect(image).not.toBe(layer);
  });

  it("shows the image cursor while Ctrl forces an image sample, and none of its own while panning", () => {
    const view = { canPan: false, panning: false };
    const layer = runtime.cursor?.(view);
    const image = runtime.cursor?.({ ...view, ctrlKey: true });
    expect(image).not.toBe(layer);
    settings.values.set("tools.sampleAllLayers", true);
    expect(runtime.cursor?.(view)).toBe(image);
    expect(runtime.cursor?.({ ...view, panning: true })).toBeUndefined();
  });

  it("ends a drag when the tool is deactivated, so the next move samples nothing", () => {
    runtime.pointer(event("down", 4, 4, 0));
    runtime.deactivate();
    runtime.pointer(event("move", 20, 4, 0));
    expect(colorWrites("tools.primaryColor")).toEqual([RED]);
  });
});
