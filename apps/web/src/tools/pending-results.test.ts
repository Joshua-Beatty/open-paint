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
import { lineCurveHandles } from "./line-curve-handles";
import { lineCurveToolRuntime } from "./line-curve-tools";
import type { PaintHost } from "./paint-tools";
import {
  followPendingResults,
  PENDING_RESULTS_KEPT,
  PendingResults,
  type PendingStep,
  pendingToolAt,
} from "./pending-results";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

class FakeSettings {
  readonly values: Record<string, unknown> = {
    "tools.primaryColor": { r: 0, g: 255, b: 0, a: 255 },
    "tools.secondaryColor": { r: 255, g: 255, b: 0, a: 255 },
    "tools.brush.size": 2,
    "tools.antialiasing": false,
    "tools.shapes.curveType": "Spline",
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
    return () => this.#listeners.delete(listener);
  };
}

function event(type: ToolPointerEvent["type"], x: number, y: number): ToolPointerEvent {
  return { type, x, y, button: 0, pressure: 1, shiftKey: false, altKey: false, ctrlKey: false };
}

/** Lets queued microtasks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pending results across undo (owner request)", () => {
  let doc: Document;
  let line: ToolRuntime;
  let active: string;
  let editing: boolean;
  const activate = vi.fn((id: string) => {
    if (id === "lineCurve") line.activate();
    active = id;
    return true;
  });

  beforeEach(() => {
    doc = Document.createBlank({ width: 40, height: 40 });
    const settings = new FakeSettings();
    const host: PaintHost = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (id) => id,
      notify: vi.fn(),
      report: vi.fn(),
    };
    line = lineCurveToolRuntime(host);
    active = "lineCurve";
    editing = false;
    activate.mockClear();
  });

  afterEach(() => {
    line.deactivate();
    lineCurveHandles.set({});
  });

  function drawAndFinish(): void {
    line.activate();
    line.pointer(event("down", 5.5, 10.5));
    line.pointer(event("move", 25.5, 10.5));
    line.pointer(event("up", 25.5, 10.5));
    line.commit?.();
  }

  it("switches to the tool of a result that undo makes pending again, and shows its handles", async () => {
    const tools = {
      get active() {
        return { id: active };
      },
      get editing() {
        return editing;
      },
      activate,
    };
    const stop = followPendingResults(doc, tools);
    drawAndFinish();
    line.deactivate();
    active = "pencil";
    expect(pendingToolAt(doc)).toBeUndefined();

    await doc.history.undo();
    await settle();
    expect(pendingToolAt(doc)).toBe("lineCurve");
    expect(activate).toHaveBeenCalledWith("lineCurve");
    expect(line.hasPending?.()).toBe(true);
    expect(lineCurveHandles.state.end).toEqual({ x: 25.5, y: 10.5 });

    // A redo finishes it again; nothing switches back.
    await doc.history.redo();
    await settle();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(line.hasPending?.()).toBe(false);
    stop();
  });

  it("doesn't switch while the active tool has a result of its own pending", async () => {
    const stop = followPendingResults(doc, {
      active: { id: "pencil" },
      editing: true,
      activate,
    });
    drawAndFinish();
    line.deactivate();
    await doc.history.undo();
    await settle();
    expect(activate).not.toHaveBeenCalled();
    stop();
  });

  it("doesn't switch for an undo in an image whose latest item is no result's", async () => {
    const stop = followPendingResults(doc, { active: { id: "pencil" }, editing: false, activate });
    doc.combineSelection([rectPolygon(rect(0, 0, 10, 10))], "replace");
    doc.combineSelection([rectPolygon(rect(0, 0, 5, 5))], "replace");
    await doc.history.undo();
    await settle();
    expect(activate).not.toHaveBeenCalled();
    stop();
  });

  it(`keeps only the newest ${PENDING_RESULTS_KEPT} results editable`, async () => {
    const results = new PendingResults<object, PendingStep>("test", () => true);
    const owners = Array.from({ length: PENDING_RESULTS_KEPT + 1 }, () => ({}));
    for (const [index, owner] of owners.entries()) {
      doc.combineSelection([rectPolygon(rect(index, 0, 1, 1))], "replace");
      const command = doc.history.appliedCommands.at(-1);
      if (command === undefined) throw new Error("nothing recorded");
      results.remember(command, owner, { finished: false });
    }
    expect(results.at(doc)?.owner).toBe(owners.at(-1));
    for (let i = 0; i < PENDING_RESULTS_KEPT - 1; i++) await doc.history.undo();
    expect(results.at(doc)?.owner).toBe(owners[1]);
    await doc.history.undo();
    expect(results.at(doc)).toBeUndefined();
  });
});
