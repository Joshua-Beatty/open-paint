import { useTranslation } from "@openpaint/i18n/react";
import { Icon } from "@openpaint/ui";
import { Button, MenuTrigger, Popover } from "react-aria-components";
import { PHOSPHOR } from "../icons/icon-set";
import {
  buildHelpMenu,
  buildMenu,
  MENU_NAMES,
  type MenuContext,
  type MenuEntry,
  menuTitle,
} from "../menus/menu-model";
import { type MenuActions, MenuList } from "./MenuBar";

export interface CompactMenuProps {
  readonly context: MenuContext;
  readonly actions: MenuActions;
}

/**
 * The compact layout's one menu: every main menu (File ... Effects) as a submenu, then Help and
 * Settings, which the desktop aux menu holds. The entries come from the same menu model as the
 * menu bar, built when the menu opens, so their enable states and the registry-generated
 * Adjustments and Effects menus are the same (UI-MENU).
 */
export function compactMenuEntries(context: MenuContext): readonly MenuEntry[] {
  return [
    ...MENU_NAMES.map(
      (name): MenuEntry => ({
        kind: "group",
        id: `menu.${name}`,
        label: menuTitle(name, context.t),
        entries: buildMenu(name, context),
      }),
    ),
    { kind: "separator" },
    {
      kind: "group",
      id: "menu.help",
      label: context.t("menu.help"),
      entries: buildHelpMenu(context),
    },
    {
      kind: "item",
      id: "edit.settings",
      label: context.t("shell.aux.settings"),
      shortcut: context.commands.labels("edit.settings").shortcuts[0],
      enabled: true,
      checked: false,
      action: { type: "command", command: "edit.settings" },
    },
  ];
}

/** The compact layout's menu button (UI-MENU in the compact layout). */
export function CompactMenu({ context, actions }: CompactMenuProps) {
  const t = useTranslation();
  return (
    <MenuTrigger>
      <Button
        className="app-compact-button"
        aria-label={t("shell.compact.menu")}
        data-menu-opener=""
      >
        <Icon icon={PHOSPHOR.list} className="app-common-icon" />
      </Button>
      <Popover className="app-popover app-compact-menu" placement="bottom start">
        <CompactMenuList context={context} actions={actions} />
      </Popover>
    </MenuTrigger>
  );
}

function CompactMenuList({ context, actions }: CompactMenuProps) {
  return (
    <MenuList
      label={context.t("shell.compact.menu")}
      entries={compactMenuEntries(context)}
      actions={actions}
    />
  );
}
