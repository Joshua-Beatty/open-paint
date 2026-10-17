import { describe, expect, it } from "vitest";
import { BUILT_IN_REGISTRY } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import { TOOL_REGISTRY } from "./roster";
import { registerToolOptionCommands } from "./tool-commands";
import { ACTIVE_TOOL_PATH, ToolController, type ToolSettings } from "./tool-controller";

function setup(values: Record<string, string | number>) {
  const store = new Map<string, string | number>(Object.entries(values));
  const settings: ToolSettings = {
    get: (path) => store.get(path),
    set: (path, value) => {
      store.set(path, value as string | number);
    },
  };
  const controller = new ToolController({
    registry: TOOL_REGISTRY,
    createRuntime: () => undefined,
  });
  controller.attach(settings);
  const shortcuts = new ShortcutController(BUILT_IN_REGISTRY, "other");
  registerToolOptionCommands(shortcuts, controller);
  return { store, shortcuts };
}

describe("registerToolOptionCommands", () => {
  it("steps the brush size by 1 and by 5, within the range (TL-HOTKEY-02)", () => {
    const { store, shortcuts } = setup({ [ACTIVE_TOOL_PATH]: "paintbrush", "tools.brush.size": 2 });
    expect(shortcuts.invoke("tools.brushLarger")).toBe(true);
    expect(store.get("tools.brush.size")).toBe(3);
    expect(shortcuts.invoke("tools.brushLarger5")).toBe(true);
    expect(store.get("tools.brush.size")).toBe(8);
    expect(shortcuts.invoke("tools.brushSmaller5")).toBe(true);
    expect(store.get("tools.brush.size")).toBe(3);
  });

  it("does nothing when the active tool does not show brush size", () => {
    const { store, shortcuts } = setup({ [ACTIVE_TOOL_PATH]: "zoom", "tools.brush.size": 2 });
    expect(shortcuts.invoke("tools.brushLarger")).toBe(false);
    expect(store.get("tools.brush.size")).toBe(2);
  });

  it("cycles the dash style of a tool that shows it (TL-HOTKEY-02)", () => {
    const { store, shortcuts } = setup({
      [ACTIVE_TOOL_PATH]: "lineCurve",
      "tools.pen.dashStyle": "Solid",
    });
    expect(shortcuts.invoke("tools.penDash")).toBe(true);
    expect(store.get("tools.pen.dashStyle")).toBe("Dashes");
  });

  it("cycles the start cap of a line tool", () => {
    const { store, shortcuts } = setup({
      [ACTIVE_TOOL_PATH]: "lineCurve",
      "tools.pen.startCap": "Flat",
    });
    shortcuts.invoke("tools.penStartCap");
    expect(store.get("tools.pen.startCap")).toBe("Arrow");
  });
});
