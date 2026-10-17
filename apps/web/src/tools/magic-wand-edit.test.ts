// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, rect, rectPolygon, Surface } from "@openpaint/document";
import type { ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import type { SettingChange } from "@openpaint/storage";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import { magicWandToolRuntime } from "./magic-wand-tools";
import type { PaintHost } from "./paint-tools";
import { wandHandles } from "./wand-handles";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = { r: 255, g: 0, b: 0, a: 255 };
const BLUE = { r: 0, g: 0, b: 255, a: 255 };

/** A settings fake that reports its own changes to the listeners, as the store does. */
class FakeSettings {
  readonly values: Record<string, unknown>;
  readonly #listeners = new Set<(change: SettingChange) => void>();

  constructor() {
    this.values = {
      "tools.selection.combineMode": "Replace",
      "tools.floodMode": "Local",
      "tools.tolerance": 0.5,
      "tools.toleranceAlphaMode": "Premultiplied",
      "tools.sampleAllLayers": false,
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
  modifiers: { readonly shift?: boolean; readonly ctrl?: boolean } = {},
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
    // At 10 CSS pixels per canvas pixel, even a one-pixel drag leaves the click dead zone.
    clientX: x * 10,
    clientY: y * 10,
  };
}

describe("Magic Wand editing (TL-SEL-WAND-01, TL-FRAME-01, TL-FRAME-02)", () => {
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

  function click(x: number, y: number, button = 0, modifiers = {}): void {
    runtime.pointer(event("down", x, y, button, modifiers));
    runtime.pointer(event("up", x, y, button, modifiers));
  }

  /** Waits for the result, and for the flood to finish, so the next pointer input is accepted. */
  async function settle(check: () => void): Promise<void> {
    await vi.waitFor(check);
    await vi.waitFor(() => expect(wandHandles.state.busy).toBeUndefined());
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
    };
    runtime = magicWandToolRuntime(host);
    runtime.activate();
    notify.mockClear();
    report.mockClear();
  });

  afterEach(() => {
    runtime.deactivate();
  });

  it("keeps a click's result pending until it is committed as Finish Magic Wand", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));
    await settle(() => expect(wandHandles.state.busy).toBeUndefined());
    expect(runtime.hasPending?.()).toBe(true);

    runtime.commit?.();
    expect(runtime.hasPending?.()).toBe(false);
    expect(doc.history.undoName).toBe("history.finishMagicWand");
    expect(doc.selection.area()).toBe(512);
  });

  it("recomputes the pending result when the tolerance changes, as one history step", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));

    settings.set("tools.tolerance", 1);
    await settle(() => expect(doc.selection.area()).toBe(1024));
    expect(doc.history.undoName).toBe("history.changeTolerance");

    expect(await doc.history.undo()).toBe(true);
    expect(doc.selection.area()).toBe(512);
  });

  it("samples the layer once per session while its pixels stay the same (L9)", async () => {
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    const reads = vi.spyOn(layer.pixels, "readRegion");
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));
    settings.set("tools.tolerance", 1);
    await settle(() => expect(doc.selection.area()).toBe(1024));
    settings.set("tools.tolerance", 0.5);
    await settle(() => expect(doc.selection.area()).toBe(512));
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
  });

  it("recomputes with the new Selection Mode against the selection it started with", async () => {
    doc.combineSelection([rectPolygon(rect(16, 0, 16, 32))], "replace");
    click(1, 1);
    await settle(() => expect(doc.selection.bounds()).toEqual(rect(0, 0, 16, 32)));
    settings.set("tools.selection.combineMode", "Union");
    await settle(() => expect(doc.history.undoName).toBe("history.changeSelectionMode"));
    expect(doc.selection.area()).toBe(1024);
  });

  it("moves the origin when its handle is dragged, and floods from the new seed", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));

    runtime.pointer(event("down", 1.5, 1.5));
    runtime.pointer(event("move", 20, 5));
    expect(wandHandles.state.seed).toEqual({ x: 20, y: 5 });
    runtime.pointer(event("up", 20, 5));

    await settle(() => expect(doc.history.undoName).toBe("history.moveOrigin"));
    await settle(() => expect(doc.selection.bounds()).toEqual(rect(16, 0, 16, 32)));
    expect(doc.selection.area()).toBe(512);
  });

  it("shows a crosshair, a hand on the origin and the move arrows on the move handle (TL-FRAME-06)", async () => {
    const view = { canPan: false, panning: false };
    const cursorAt = (x: number, y: number) => {
      runtime.pointer(event("move", x, y));
      return runtime.cursor?.(view);
    };
    expect(cursorAt(1, 1)).toBe("crosshair");
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));
    expect(cursorAt(1.5, 1.5)).toBe("grab");
    expect(cursorAt(8, 16)).toBe("move");
    expect(cursorAt(24, 24)).toBe("crosshair");
    runtime.pointer(event("down", 1.5, 1.5));
    expect(cursorAt(3, 3)).toBe("grabbing");
    runtime.cancel?.();
    expect(runtime.cursor?.({ ...view, panning: true })).toBeUndefined();
  });

  it("restores the seed when an origin drag is canceled", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));

    runtime.pointer(event("down", 1.5, 1.5));
    runtime.pointer(event("move", 20, 5));
    runtime.cancel?.();

    expect(wandHandles.state.seed).toEqual({ x: 1, y: 1 });
    expect(doc.history.undoName).toBe("history.magicWand");
    expect(doc.selection.area()).toBe(512);
  });

  it("moves the selection when the move handle is dragged, as one history step", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));

    runtime.pointer(event("down", 8, 16));
    runtime.pointer(event("move", 10, 16));
    expect(doc.selection.bounds()).toEqual(rect(2, 0, 16, 32));
    runtime.pointer(event("up", 10, 16));

    expect(doc.history.undoName).toBe("history.moveSelection");
    expect(doc.selection.bounds()).toEqual(rect(2, 0, 16, 32));
  });

  it("changes nothing when a handle is clicked with less than 4 CSS pixels of jitter", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));
    // At 100 % zoom: a canvas pixel is a CSS pixel.
    const at = (type: ToolPointerEvent["type"], x: number, y: number) => ({
      ...event(type, x, y),
      clientX: x,
      clientY: y,
    });
    runtime.pointer(at("down", 8, 16));
    runtime.pointer(at("move", 10, 17));
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 16, 32));
    runtime.pointer(at("up", 10, 18));
    runtime.pointer(at("down", 1.5, 1.5));
    runtime.pointer(at("up", 3.5, 3.5));
    expect(doc.history.undoName).toBe("history.magicWand");
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 16, 32));
    expect(wandHandles.state.seed).toEqual({ x: 1, y: 1 });
  });

  it("keeps the moved place when the flood is recomputed later", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));
    runtime.pointer(event("down", 8, 16));
    runtime.pointer(event("up", 10, 16));

    settings.set("tools.tolerance", 0.4);
    await settle(() => expect(doc.history.undoName).toBe("history.changeTolerance"));
    expect(doc.selection.bounds()).toEqual(rect(2, 0, 16, 32));
    expect(doc.selection.area()).toBe(512);
  });

  it("commits the pending result and starts a new one when the next click is elsewhere", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));

    click(30, 30);
    await settle(() => expect(doc.selection.bounds()).toEqual(rect(16, 0, 16, 32)));
    expect(doc.history.undoName).toBe("history.magicWand");

    expect(await doc.history.undo()).toBe(true);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 16, 32));
  });

  it("undo takes a recomputed result back a step and keeps it pending", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));
    settings.set("tools.tolerance", 1);
    await settle(() => expect(doc.selection.area()).toBe(1024));

    expect(await doc.history.undo()).toBe(true);
    expect(doc.selection.area()).toBe(512);
    expect(settings.get("tools.tolerance")).toBe(0.5);
    expect(runtime.hasPending?.()).toBe(true);
  });

  it("undo after Finish brings the pending result back, with its handles", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));
    runtime.commit?.();
    expect(runtime.hasPending?.()).toBe(false);

    expect(await doc.history.undo()).toBe(true);
    expect(runtime.hasPending?.()).toBe(true);
    expect(doc.selection.area()).toBe(512);
    expect(wandHandles.state.seed).toEqual({ x: 1, y: 1 });
  });

  it("a selection change that is not one of the wand's steps ends the pending result", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));

    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    expect(runtime.hasPending?.()).toBe(false);
  });

  it("ignores option changes while nothing is pending", () => {
    const before = doc.history.undoName;
    settings.set("tools.tolerance", 1);
    expect(doc.history.undoName).toBe(before);
    expect(doc.selection.isEmpty).toBe(true);
  });

  it("ignores option changes that come from another tab", async () => {
    click(1, 1);
    await settle(() => expect(doc.selection.area()).toBe(512));
    settings.emit({ path: "tools.tolerance", value: 1, source: "remote" });
    expect(doc.selection.area()).toBe(512);
    expect(doc.history.undoName).toBe("history.magicWand");
  });

  it("shows the busy spinner at the click point while the flood runs", async () => {
    click(1, 1);
    expect(wandHandles.state.busy).toEqual({ x: 1, y: 1 });
    await settle(() => expect(doc.selection.area()).toBe(512));
    await settle(() => expect(wandHandles.state.busy).toBeUndefined());
  });
});
