import { useTranslation } from "@openpaint/i18n/react";
import { Button, MenuTrigger, Popover } from "react-aria-components";
import { buildHelpMenu, type MenuContext } from "../menus/menu-model";
import { type MenuActions, MenuList } from "./MenuBar";

export interface HelpMenuProps {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly context: MenuContext;
  readonly actions: MenuActions;
}

/**
 * The Help drop-down in the aux menu (UI-AUX-01, UI-MENU-HELP). Alt+H opens it through the
 * command registry, so `isOpen` is controlled. Its items are built when it opens.
 */
export function HelpMenu({ isOpen, onOpenChange, context, actions }: HelpMenuProps) {
  const t = useTranslation();
  return (
    <MenuTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      <Button className="app-aux-button" aria-label={t("shell.help")}>
        {t("shell.helpIcon")}
      </Button>
      <Popover className="app-popover" placement="bottom end">
        <HelpEntries context={context} actions={actions} />
      </Popover>
    </MenuTrigger>
  );
}

function HelpEntries({ context, actions }: Pick<HelpMenuProps, "context" | "actions">) {
  return (
    <MenuList label={context.t("menu.help")} entries={buildHelpMenu(context)} actions={actions} />
  );
}
