import type { ToolDescriptor, ToolRuntime } from "@openpaint/extension-api";
import type { SettingValue } from "@openpaint/storage";
import { describe, expect, it, vi } from "vitest";
import { TOOL_REGISTRY } from "./roster";
import {
  ACTIVE_TOOL_PATH,
  resolveActiveTool,
  ToolController,
  type ToolSettings,
} from "./tool-controller";

interface MemorySettings extends ToolSettings {
  readonly values: Map<string, SettingValue>;
}

function memorySettings(initial: Record<string, SettingValue> = {}): MemorySettings {
  const values = new Map<string, SettingValue>(Object.entries(initial));
  return {
    values,
    get: (path) => values.get(path),
    set: (path, value) => {
      values.set(path, value);
    },
  };
}

function fakeRuntime(pending: boolean) {
  return {
    activate: vi.fn(),
    deactivate: vi.fn(),
    pointer: vi.fn(),
    hasPending: vi.fn(() => pending),
    commit: vi.fn(),
    cancel: vi.fn(),
  } satisfies ToolRuntime & Record<string, unknown>;
}

describe("resolveActiveTool", () => {
  it("gives the default tool for a missing or unknown value", () => {
    expect(resolveActiveTool(TOOL_REGISTRY, undefined).id).toBe("paintbrush");
    expect(resolveActiveTool(TOOL_REGISTRY, "nothing").id).toBe("paintbrush");
    expect(resolveActiveTool(TOOL_REGISTRY, 3).id).toBe("paintbrush");
  });

  it("gives the stored tool", () => {
    expect(resolveActiveTool(TOOL_REGISTRY, "zoom").id).toBe("zoom");
  });
});

describe("ToolController", () => {
  it("keeps the default tool active and stores nothing until settings attach", () => {
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => undefined,
    });
    expect(controller.active.id).toBe("paintbrush");
    expect(controller.activate("zoom")).toBe(false);
    expect(controller.handleHotkey("z", { reverse: false })).toBe(false);
  });

  it("gives pasted text to the active tool only when its runtime takes text", () => {
    const settings = memorySettings();
    const paste = vi.fn();
    let takes = false;
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => ({
        ...fakeRuntime(false),
        acceptsPaste: () => takes,
        paste,
      }),
    });
    controller.attach(settings);
    expect(controller.acceptsPaste()).toBe(false);
    expect(controller.pasteText("Hi")).toBe(false);
    expect(paste).not.toHaveBeenCalled();

    takes = true;
    expect(controller.acceptsPaste()).toBe(true);
    expect(controller.pasteText("Hi")).toBe(true);
    expect(paste).toHaveBeenCalledWith("Hi");
  });

  it("is editing while a pointer is held or the active tool has a pending result", () => {
    let pending = false;
    const createRuntime = vi.fn(() => ({ ...fakeRuntime(false), hasPending: () => pending }));
    const controller = new ToolController({ registry: TOOL_REGISTRY, createRuntime });
    expect(controller.editing).toBe(false);
    expect(createRuntime).not.toHaveBeenCalled();
    controller.runtime();
    controller.setPointerHeld(true);
    expect(controller.editing).toBe(true);
    controller.setPointerHeld(false);
    expect(controller.editing).toBe(false);
    pending = true;
    expect(controller.editing).toBe(true);
  });

  it("finishes a pending result of the current runtime, and never creates one to do so", () => {
    let pending = true;
    const runtime = { ...fakeRuntime(false), hasPending: vi.fn(() => pending) };
    const createRuntime = vi.fn(() => runtime);
    const controller = new ToolController({ registry: TOOL_REGISTRY, createRuntime });
    controller.finishPending();
    expect(createRuntime).not.toHaveBeenCalled();
    controller.runtime();
    controller.finishPending();
    expect(runtime.commit).toHaveBeenCalledTimes(1);
    pending = false;
    controller.finishPending();
    expect(runtime.commit).toHaveBeenCalledTimes(1);
  });

  it("does not create a runtime to answer whether the active tool takes paste", () => {
    const settings = memorySettings();
    const createRuntime = vi.fn(() => fakeRuntime(false));
    const controller = new ToolController({ registry: TOOL_REGISTRY, createRuntime });
    controller.attach(settings);
    expect(controller.acceptsPaste()).toBe(false);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("stores the active tool and switches the runtime when a tool is activated", () => {
    const settings = memorySettings();
    const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>();
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: (tool: ToolDescriptor) => {
        const runtime = fakeRuntime(false);
        runtimes.set(tool.id, runtime);
        return runtime;
      },
    });
    controller.attach(settings);
    expect(controller.runtime()).toBe(runtimes.get("paintbrush"));

    expect(controller.activate("zoom")).toBe(true);
    expect(settings.values.get(ACTIVE_TOOL_PATH)).toBe("zoom");
    expect(runtimes.get("paintbrush")?.deactivate).toHaveBeenCalledTimes(1);
    expect(runtimes.get("zoom")?.activate).toHaveBeenCalledTimes(1);
    expect(controller.runtime()).toBe(runtimes.get("zoom"));
  });

  it("remembers the tool that was active before the last switch", () => {
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => undefined,
    });
    controller.attach(memorySettings());
    expect(controller.previous).toBeUndefined();
    controller.activate("zoom");
    expect(controller.previous).toBe("paintbrush");
    controller.activate("pencil");
    expect(controller.previous).toBe("zoom");
    controller.activate("pencil");
    expect(controller.previous).toBe("zoom");
  });

  it("commits the previous tool's pending result before switching away", () => {
    const runtimes = new Map<string, ReturnType<typeof fakeRuntime>>();
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: (tool) => {
        const runtime = fakeRuntime(tool.id === "lineCurve");
        runtimes.set(tool.id, runtime);
        return runtime;
      },
    });
    controller.attach(memorySettings());
    controller.activate("lineCurve");
    controller.activate("paintbrush");
    const lineCurve = runtimes.get("lineCurve");
    expect(lineCurve?.commit).toHaveBeenCalledTimes(1);
    expect(lineCurve?.deactivate).toHaveBeenCalledTimes(1);
  });

  it("does not switch when the same tool is activated again", () => {
    const settings = memorySettings({ [ACTIVE_TOOL_PATH]: "zoom" });
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => undefined,
    });
    controller.attach(settings);
    const set = vi.spyOn(settings, "set");
    expect(controller.activate("zoom")).toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  it("cycles the hotkey within the window and wraps around", () => {
    let clock = 10_000;
    const settings = memorySettings();
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => undefined,
      now: () => clock,
    });
    controller.attach(settings);
    expect(controller.handleHotkey("S", { reverse: false })).toBe(true);
    expect(controller.active.id).toBe("rectangleSelect");
    clock += 500;
    controller.handleHotkey("s", { reverse: false });
    expect(controller.active.id).toBe("lassoSelect");
    clock += 5_000;
    controller.handleHotkey("s", { reverse: false });
    expect(controller.active.id).toBe("rectangleSelect");
  });

  it("reverses the cycle with Shift", () => {
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => undefined,
    });
    controller.attach(memorySettings({ [ACTIVE_TOOL_PATH]: "rectangleSelect" }));
    controller.handleHotkey("S", { reverse: true });
    expect(controller.active.id).toBe("magicWand");
  });

  it("consumes a hotkey but does not switch while a pointer is held", () => {
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => undefined,
    });
    controller.attach(memorySettings());
    controller.setPointerHeld(true);
    expect(controller.handleHotkey("Z", { reverse: false })).toBe(true);
    expect(controller.active.id).toBe("paintbrush");
  });

  it("steps a number option within its range", () => {
    const settings = memorySettings({ "tools.brush.size": 2 });
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => undefined,
    });
    controller.attach(settings);
    controller.stepOption("brush.size", -5);
    expect(settings.values.get("tools.brush.size")).toBe(1);
    controller.stepOption("brush.size", 2000);
    expect(settings.values.get("tools.brush.size")).toBe(2000);
  });

  it("cycles a choice option", () => {
    const settings = memorySettings({ "tools.pen.dashStyle": "Solid" });
    const controller = new ToolController({
      registry: TOOL_REGISTRY,
      createRuntime: () => undefined,
    });
    controller.attach(settings);
    controller.cycleOption("pen.dashStyle", 1);
    expect(settings.values.get("tools.pen.dashStyle")).toBe("Dashes");
    controller.cycleOption("pen.dashStyle", -1);
    expect(settings.values.get("tools.pen.dashStyle")).toBe("Solid");
  });
});
