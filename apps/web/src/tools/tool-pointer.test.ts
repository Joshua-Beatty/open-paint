import type { ToolRuntime } from "@openpaint/extension-api";
import { describe, expect, it, vi } from "vitest";
import { TOOL_REGISTRY } from "./roster";
import { ToolController } from "./tool-controller";
import { createToolPointerSink } from "./tool-pointer";

function setup() {
  const runtime = {
    activate: vi.fn(),
    deactivate: vi.fn(),
    pointer: vi.fn(),
  } satisfies ToolRuntime & Record<string, unknown>;
  const controller = new ToolController({ registry: TOOL_REGISTRY, createRuntime: () => runtime });
  return { controller, runtime, sink: createToolPointerSink(controller) };
}

const source = {
  clientX: 12,
  clientY: 8,
  button: 0,
  pressure: 0.5,
  pointerType: "mouse",
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
};
const toImage = (x: number, y: number) => ({ x: x / 2, y: y / 2 });

describe("createToolPointerSink", () => {
  it("marks a drawing while a button is held", () => {
    const { controller, sink } = setup();
    sink.pointer("down", source, toImage);
    expect(controller.pointerHeld).toBe(true);
    sink.pointer("up", source, toImage);
    expect(controller.pointerHeld).toBe(false);
  });

  it("sends each sample to the active runtime in canvas pixels", () => {
    const { runtime, sink } = setup();
    sink.pointer("down", source, toImage);
    expect(runtime.pointer).toHaveBeenCalledWith(
      expect.objectContaining({ type: "down", x: 6, y: 4, button: 0, pressure: 1 }),
    );
  });

  it("clears the drawing mark on cancel", () => {
    const { controller, sink } = setup();
    sink.pointer("down", source, toImage);
    sink.pointer("cancel", source, toImage);
    expect(controller.pointerHeld).toBe(false);
  });

  it("holds input while the tool settles a result, then sends it in order (L7)", async () => {
    let settle: () => void = () => {};
    let settling: Promise<void> | undefined = new Promise<void>((resolve) => {
      settle = () => {
        settling = undefined;
        resolve();
      };
    });
    const runtime = {
      activate: vi.fn(),
      deactivate: vi.fn(),
      pointer: vi.fn(),
      settling: () => settling,
    } satisfies ToolRuntime & Record<string, unknown>;
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => runtime,
    });
    const sink = createToolPointerSink(controller);
    sink.pointer("down", source, toImage);
    sink.pointer("up", source, toImage);
    expect(runtime.pointer).not.toHaveBeenCalled();
    settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.pointer.mock.calls.map(([event]) => event.type)).toEqual(["down", "up"]);
    sink.pointer("down", source, toImage);
    expect(runtime.pointer).toHaveBeenCalledTimes(3);
  });

  it("holds input while an Undo or Redo runs, then sends it in order", async () => {
    const { controller, runtime } = setup();
    let land: () => void = () => {};
    let running: Promise<void> | undefined = new Promise<void>((resolve) => {
      land = () => {
        running = undefined;
        resolve();
      };
    });
    const sink = createToolPointerSink(controller, () => running);
    sink.pointer("down", source, toImage);
    sink.pointer("up", source, toImage);
    expect(runtime.pointer).not.toHaveBeenCalled();
    land();
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.pointer.mock.calls.map(([event]) => event.type)).toEqual(["down", "up"]);
  });

  it("still tracks the drawing for a tool without a runtime", () => {
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => undefined,
    });
    const sink = createToolPointerSink(controller);
    sink.pointer("down", source, toImage);
    expect(controller.pointerHeld).toBe(true);
  });
});

describe("view hooks (TL-ZOOM-01, TL-PAN-01)", () => {
  it("passes the active runtime's cursor and pan-on-drag flag", () => {
    const cursor = vi.fn(() => "grab");
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => ({
        activate: vi.fn(),
        deactivate: vi.fn(),
        pointer: vi.fn(),
        cursor,
        panOnDrag: true,
      }),
    });
    const sink = createToolPointerSink(controller);
    const view = { canPan: true, panning: false };
    expect(sink.cursor(view)).toBe("grab");
    expect(cursor).toHaveBeenCalledWith(view);
    expect(sink.panOnDrag()).toBe(true);
  });

  it("gives the default cursor and no pan drag to a tool without them", () => {
    const { sink } = setup();
    expect(sink.cursor({ canPan: true, panning: false })).toBeUndefined();
    expect(sink.panOnDrag()).toBe(false);
  });
});

describe("pen eraser contacts (WEB-PTR-02)", () => {
  function fakeRuntime() {
    return {
      activate: vi.fn(),
      deactivate: vi.fn(),
      pointer: vi.fn(),
    };
  }

  function setupByTool(activeTool?: string) {
    const runtimes: Record<string, ReturnType<typeof fakeRuntime>> = {
      paintbrush: fakeRuntime(),
      eraser: fakeRuntime(),
    };
    const store: Record<string, unknown> = {};
    if (activeTool !== undefined) store["tools.activeTool"] = activeTool;
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: (tool) => runtimes[tool.id],
    });
    controller.attach({
      get: (path: string) => store[path],
      set: (path: string, value: unknown) => {
        store[path] = value;
      },
    } as Parameters<ToolController["attach"]>[0]);
    return { runtimes, controller, sink: createToolPointerSink(controller) };
  }

  const eraserEnd = {
    ...source,
    pointerType: "pen",
    pressure: 0.4,
  };
  const pen = { ...source, pointerType: "pen", pressure: 0.4, button: 0, buttons: 1 };

  it("sends the whole contact of the eraser end to the Eraser, and then releases it", () => {
    const { runtimes, sink } = setupByTool();
    sink.pointer("down", { ...eraserEnd, button: 5, buttons: 32 }, toImage);
    sink.pointer("move", { ...eraserEnd, button: -1, buttons: 32 }, toImage);
    sink.pointer("up", { ...eraserEnd, button: 5, buttons: 0 }, toImage);
    expect(runtimes.eraser?.pointer.mock.calls.map(([sample]) => sample.type)).toEqual([
      "down",
      "move",
      "up",
    ]);
    expect(runtimes.paintbrush?.pointer).not.toHaveBeenCalled();
    expect(runtimes.eraser?.deactivate).toHaveBeenCalledTimes(1);
  });

  it("returns to the active tool for the next contact", () => {
    const { runtimes, sink } = setupByTool();
    sink.pointer("down", { ...eraserEnd, button: 5, buttons: 32 }, toImage);
    sink.pointer("up", { ...eraserEnd, button: 5, buttons: 0 }, toImage);
    sink.pointer("down", pen, toImage);
    expect(runtimes.paintbrush?.pointer).toHaveBeenCalledWith(
      expect.objectContaining({ type: "down" }),
    );
  });

  it("does not switch for the pen tip or for a mouse", () => {
    const { runtimes, sink } = setupByTool();
    sink.pointer("down", pen, toImage);
    sink.pointer("up", pen, toImage);
    sink.pointer("down", { ...source, button: 5, buttons: 32 }, toImage);
    expect(runtimes.eraser?.activate).not.toHaveBeenCalled();
    expect(runtimes.paintbrush?.pointer).toHaveBeenCalledTimes(3);
  });

  it("uses the active runtime when the Eraser is already the active tool", () => {
    const { runtimes, controller, sink } = setupByTool("eraser");
    sink.pointer("down", { ...eraserEnd, button: 5, buttons: 32 }, toImage);
    expect(controller.active.id).toBe("eraser");
    expect(runtimes.eraser?.pointer).toHaveBeenCalledWith(
      expect.objectContaining({ type: "down" }),
    );
    sink.pointer("up", { ...eraserEnd, button: 5, buttons: 0 }, toImage);
    expect(runtimes.eraser?.deactivate).not.toHaveBeenCalled();
  });

  it("commits a pending result of the active tool before the Eraser takes the contact", () => {
    const pending = { ...fakeRuntime(), hasPending: vi.fn(() => true), commit: vi.fn() };
    const eraser = fakeRuntime();
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: (tool) => (tool.id === "eraser" ? eraser : pending),
    });
    const sink = createToolPointerSink(controller);
    sink.pointer("down", { ...eraserEnd, button: 5, buttons: 32 }, toImage);
    expect(pending.commit).toHaveBeenCalledTimes(1);
    expect(eraser.pointer).toHaveBeenCalledWith(expect.objectContaining({ type: "down" }));
  });
});
