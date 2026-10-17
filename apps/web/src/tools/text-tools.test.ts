// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document } from "@openpaint/document";
import type { TextEngine, TextRasterRequest } from "@openpaint/engine";
import type { ToolPointerEvent, ToolRuntime } from "@openpaint/extension-api";
import type { SettingChange } from "@openpaint/storage";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import { TEXT_PLACE_CURSOR } from "./cursors";
import type { PaintHost } from "./paint-tools";
import { textHandles } from "./text-handles";
import type { TextInputHandlers, TextInputPort } from "./text-input";
import { type TextToolDeps, textToolRuntime } from "./text-tools";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = { r: 255, g: 0, b: 0, a: 255 };
const WHITE = { r: 255, g: 255, b: 255, a: 255 };

/** A glyph is a 6 by 10 block of full coverage, and every character advances 6 pixels. */
const ADVANCE = 6;
const ASCENT = 10;
const DESCENT = 4;

/**
 * A text engine with fixed metrics. Each character covers its own 6 by 10 cell above the
 * baseline, so the mask is easy to predict.
 */
const fakeEngine: TextEngine = {
  metrics: () => ({ ascent: ASCENT, descent: DESCENT }),
  measure: (text) => text.length * ADVANCE,
  rasterize(request: TextRasterRequest) {
    const alpha = new Uint8ClampedArray(request.width * request.height);
    for (const line of request.lines) {
      [...line.text].forEach((_, index) => {
        const left = Math.round(line.x) + index * ADVANCE;
        for (let y = line.baseline - ASCENT; y < line.baseline; y++) {
          for (let x = left; x < left + ADVANCE - 1; x++) {
            if (x < 0 || y < 0 || x >= request.width || y >= request.height) continue;
            alpha[y * request.width + x] = 255;
          }
        }
      });
    }
    return { width: request.width, height: request.height, alpha };
  },
};

/** The settings the Text tool reads, with the defaults of SET-STO-03. */
class FakeSettings {
  readonly values: Record<string, unknown> = {
    "tools.primaryColor": RED,
    "tools.secondaryColor": WHITE,
    "tools.text.fontFamily": "Noto Sans",
    "tools.text.fontSize": 12,
    "tools.text.fontSizeMetric": "Fixed96Dpi",
    "tools.text.fontStyle": "Regular",
    "tools.text.renderingMode": "Smooth",
    "tools.text.alignment": "Left",
    "tools.antialiasing": true,
    "tools.blendMode": "normal",
    "tools.selection.renderingQuality": "Antialiased",
    "workspace.measurementUnit": "Pixel",
  };

  get = (path: string): unknown => this.values[path];

  readonly #listeners = new Set<(change: SettingChange) => void>();

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

class FakeInput implements TextInputPort {
  handlers: TextInputHandlers | undefined;
  focused = false;
  disposed = false;

  focus(): void {
    this.focused = true;
  }

  blur(): void {
    this.focused = false;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function event(
  type: ToolPointerEvent["type"],
  x: number,
  y: number,
  options: { readonly button?: number; readonly ctrl?: boolean } = {},
): ToolPointerEvent {
  return {
    type,
    x,
    y,
    button: options.button ?? 0,
    pressure: 1,
    shiftKey: false,
    altKey: false,
    ctrlKey: options.ctrl === true,
  };
}

describe("Text tool (TL-TEXT-01)", () => {
  let doc: Document;
  let settings: FakeSettings;
  let input: FakeInput;
  let runtime: ToolRuntime;
  let status: ReturnType<typeof vi.fn<(text: string) => void>>;
  const notify = vi.fn();
  const report = vi.fn();

  function keys(code: string, ctrlKey = false): boolean {
    const handlers = input.handlers;
    if (handlers === undefined) throw new Error("the input was not created");
    return handlers.key({ code, ctrlKey, shiftKey: false, altKey: false });
  }

  function type(text: string): void {
    input.handlers?.text(text);
  }

  function pixel(x: number, y: number) {
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    return layer.pixels.getPixel(x, y);
  }

  beforeEach(() => {
    doc = Document.createBlank({ width: 40, height: 30 });
    settings = new FakeSettings();
    input = new FakeInput();
    status = vi.fn();
    const deps: TextToolDeps = {
      engine: fakeEngine,
      fonts: {
        resolve: (stored) => (typeof stored === "string" ? stored : "Noto Sans"),
        ensure: () => true,
        subscribe: () => () => undefined,
      },
      input: (handlers) => {
        input.handlers = handlers;
        return input;
      },
    };
    const host: PaintHost = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (messageId, values) =>
        values === undefined ? messageId : `${messageId} ${JSON.stringify(values)}`,
      notify,
      report,
      status,
    };
    runtime = textToolRuntime(host, deps);
    runtime.activate();
    notify.mockClear();
    report.mockClear();
  });

  afterEach(() => {
    runtime.deactivate();
    textHandles.set({});
  });

  it("places a block on click, types into it, and shows the text as a preview", () => {
    runtime.pointer(event("down", 2, 2));
    expect(runtime.hasPending?.()).toBe(true);
    expect(doc.history.undoName).toBeUndefined();
    type("ab");
    expect(pixel(3, 5)).toEqual(RED);
    expect(pixel(20, 5)).toEqual(WHITE);
    expect(input.focused).toBe(true);
    expect(textHandles.state.box).toEqual({ x: 2, y: 2, width: 12, height: 14 });
  });

  it("shows the placement cursor, an I-beam over the text and a hand on its handle (TL-FRAME-06)", () => {
    const view = { canPan: false, panning: false };
    runtime.pointer(event("move", 4, 10));
    expect(runtime.cursor?.(view)).toBe(TEXT_PLACE_CURSOR);
    runtime.pointer(event("down", 2, 2));
    runtime.pointer(event("up", 2, 2));
    type("ab");
    runtime.pointer(event("move", 4, 10));
    expect(runtime.cursor?.(view)).toBe("text");
    runtime.pointer(event("move", 30, 25));
    expect(runtime.cursor?.(view)).toBe(TEXT_PLACE_CURSOR);
    const handle = textHandles.state.handle;
    if (handle === undefined) throw new Error("no move handle");
    runtime.pointer(event("move", handle.x + 1, handle.y));
    expect(runtime.cursor?.(view)).toBe("grab");
    expect(runtime.cursor?.({ ...view, ctrlKey: true })).not.toBe("grab");
    runtime.pointer(event("down", handle.x + 1, handle.y));
    expect(runtime.cursor?.(view)).toBe("grabbing");
    runtime.pointer(event("up", handle.x + 1, handle.y));
    expect(runtime.cursor?.({ ...view, panning: true })).toBeUndefined();
  });

  it("commits with Esc as one undoable Text item, and undo restores the layer", async () => {
    runtime.pointer(event("down", 2, 2));
    type("ab");
    type("c");
    expect(keys("Escape")).toBe(true);
    expect(runtime.hasPending?.()).toBe(false);
    expect(doc.history.undoName).toBe("history.text");
    expect(pixel(3, 5)).toEqual(RED);
    expect(input.focused).toBe(false);
    await doc.history.undo();
    expect(pixel(3, 5)).toEqual(WHITE);
  });

  it("commits with Ctrl+Enter, and Enter inserts a line instead", async () => {
    runtime.pointer(event("down", 2, 2));
    type("ab");
    expect(keys("Enter")).toBe(true);
    type("cd");
    expect(runtime.hasPending?.()).toBe(true);
    expect(keys("Enter", true)).toBe(true);
    expect(runtime.hasPending?.()).toBe(false);
    expect(doc.history.undoName).toBe("history.text");
    expect(pixel(3, 5)).toEqual(RED);
    expect(pixel(3, 19)).toEqual(RED);
    await doc.history.undo();
    expect(pixel(3, 5)).toEqual(WHITE);
  });

  it("commits when the user clicks outside the block, and starts a new block there", () => {
    runtime.pointer(event("down", 2, 2));
    type("ab");
    runtime.pointer(event("up", 2, 2));
    runtime.pointer(event("down", 30, 20));
    expect(doc.history.undoName).toBe("history.text");
    type("z");
    expect(pixel(31, 25)).toEqual(RED);
    expect(pixel(3, 5)).toEqual(RED);
    expect(runtime.hasPending?.()).toBe(true);
  });

  it("commits when the tool is deactivated, and disposes the input", () => {
    runtime.pointer(event("down", 2, 2));
    type("ab");
    runtime.deactivate();
    expect(doc.history.undoName).toBe("history.text");
    expect(input.disposed).toBe(true);
    expect(textHandles.state).toEqual({});
  });

  it("does not record an empty block", () => {
    runtime.pointer(event("down", 2, 2));
    runtime.commit?.();
    expect(doc.history.undoName).toBeUndefined();
    expect(runtime.hasPending?.()).toBe(false);
    expect(pixel(3, 5)).toEqual(WHITE);
  });

  it("Backspace, Delete and the arrow keys edit at the caret", () => {
    runtime.pointer(event("down", 2, 2));
    type("abc");
    keys("ArrowLeft");
    keys("Backspace");
    expect(textHandles.state.caret?.x).toBe(2 + ADVANCE);
    type("X");
    keys("Delete");
    keys("Home");
    type("_");
    keys("End");
    type("!");
    runtime.commit?.();
    expect(doc.history.undoName).toBe("history.text");
  });

  it("a click inside the block moves the caret to the nearest character", () => {
    runtime.pointer(event("down", 2, 2));
    type("ab");
    runtime.pointer(event("down", 2 + ADVANCE, 5));
    type("X");
    runtime.pointer(event("up", 2 + ADVANCE, 5));
    expect(pixel(3, 5)).toEqual(RED);
    expect(runtime.hasPending?.()).toBe(true);
    expect(textHandles.state.caret?.x).toBe(2 + 2 * ADVANCE);
  });

  it("the move handle drags the whole block", () => {
    runtime.pointer(event("down", 2, 2));
    type("ab");
    runtime.pointer(event("down", 14, 2));
    runtime.pointer(event("move", 20, 7));
    runtime.pointer(event("up", 20, 7));
    expect(textHandles.state.box?.x).toBe(8);
    expect(textHandles.state.box?.y).toBe(7);
    expect(pixel(3, 5)).toEqual(WHITE);
    expect(pixel(9, 10)).toEqual(RED);
  });

  it("draws a block drag once per frame, at the latest position (L1)", () => {
    runtime.deactivate();
    const frames: (() => void)[] = [];
    const host: PaintHost = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (messageId) => messageId,
      notify,
      report,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return () => frames.splice(frames.indexOf(callback), 1);
      },
    };
    runtime = textToolRuntime(host, {
      engine: fakeEngine,
      fonts: { resolve: () => "Noto Sans", ensure: () => true, subscribe: () => () => undefined },
      input: (handlers) => {
        input.handlers = handlers;
        return input;
      },
    });
    runtime.activate();
    runtime.pointer(event("down", 2, 2));
    type("ab");
    const rasterize = vi.spyOn(fakeEngine, "rasterize");
    runtime.pointer(event("down", 14, 2));
    for (let x = 15; x <= 20; x++) runtime.pointer(event("move", x, 7));
    expect(rasterize).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(rasterize).toHaveBeenCalledTimes(1);
    runtime.pointer(event("up", 20, 7));
    rasterize.mockRestore();
    expect(textHandles.state.box?.x).toBe(8);
    expect(pixel(3, 5)).toEqual(WHITE);
    expect(pixel(9, 10)).toEqual(RED);
  });

  it("redraws the text in a new primary color once per frame, and keeps one Text step (TL-TEXT-01)", async () => {
    runtime.deactivate();
    const frames: (() => void)[] = [];
    runtime = textToolRuntime(
      {
        settings: () => settings as unknown as ColorSettings,
        document: () => doc,
        translate: (messageId) => messageId,
        notify,
        report,
        scheduleFrame: (callback) => {
          frames.push(callback);
          return () => frames.splice(frames.indexOf(callback), 1);
        },
      },
      {
        engine: fakeEngine,
        fonts: { resolve: () => "Noto Sans", ensure: () => true, subscribe: () => () => undefined },
        input: (handlers) => {
          input.handlers = handlers;
          return input;
        },
      },
    );
    runtime.activate();
    runtime.pointer(event("down", 2, 2));
    type("ab");
    expect(pixel(3, 5)).toEqual(RED);
    const rasterize = vi.spyOn(fakeEngine, "rasterize");
    const blue = { r: 0, g: 0, b: 255, a: 255 };
    settings.set("tools.primaryColor", { r: 0, g: 255, b: 0, a: 255 });
    settings.set("tools.primaryColor", blue);
    settings.set("tools.secondaryColor", RED);
    expect(rasterize).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(rasterize).toHaveBeenCalledTimes(1);
    rasterize.mockRestore();
    expect(pixel(3, 5)).toEqual(blue);
    expect(doc.history.undoName).toBeUndefined();
    runtime.commit?.();
    expect(doc.history.undoName).toBe("history.text");
    expect(pixel(3, 5)).toEqual(blue);
    await doc.history.undo();
    expect(pixel(3, 5)).toEqual(WHITE);
  });

  it("loads the chosen face on activation and for the typed text, and redraws when it is in (WEB-FONT-01)", () => {
    runtime.deactivate();
    let fontsLoaded: (() => void) | undefined;
    const ensure = vi.fn(() => false);
    settings.set("tools.text.fontFamily", "Pacifico");
    settings.set("tools.text.fontStyle", "Bold");
    runtime = textToolRuntime(
      {
        settings: () => settings as unknown as ColorSettings,
        document: () => doc,
        translate: (messageId) => messageId,
        notify,
        report,
      },
      {
        engine: fakeEngine,
        fonts: {
          resolve: (stored) => String(stored),
          ensure,
          subscribe: (listener) => {
            fontsLoaded = listener;
            return () => undefined;
          },
        },
        input: (handlers) => {
          input.handlers = handlers;
          return input;
        },
      },
    );
    runtime.activate();
    expect(ensure).toHaveBeenCalledWith({ family: "Pacifico", bold: true, italic: false });
    runtime.pointer(event("down", 2, 2));
    type("ab");
    expect(ensure).toHaveBeenLastCalledWith(
      expect.objectContaining({ family: "Pacifico", bold: true }),
      "ab",
    );
    const rasterize = vi.spyOn(fakeEngine, "rasterize");
    fontsLoaded?.();
    expect(rasterize).toHaveBeenCalledTimes(1);
    rasterize.mockRestore();
  });

  it("Ctrl hides the handle and the caret", () => {
    runtime.pointer(event("down", 2, 2));
    type("a");
    expect(textHandles.state.handle).toBeDefined();
    runtime.pointer(event("move", 3, 3, { ctrl: true }));
    expect(textHandles.state.handle).toBeUndefined();
    expect(textHandles.state.caret).toBeUndefined();
  });

  it("IME composition shows at the caret until it ends, then the committed text is typed", () => {
    runtime.pointer(event("down", 2, 2));
    input.handlers?.composition("nn");
    expect(pixel(3, 5)).toEqual(RED);
    expect(pixel(9, 5)).toEqual(RED);
    input.handlers?.composition(undefined);
    expect(pixel(3, 5)).toEqual(WHITE);
    type("你");
    expect(pixel(3, 5)).toEqual(RED);
    expect(pixel(9, 5)).toEqual(WHITE);
  });

  it("Ctrl+V paste inserts plain text, and line breaks become newlines", () => {
    runtime.pointer(event("down", 2, 2));
    input.handlers?.paste("ab\r\ncd");
    expect(pixel(3, 19)).toEqual(RED);
    runtime.commit?.();
    expect(doc.history.undoName).toBe("history.text");
  });

  it("takes pasted text from the Paste command only while a block is edited", () => {
    expect(runtime.acceptsPaste?.()).toBe(false);
    runtime.pointer(event("down", 2, 2));
    expect(runtime.acceptsPaste?.()).toBe(true);
    runtime.paste?.("ab");
    expect(pixel(3, 5)).toEqual(RED);
    expect(pixel(9, 5)).toEqual(RED);
    runtime.commit?.();
    expect(runtime.acceptsPaste?.()).toBe(false);
    expect(doc.history.undoName).toBe("history.text");
  });

  it("a change in the history ends the session without a new item", () => {
    runtime.pointer(event("down", 2, 2));
    type("ab");
    const layer = doc.activeLayer;
    if (layer === undefined) throw new Error("no active layer");
    doc.editLayerPixels("history.paint", layer, layer.pixels.bounds, () => undefined);
    expect(runtime.hasPending?.()).toBe(false);
    expect(keys("Escape")).toBe(false);
  });

  it("reports the anchor point in the status text", () => {
    runtime.pointer(event("down", 7, 9));
    expect(status).toHaveBeenLastCalledWith(
      expect.stringContaining('tool.status.textAnchor {"x":"7","y":"9"'),
    );
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining("tool.status.textMove"));
  });

  it("ignores a secondary button", () => {
    runtime.pointer(event("down", 2, 2, { button: 2 }));
    expect(runtime.hasPending?.()).toBe(false);
    expect(input.handlers).toBeUndefined();
  });
});
