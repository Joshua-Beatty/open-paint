import { Document, rect, rectPolygon } from "@openpaint/document";
import type { ToolDescriptor, ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import type { PaintHost } from "./paint-tools";
import { TOOL_REGISTRY } from "./roster";
import { selectionToolRuntime } from "./select-tools";

/** The Selection tool defaults, keyed by their full `tools.` path. */
const DEFAULTS: Record<string, unknown> = {
  "tools.selection.combineMode": "Replace",
  "tools.selection.drawMode": "Normal",
  "tools.selection.drawWidth": 400,
  "tools.selection.drawHeight": 300,
  "tools.selection.drawUnits": "Pixel",
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

/** CSS pixels per canvas pixel for the events below. At 10, a one-pixel drag leaves the dead zone. */
let zoom = 10;

/** A sample at canvas (`x`, `y`), with its client position at the current `zoom`. */
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
    clientX: x * zoom,
    clientY: y * zoom,
  };
}

describe("selection tools", () => {
  let doc: Document;
  const notify = vi.fn<(messageId: MessageId) => void>();
  const report = vi.fn<(cause: unknown) => void>();

  function runtimeFor(id: string, values: Record<string, unknown> = {}): ToolRuntime {
    const host: PaintHost = {
      settings: () => settingsWith({ ...DEFAULTS, ...values }),
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
    };
    const runtime = selectionToolRuntime(toolNamed(id), host);
    if (runtime === undefined) throw new Error(`no runtime for ${id}`);
    runtime.activate();
    return runtime;
  }

  /** A press, its moves and its release. Each point is a canvas position in pixels. */
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
    zoom = 10;
    notify.mockClear();
    report.mockClear();
  });

  it("gives no runtime to the tools that do not select by shape", () => {
    const host: PaintHost = {
      settings: () => null,
      document: () => undefined,
      translate: (id) => id,
      notify: () => undefined,
      report: () => undefined,
    };
    expect(selectionToolRuntime(toolNamed("zoom"), host)).toBeUndefined();
    expect(selectionToolRuntime(toolNamed("rectangleSelect"), host)).toBeDefined();
    expect(selectionToolRuntime(toolNamed("ellipseSelect"), host)).toBeDefined();
  });

  it("shows a precise crosshair, and the closed hand while the view pans", () => {
    for (const id of ["rectangleSelect", "ellipseSelect", "lassoSelect"]) {
      const runtime = runtimeFor(id);
      expect(runtime.cursor?.({ canPan: false, panning: false })).toBe("crosshair");
      expect(runtime.cursor?.({ canPan: true, panning: true })).toBeUndefined();
    }
  });

  it("selects the dragged rectangle as one history step named after the tool (TL-SEL-RECT-01)", () => {
    const entries = doc.history.entries.length;
    const runtime = runtimeFor("rectangleSelect");
    drag(runtime, [
      [2.4, 3.9],
      [5.8, 6.2],
    ]);
    expect(doc.selection.bounds()).toEqual(rect(2, 3, 4, 4));
    expect(doc.selection.area()).toBe(16);
    expect(doc.history.undoName).toBe("history.rectangleSelect");
    expect(doc.history.entries.length).toBe(entries + 1);
  });

  it("previews the shape while dragging without a history item, and cancel restores the selection", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 2, 2))], "replace");
    const entries = doc.history.entries.length;
    const runtime = runtimeFor("rectangleSelect");
    runtime.pointer(event("down", 10, 10));
    runtime.pointer(event("move", 13, 12));
    expect(doc.selection.bounds()).toEqual(rect(10, 10, 4, 3));
    expect(doc.history.entries.length).toBe(entries);

    runtime.cancel?.();
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 2, 2));
    expect(doc.history.entries.length).toBe(entries);
  });

  it("deselects on a click in Replace mode, as one Deselect step", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    const runtime = runtimeFor("rectangleSelect");
    runtime.pointer(event("down", 6, 6));
    runtime.pointer(event("up", 6, 6));
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.history.undoName).toBe("Deselect");
  });

  it("records nothing for a click in Replace mode when nothing is selected", () => {
    const entries = doc.history.entries.length;
    const runtime = runtimeFor("rectangleSelect");
    runtime.pointer(event("down", 6, 6));
    runtime.pointer(event("up", 6, 6));
    expect(doc.history.entries.length).toBe(entries);
  });

  describe("the click dead zone, in CSS pixels at any zoom", () => {
    /** A press at client (200, 200), a jitter of `distance` CSS pixels to the right, and a release. */
    function jitter(id: string, distance: number, path: "move" | "release" = "move"): void {
      const runtime = runtimeFor(id);
      const sample = (type: ToolPointerEvent["type"], clientX: number): ToolPointerEvent => ({
        ...event(type, clientX / zoom, 200 / zoom),
        clientX,
        clientY: 200,
      });
      runtime.pointer(sample("down", 200));
      if (path === "move") runtime.pointer(sample("move", 200 + distance));
      runtime.pointer(sample("up", 200 + distance));
    }

    for (const ratio of [0.25, 1, 8]) {
      for (const id of ["rectangleSelect", "ellipseSelect", "lassoSelect"]) {
        it(`deselects after 3 CSS px of jitter and selects after 6, at ${ratio * 100} % (${id})`, () => {
          zoom = ratio;
          doc = Document.createBlank({ width: 2000, height: 2000 });
          doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
          jitter(id, 3);
          expect(doc.selection.isEmpty).toBe(true);
          expect(doc.history.undoName).toBe("Deselect");

          // The lasso needs an area, so it also moves down before it leaves the zone sideways.
          if (id === "lassoSelect") {
            const runtime = runtimeFor(id);
            const sample = (type: ToolPointerEvent["type"], cx: number, cy: number) => ({
              ...event(type, cx / zoom, cy / zoom),
              clientX: cx,
              clientY: cy,
            });
            runtime.pointer(sample("down", 200, 200));
            runtime.pointer(sample("move", 200, 240));
            runtime.pointer(sample("up", 240, 240));
          } else {
            jitter(id, 6, "release");
          }
          expect(doc.selection.isEmpty).toBe(false);
          expect(doc.history.undoName).toBe(`history.${id}`);
        });
      }
    }

    it("shows no preview inside the zone, and draws from the press point once out of it", () => {
      zoom = 1;
      doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
      const before = doc.selection;
      const runtime = runtimeFor("rectangleSelect");
      runtime.pointer(event("down", 10, 10));
      runtime.pointer(event("move", 12, 13));
      expect(doc.selection).toBe(before);
      runtime.pointer(event("move", 14, 13));
      expect(doc.selection.bounds()).toEqual(rect(10, 10, 5, 4));
      // Back inside the zone, the press is still a drag.
      runtime.pointer(event("move", 11, 11));
      expect(doc.selection.bounds()).toEqual(rect(10, 10, 2, 2));
      runtime.pointer(event("up", 11, 11));
      expect(doc.selection.bounds()).toEqual(rect(10, 10, 2, 2));
      expect(doc.history.undoName).toBe("history.rectangleSelect");
    });

    it("shows no lasso preview inside the zone", () => {
      zoom = 1;
      const before = doc.selection;
      const runtime = runtimeFor("lassoSelect");
      runtime.pointer(event("down", 10, 10));
      runtime.pointer(event("move", 12, 12));
      runtime.pointer(event("move", 10, 13));
      expect(doc.selection).toBe(before);
    });

    it("selects a 2 x 2 rectangle when zoomed in, from a drag shorter than the zone at 100 %", () => {
      zoom = 8;
      const runtime = runtimeFor("rectangleSelect");
      runtime.pointer(event("down", 10.5, 10.5));
      runtime.pointer(event("up", 11.5, 11.5));
      expect(doc.selection.bounds()).toEqual(rect(10, 10, 2, 2));
    });
  });

  it("does nothing on a click in Add, Subtract, Intersect or Invert mode", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    const entries = doc.history.entries.length;
    for (const mode of ["Union", "Exclude", "Intersect", "Xor"]) {
      const runtime = runtimeFor("rectangleSelect", { "tools.selection.combineMode": mode });
      runtime.pointer(event("down", 6, 6));
      runtime.pointer(event("up", 6, 6));
    }
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 4, 4));
    expect(doc.history.entries.length).toBe(entries);
  });

  it("treats a press held without movement as a click, however long it lasts", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    const runtime = runtimeFor("rectangleSelect");
    runtime.pointer(event("down", 6, 6));
    runtime.pointer(event("move", 6, 6));
    runtime.pointer(event("up", 6, 6));
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.history.undoName).toBe("Deselect");
  });

  it("adds with Ctrl and the left button, and subtracts with Alt and the left button", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    const runtime = runtimeFor("rectangleSelect");
    drag(
      runtime,
      [
        [6, 0],
        [7, 1],
      ],
      0,
      { ctrl: true },
    );
    expect(doc.selection.area()).toBe(20);
    expect(doc.history.undoName).toBe("history.rectangleSelect");

    drag(
      runtime,
      [
        [0, 0],
        [1, 1],
      ],
      0,
      { alt: true },
    );
    expect(doc.selection.area()).toBe(16);
  });

  it("intersects with Alt and the right button, and inverts with Ctrl and the right button", () => {
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    const runtime = runtimeFor("rectangleSelect");
    drag(
      runtime,
      [
        [2, 2],
        [7, 7],
      ],
      2,
      { alt: true },
    );
    expect(doc.selection.bounds()).toEqual(rect(2, 2, 2, 2));
    expect(doc.selection.area()).toBe(4);

    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    drag(
      runtime,
      [
        [2, 2],
        [5, 5],
      ],
      2,
      { ctrl: true },
    );
    expect(doc.selection.area()).toBe(16 + 16 - 2 * 4);
  });

  it("constrains to a square while Shift is held (TL-SEL-RECT-01)", () => {
    const runtime = runtimeFor("rectangleSelect");
    drag(
      runtime,
      [
        [2, 2],
        [9, 5],
      ],
      0,
      { shift: true },
    );
    expect(doc.selection.bounds()).toEqual(rect(2, 2, 8, 8));
  });

  it("clips the drawn shape to the image bounds (TL-SEL-01)", () => {
    const runtime = runtimeFor("rectangleSelect");
    drag(runtime, [
      [28, 28],
      [40, 40],
    ]);
    expect(doc.selection.bounds()).toEqual(rect(28, 28, 4, 4));
    expect(doc.selection.area()).toBe(16);
  });

  it("places a Fixed Size rectangle on a click, inside the image, and never treats it as too quick", () => {
    const runtime = runtimeFor("rectangleSelect", {
      "tools.selection.drawMode": "FixedSize",
      "tools.selection.drawWidth": 10,
      "tools.selection.drawHeight": 4,
    });
    runtime.pointer(event("down", 28, 30));
    runtime.pointer(event("up", 28, 30));
    expect(doc.selection.bounds()).toEqual(rect(22, 28, 10, 4));
    expect(doc.history.undoName).toBe("history.rectangleSelect");
  });

  it("converts Fixed Size inches to pixels with the document resolution", () => {
    doc = Document.createBlank({ width: 400, height: 400 });
    const runtime = runtimeFor("rectangleSelect", {
      "tools.selection.drawMode": "FixedSize",
      "tools.selection.drawWidth": 2,
      "tools.selection.drawHeight": 1,
      "tools.selection.drawUnits": "Inch",
    });
    runtime.pointer(event("down", 10, 10));
    runtime.pointer(event("up", 10, 10));
    expect(doc.selection.bounds()).toEqual(rect(10, 10, Math.round(2 * doc.resolution.x), 96));
  });

  it("keeps the Fixed Ratio of the width and height boxes while dragging", () => {
    const runtime = runtimeFor("rectangleSelect", {
      "tools.selection.drawMode": "FixedRatio",
      "tools.selection.drawWidth": 200,
      "tools.selection.drawHeight": 100,
    });
    drag(runtime, [
      [0, 0],
      [9, 2],
    ]);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 10, 5));
  });

  it("selects an ellipse inscribed in the drag, clipped to the image (TL-SEL-ELL-01)", () => {
    const runtime = runtimeFor("ellipseSelect");
    drag(runtime, [
      [0, 0],
      [7, 7],
    ]);
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 8, 8));
    // Its edge runs between pixel corners, so a small circle is within a few pixels of the area.
    expect(Math.abs(doc.selection.area() - Math.PI * 16)).toBeLessThan(2);
    for (const ring of doc.selection.polygons) {
      expect(ring.every((value) => Number.isInteger(value))).toBe(true);
    }
    expect(doc.history.undoName).toBe("history.ellipseSelect");
  });

  it("moves the shape when a second button is pressed during the drag (TL-SEL-01)", () => {
    const runtime = runtimeFor("rectangleSelect");
    runtime.pointer(event("down", 2, 2));
    runtime.pointer(event("move", 4, 4));
    runtime.pointer(event("down", 4, 4, 2));
    runtime.pointer(event("move", 7, 7, 2));
    runtime.pointer(event("up", 7, 7, 2));
    expect(doc.selection.bounds()).toEqual(rect(5, 5, 3, 3));
  });

  it("ignores hover moves, and predicted samples even during a drag", () => {
    const runtime = runtimeFor("rectangleSelect");
    const entries = doc.history.entries.length;
    runtime.pointer(event("move", 5, 5));
    expect(doc.selection.isEmpty).toBe(true);
    runtime.pointer(event("down", 2, 2));
    runtime.pointer({ ...event("move", 9, 9), predicted: true });
    runtime.pointer(event("up", 3, 3));
    expect(doc.selection.bounds()).toEqual(rect(2, 2, 2, 2));
    expect(doc.history.entries.length).toBe(entries + 1);
  });

  it("ignores buttons other than the primary and secondary ones", () => {
    const runtime = runtimeFor("rectangleSelect");
    drag(
      runtime,
      [
        [2, 2],
        [5, 5],
      ],
      1,
    );
    expect(doc.selection.isEmpty).toBe(true);
  });
});
