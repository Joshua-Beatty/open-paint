import { describe, expect, it } from "vitest";
import { BUILT_IN_REGISTRY } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import { TOOL_REGISTRY } from "./roster";
import { DRAWABLE_SHAPES } from "./shape-catalog";
import { registerToolOptionCommands } from "./tool-commands";
import { ACTIVE_TOOL_PATH, ToolController, type ToolSettings } from "./tool-controller";

function setup(active: string, shape: unknown) {
  const store = new Map<string, unknown>([
    [ACTIVE_TOOL_PATH, active],
    ["tools.shapes.shape", shape],
  ]);
  const settings: ToolSettings = {
    get: (path) => store.get(path) as never,
    set: (path, value) => {
      store.set(path, value);
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

describe("A and Shift+A in the Shapes tool (TL-SHAPE-01)", () => {
  it("moves to the next shape in picker order, and back with Shift+A", () => {
    const { store, shortcuts } = setup("shapes", { name: "rectangle" });
    expect(shortcuts.invoke("tools.nextShape")).toBe(true);
    expect(store.get("tools.shapes.shape")).toEqual({ name: "roundedRectangle" });
    expect(shortcuts.invoke("tools.previousShape")).toBe(true);
    expect(shortcuts.invoke("tools.previousShape")).toBe(true);
    expect(store.get("tools.shapes.shape")).toEqual({ name: DRAWABLE_SHAPES.at(-1)?.id });
  });

  it("wraps from the last shape to the first", () => {
    const last = DRAWABLE_SHAPES.at(-1)?.id;
    const { store, shortcuts } = setup("shapes", { name: last });
    shortcuts.invoke("tools.nextShape");
    expect(store.get("tools.shapes.shape")).toEqual({ name: "rectangle" });
  });

  it("does nothing outside the Shapes tool", () => {
    const { store, shortcuts } = setup("paintbrush", { name: "rectangle" });
    expect(shortcuts.invoke("tools.nextShape")).toBe(false);
    expect(store.get("tools.shapes.shape")).toEqual({ name: "rectangle" });
  });
});
