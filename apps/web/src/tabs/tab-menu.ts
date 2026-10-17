import type { Translate } from "@openpaint/i18n";
import type { BuiltInCommandId } from "../commands/catalog";
import type { MenuCommands, MenuEntry, MenuItemEntry } from "../menus/menu-model";

function commandItem(id: BuiltInCommandId, label: string, commands: MenuCommands): MenuItemEntry {
  return {
    kind: "item",
    id,
    label,
    shortcut: commands.labels(id).shortcuts[0],
    enabled: commands.isEnabled(id),
    checked: false,
    action: { type: "command", command: id },
  };
}

/**
 * The image-tab context menu (UI-MENU-TAB): the file name as a disabled title, Copy File Name,
 * then Save, Save As and Close. Save and Save As are enabled only once their commands have
 * handlers, so the menu follows the command system like every other menu.
 */
export function tabMenuEntries(
  title: string,
  commands: MenuCommands,
  t: Translate,
): readonly MenuEntry[] {
  return [
    { kind: "item", id: "tab.title", label: title, enabled: false, checked: false },
    { kind: "separator" },
    // Images have no file name until the open and save flows exist, so this stays disabled
    // (UI-MENU-TAB item 2: disabled if the image has never been saved).
    {
      kind: "item",
      id: "tab.copyFileName",
      label: t("menu.tab.copyFileName"),
      enabled: false,
      checked: false,
    },
    { kind: "separator" },
    commandItem("file.save", t("menu.file.save"), commands),
    commandItem("file.saveAs", t("menu.file.saveAs"), commands),
    commandItem("file.close", t("menu.file.close"), commands),
  ];
}
