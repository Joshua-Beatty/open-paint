import type { MessageId } from "@openpaint/i18n";
import { type CommandDefinition, type CommandGroup, CommandRegistry } from "./registry";

/**
 * The default bindings of every command with a shortcut, from 02, 03, 04, 05 and 10. "Ctrl" is
 * the primary modifier (WEB-KEY-01). Alternates are the always-active bindings from WEB-KEY-03.
 * Adjustments and effects are listed here so their shortcuts work before any menu is opened.
 */
function command<const Id extends string>(
  id: Id,
  group: CommandGroup,
  shortcuts: readonly string[],
  alternates: readonly string[] = [],
): CommandDefinition<Id> {
  return { id, group, messageId: `command.${id}` as MessageId, shortcuts, alternates };
}

function goToTab<const N extends number>(
  number: N,
  shortcuts: readonly string[],
  alternates: readonly string[] = [],
): CommandDefinition<`view.goToTab${N}`> {
  return {
    id: `view.goToTab${number}`,
    group: "view",
    messageId: "command.view.goToTab",
    values: { number },
    shortcuts,
    alternates,
  };
}

export const BUILT_IN_COMMANDS = [
  command("file.new", "file", ["Ctrl+N"], ["Alt+N"]),
  command("file.open", "file", ["Ctrl+O"]),
  command("file.save", "file", ["Ctrl+S"]),
  command("file.saveAs", "file", ["Ctrl+Shift+S"]),
  command("file.saveAll", "file", ["Ctrl+Alt+S"]),
  command("file.print", "file", ["Ctrl+P"]),
  command("file.close", "file", ["Ctrl+W"], ["Alt+W"]),
  command("file.closeAll", "file", []),
  command("file.clearRecent", "file", []),

  command("edit.undo", "edit", ["Ctrl+Z"]),
  command("edit.redo", "edit", ["Ctrl+Y"]),
  command("edit.cut", "edit", ["Ctrl+X", "Shift+Delete"]),
  command("edit.copy", "edit", ["Ctrl+C", "Ctrl+Insert"]),
  command("edit.copyMerged", "edit", ["Ctrl+Shift+C"]),
  command("edit.paste", "edit", ["Ctrl+V", "Shift+Insert"]),
  command("edit.pasteIntoNewLayer", "edit", ["Ctrl+Shift+V"]),
  command("edit.pasteIntoNewImage", "edit", ["Ctrl+Alt+V"]),
  command("edit.copySelection", "edit", ["Ctrl+Shift+Alt+C"]),
  command("edit.pasteSelectionReplace", "edit", ["Ctrl+Shift+Alt+V"]),
  command("edit.pasteSelectionAdd", "edit", []),
  command("edit.pasteSelectionExclude", "edit", []),
  command("edit.pasteSelectionIntersect", "edit", []),
  command("edit.pasteSelectionXor", "edit", []),
  command("edit.eraseSelection", "edit", ["Delete"]),
  command("edit.fillPrimary", "edit", ["Backspace"]),
  command("edit.fillSecondary", "edit", ["Shift+Backspace"]),
  command("edit.invertSelection", "edit", ["Ctrl+I"]),
  command("edit.selectAll", "edit", ["Ctrl+A"]),
  command("edit.deselect", "edit", ["Ctrl+D"]),
  command("edit.settings", "edit", ["Alt+X"]),

  command("view.zoomIn", "view", ["Ctrl+NumpadAdd", "Ctrl+="]),
  command("view.zoomOut", "view", ["Ctrl+NumpadSubtract", "Ctrl+-"]),
  command("view.zoomToWindow", "view", ["Ctrl+B"]),
  command("view.zoomToSelection", "view", ["Ctrl+Shift+B"]),
  command("view.actualSize", "view", ["Ctrl+0", "Ctrl+Numpad0"]),
  command("view.pixelGrid", "view", []),
  command("view.rulers", "view", []),
  command("view.unitsPixels", "view", []),
  command("view.unitsInches", "view", []),
  command("view.unitsCentimeters", "view", []),
  command("view.fullScreen", "view", []),
  command("view.pageUp", "view", ["PageUp"]),
  command("view.pageDown", "view", ["PageDown"]),
  command("view.pageLeft", "view", ["Shift+PageUp"]),
  command("view.pageRight", "view", ["Shift+PageDown"]),
  command("view.toStart", "view", ["Home"], ["Ctrl+Home"]),
  command("view.toEnd", "view", ["End"], ["Ctrl+End"]),
  command("view.panelTools", "view", ["F5"], ["Alt+F5"]),
  command("view.panelHistory", "view", ["F6"], ["Alt+F6"]),
  command("view.panelLayers", "view", ["F7"], ["Alt+F7"]),
  command("view.panelColors", "view", ["F8"], ["Alt+F8"]),
  command("view.nextTab", "view", ["Ctrl+Tab", "Ctrl+PageDown"], ["Alt+Shift+PageDown"]),
  command("view.previousTab", "view", ["Ctrl+Shift+Tab", "Ctrl+PageUp"], ["Alt+Shift+PageUp"]),
  command("view.moveTabRight", "view", ["Ctrl+Shift+PageDown"]),
  command("view.moveTabLeft", "view", ["Ctrl+Shift+PageUp"]),
  goToTab(1, ["Ctrl+1"], ["Alt+1"]),
  goToTab(2, ["Ctrl+2"], ["Alt+2"]),
  goToTab(3, ["Ctrl+3"], ["Alt+3"]),
  goToTab(4, ["Ctrl+4"], ["Alt+4"]),
  goToTab(5, ["Ctrl+5"], ["Alt+5"]),
  goToTab(6, ["Ctrl+6"], ["Alt+6"]),
  goToTab(7, ["Ctrl+7"], ["Alt+7"]),
  goToTab(8, ["Ctrl+8"], ["Alt+8"]),
  goToTab(9, ["Ctrl+9"], ["Alt+9"]),
  goToTab(10, ["Alt+0"]),
  command("view.tabMenu", "view", ["Alt+-"]),

  command("image.crop", "image", ["Ctrl+Shift+X"]),
  command("image.resize", "image", ["Ctrl+R"]),
  command("image.canvasSize", "image", ["Ctrl+Shift+R"]),
  command("image.rotate90Cw", "image", ["Ctrl+H"], ["Alt+Shift+H"]),
  command("image.rotate90Ccw", "image", ["Ctrl+G"]),
  command("image.rotate180", "image", []),
  command("image.flipHorizontal", "image", []),
  command("image.flipVertical", "image", []),
  command("image.flatten", "image", ["Ctrl+Shift+F"]),

  command("layers.add", "layers", ["Ctrl+Shift+N"], ["Alt+Shift+N"]),
  command("layers.delete", "layers", ["Ctrl+Shift+Delete"]),
  command("layers.duplicate", "layers", ["Ctrl+Shift+D"]),
  command("layers.mergeDown", "layers", ["Ctrl+M"], ["Alt+Shift+M"]),
  command("layers.toggleVisibility", "layers", ["Ctrl+,"]),
  command("layers.importFromFile", "layers", []),
  command("layers.flipHorizontal", "layers", []),
  command("layers.flipVertical", "layers", []),
  command("layers.rotate180", "layers", []),
  command("layers.rotateZoom", "layers", ["Ctrl+Shift+Z"]),
  command("layers.goTop", "layers", ["Ctrl+Alt+PageUp"]),
  command("layers.goAbove", "layers", ["Alt+PageUp"]),
  command("layers.goBelow", "layers", ["Alt+PageDown"]),
  command("layers.goBottom", "layers", ["Ctrl+Alt+PageDown"]),
  command("layers.moveTop", "layers", []),
  command("layers.moveUp", "layers", []),
  command("layers.moveDown", "layers", []),
  command("layers.moveBottom", "layers", []),
  command("layers.properties", "layers", ["F4"]),

  command("adjustments.autoLevel", "adjustments", ["Ctrl+Shift+L"]),
  command("adjustments.blackAndWhite", "adjustments", ["Ctrl+Shift+G"]),
  command("adjustments.brightnessContrast", "adjustments", ["Ctrl+Shift+T"], ["Alt+Shift+T"]),
  command("adjustments.curves", "adjustments", ["Ctrl+Shift+M"]),
  command("adjustments.hueSaturation", "adjustments", ["Ctrl+Shift+U"]),
  command("adjustments.invertAlpha", "adjustments", ["Ctrl+Alt+I"]),
  command("adjustments.invertColors", "adjustments", ["Ctrl+Shift+I"]),
  command("adjustments.levels", "adjustments", ["Ctrl+L"]),
  command("adjustments.posterize", "adjustments", ["Ctrl+Shift+P"]),
  command("adjustments.sepia", "adjustments", ["Ctrl+Shift+E"]),

  command("effects.repeat", "effects", ["Ctrl+F"]),

  command("tools.brushSmaller", "tools", ["["]),
  command("tools.brushSmaller5", "tools", ["Ctrl+["], ["Alt+["]),
  command("tools.brushLarger", "tools", ["]"]),
  command("tools.brushLarger5", "tools", ["Ctrl+]"], ["Alt+]"]),
  command("tools.toleranceDown1", "tools", ["Shift+["]),
  command("tools.toleranceUp1", "tools", ["Shift+]"]),
  command("tools.toleranceDown5", "tools", ["Ctrl+Shift+["]),
  command("tools.toleranceUp5", "tools", ["Ctrl+Shift+]"]),
  command("tools.swapColors", "tools", ["X"]),
  command("tools.toggleColorTarget", "tools", ["C"]),
  command("tools.penStartCap", "tools", [","]),
  command("tools.penDash", "tools", ["."]),
  command("tools.penEndCap", "tools", ["/"]),
  command("tools.nextShape", "tools", ["A"]),
  command("tools.previousShape", "tools", ["Shift+A"]),

  command("help.keyboardShortcuts", "help", []),
  command("help.about", "help", []),
  command("help.openMenu", "help", ["Alt+H"]),
];

export type BuiltInCommandId = (typeof BUILT_IN_COMMANDS)[number]["id"];

/** The registry of every built-in command. Building it checks the table for conflicts. */
export const BUILT_IN_REGISTRY = new CommandRegistry<BuiltInCommandId>(BUILT_IN_COMMANDS);
