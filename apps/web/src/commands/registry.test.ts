import { enUS } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import { BUILT_IN_COMMANDS, BUILT_IN_REGISTRY, type BuiltInCommandId } from "./catalog";
import type { KeyEventLike } from "./keys";
import { type CommandDefinition, CommandRegistry } from "./registry";

function event(code: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers };
}

/** The bindings from 02, 03, 04, 05 and 10 that the table must carry, with their alternates. */
const SPEC_BINDINGS: ReadonlyArray<
  readonly [BuiltInCommandId, readonly string[], readonly string[]]
> = [
  ["file.new", ["Ctrl+N"], ["Alt+N"]],
  ["file.open", ["Ctrl+O"], []],
  ["file.save", ["Ctrl+S"], []],
  ["file.saveAs", ["Ctrl+Shift+S"], []],
  ["file.saveAll", ["Ctrl+Alt+S"], []],
  ["file.print", ["Ctrl+P"], []],
  ["file.close", ["Ctrl+W"], ["Alt+W"]],
  ["edit.undo", ["Ctrl+Z"], []],
  ["edit.redo", ["Ctrl+Y"], []],
  ["edit.cut", ["Ctrl+X", "Shift+Delete"], []],
  ["edit.copy", ["Ctrl+C", "Ctrl+Insert"], []],
  ["edit.copyMerged", ["Ctrl+Shift+C"], []],
  ["edit.paste", ["Ctrl+V", "Shift+Insert"], []],
  ["edit.pasteIntoNewLayer", ["Ctrl+Shift+V"], []],
  ["edit.pasteIntoNewImage", ["Ctrl+Alt+V"], []],
  ["edit.copySelection", ["Ctrl+Shift+Alt+C"], []],
  ["edit.pasteSelectionReplace", ["Ctrl+Shift+Alt+V"], []],
  ["edit.eraseSelection", ["Delete"], []],
  ["edit.fillPrimary", ["Backspace"], []],
  ["edit.fillSecondary", ["Shift+Backspace"], []],
  ["edit.invertSelection", ["Ctrl+I"], []],
  ["edit.selectAll", ["Ctrl+A"], []],
  ["edit.deselect", ["Ctrl+D"], []],
  ["edit.settings", ["Alt+X"], []],
  ["view.zoomIn", ["Ctrl+NumpadAdd", "Ctrl+="], []],
  ["view.zoomOut", ["Ctrl+NumpadSubtract", "Ctrl+-"], []],
  ["view.zoomToWindow", ["Ctrl+B"], []],
  ["view.zoomToSelection", ["Ctrl+Shift+B"], []],
  ["view.actualSize", ["Ctrl+0", "Ctrl+Numpad0"], []],
  ["view.panelTools", ["F5"], ["Alt+F5"]],
  ["view.panelHistory", ["F6"], ["Alt+F6"]],
  ["view.panelLayers", ["F7"], ["Alt+F7"]],
  ["view.panelColors", ["F8"], ["Alt+F8"]],
  ["view.nextTab", ["Ctrl+Tab", "Ctrl+PageDown"], ["Alt+Shift+PageDown"]],
  ["view.previousTab", ["Ctrl+Shift+Tab", "Ctrl+PageUp"], ["Alt+Shift+PageUp"]],
  ["view.moveTabRight", ["Ctrl+Shift+PageDown"], []],
  ["view.moveTabLeft", ["Ctrl+Shift+PageUp"], []],
  ["view.pageUp", ["PageUp"], []],
  ["view.pageDown", ["PageDown"], []],
  ["view.pageLeft", ["Shift+PageUp"], []],
  ["view.pageRight", ["Shift+PageDown"], []],
  ["view.toStart", ["Home"], ["Ctrl+Home"]],
  ["view.toEnd", ["End"], ["Ctrl+End"]],
  ["view.goToTab1", ["Ctrl+1"], ["Alt+1"]],
  ["view.goToTab9", ["Ctrl+9"], ["Alt+9"]],
  ["view.goToTab10", ["Alt+0"], []],
  ["view.tabMenu", ["Alt+-"], []],
  ["image.crop", ["Ctrl+Shift+X"], []],
  ["image.resize", ["Ctrl+R"], []],
  ["image.canvasSize", ["Ctrl+Shift+R"], []],
  ["image.rotate90Cw", ["Ctrl+H"], ["Alt+Shift+H"]],
  ["image.rotate90Ccw", ["Ctrl+G"], []],
  ["image.flatten", ["Ctrl+Shift+F"], []],
  ["layers.add", ["Ctrl+Shift+N"], ["Alt+Shift+N"]],
  ["layers.delete", ["Ctrl+Shift+Delete"], []],
  ["layers.duplicate", ["Ctrl+Shift+D"], []],
  ["layers.mergeDown", ["Ctrl+M"], ["Alt+Shift+M"]],
  ["layers.toggleVisibility", ["Ctrl+,"], []],
  ["layers.rotateZoom", ["Ctrl+Shift+Z"], []],
  ["layers.goTop", ["Ctrl+Alt+PageUp"], []],
  ["layers.goAbove", ["Alt+PageUp"], []],
  ["layers.goBelow", ["Alt+PageDown"], []],
  ["layers.goBottom", ["Ctrl+Alt+PageDown"], []],
  ["layers.properties", ["F4"], []],
  ["adjustments.autoLevel", ["Ctrl+Shift+L"], []],
  ["adjustments.blackAndWhite", ["Ctrl+Shift+G"], []],
  ["adjustments.brightnessContrast", ["Ctrl+Shift+T"], ["Alt+Shift+T"]],
  ["adjustments.curves", ["Ctrl+Shift+M"], []],
  ["adjustments.hueSaturation", ["Ctrl+Shift+U"], []],
  ["adjustments.invertAlpha", ["Ctrl+Alt+I"], []],
  ["adjustments.invertColors", ["Ctrl+Shift+I"], []],
  ["adjustments.levels", ["Ctrl+L"], []],
  ["adjustments.posterize", ["Ctrl+Shift+P"], []],
  ["adjustments.sepia", ["Ctrl+Shift+E"], []],
  ["effects.repeat", ["Ctrl+F"], []],
  ["tools.brushSmaller", ["["], []],
  ["tools.brushSmaller5", ["Ctrl+["], ["Alt+["]],
  ["tools.brushLarger", ["]"], []],
  ["tools.brushLarger5", ["Ctrl+]"], ["Alt+]"]],
  ["tools.toleranceDown1", ["Shift+["], []],
  ["tools.toleranceUp5", ["Ctrl+Shift+]"], []],
  ["tools.swapColors", ["X"], []],
  ["tools.toggleColorTarget", ["C"], []],
  ["tools.penStartCap", [","], []],
  ["tools.penDash", ["."], []],
  ["tools.penEndCap", ["/"], []],
  ["tools.nextShape", ["A"], []],
  ["tools.previousShape", ["Shift+A"], []],
  ["help.openMenu", ["Alt+H"], []],
];

describe("built-in command table", () => {
  it("has a catalog message for every command", () => {
    for (const command of BUILT_IN_COMMANDS) {
      expect(enUS[command.messageId], command.id).toBeDefined();
    }
  });

  it.each(SPEC_BINDINGS)("binds %s as the spec does", (id, shortcuts, alternates) => {
    expect(BUILT_IN_REGISTRY.get(id).shortcuts).toEqual(shortcuts);
    expect(BUILT_IN_REGISTRY.get(id).alternates).toEqual(alternates);
  });

  it("labels bindings for Windows and for macOS (WEB-KEY-06)", () => {
    expect(BUILT_IN_REGISTRY.labels("file.save", "other")).toEqual({
      shortcuts: ["Ctrl+S"],
      alternates: [],
    });
    expect(BUILT_IN_REGISTRY.labels("file.save", "mac").shortcuts).toEqual(["⌘S"]);
    expect(BUILT_IN_REGISTRY.labels("view.zoomIn", "other").shortcuts).toEqual([
      "Ctrl++",
      "Ctrl+=",
    ]);
    expect(BUILT_IN_REGISTRY.labels("file.close", "other").alternates).toEqual(["Alt+W"]);
  });

  it("finds the command for a key, including its alternates", () => {
    expect(BUILT_IN_REGISTRY.find(event("KeyS", { ctrlKey: true }), "other")).toBe("file.save");
    expect(BUILT_IN_REGISTRY.find(event("KeyH", { altKey: true, shiftKey: true }), "other")).toBe(
      "image.rotate90Cw",
    );
    expect(BUILT_IN_REGISTRY.find(event("KeyS"), "other")).toBeUndefined();
  });
});

describe("CommandRegistry", () => {
  const save: CommandDefinition<"save"> = {
    id: "save",
    group: "file",
    messageId: "command.file.save",
    shortcuts: ["Ctrl+S"],
    alternates: [],
  };

  it("rejects a definition whose id is used twice", () => {
    expect(() => new CommandRegistry([save, { ...save }])).toThrow('"save" is defined twice');
  });

  it("rejects two commands that share a chord", () => {
    const print: CommandDefinition<"print"> = {
      ...save,
      id: "print",
      shortcuts: ["Ctrl+S"],
    };
    expect(() => new CommandRegistry([save, print])).toThrow(
      'Shortcut "Ctrl+S" is bound to both "save" and "print".',
    );
  });

  it("rejects an alternate that collides with another command's primary binding", () => {
    const other: CommandDefinition<"other"> = {
      ...save,
      id: "other",
      shortcuts: ["Ctrl+T"],
      alternates: ["Ctrl+S"],
    };
    expect(() => new CommandRegistry([save, other])).toThrow("bound to both");
  });

  it("rejects a chord that one command binds twice", () => {
    expect(() => new CommandRegistry([{ ...save, shortcuts: ["Ctrl+S", "Ctrl+S"] }])).toThrow(
      "bound to both",
    );
  });

  it("rejects an unknown command id", () => {
    const registry = new CommandRegistry([save]);
    expect(() => registry.get("missing" as "save")).toThrow('Unknown command "missing".');
  });

  it("lists commands in definition order and reports whether an id exists", () => {
    const registry = new CommandRegistry([save]);
    expect(registry.list().map((command) => command.id)).toEqual(["save"]);
    expect(registry.has("save")).toBe(true);
    expect(registry.has("open")).toBe(false);
  });

  it("gives a command with no shortcut no bindings", () => {
    const registry = new CommandRegistry([{ ...save, shortcuts: [] }]);
    expect(registry.labels("save", "other")).toEqual({ shortcuts: [], alternates: [] });
    expect(registry.find(event("KeyS", { ctrlKey: true }), "other")).toBeUndefined();
  });
});
