import { useTranslation } from "@openpaint/i18n/react";
import { TooltipTrigger } from "@openpaint/ui";
import { Button, Tooltip } from "react-aria-components";
import type { MenuCommands } from "../menus/menu-model";

export interface SettingsButtonProps {
  readonly commands: MenuCommands;
  readonly onOpen: () => void;
}

/** The "Settings (Alt+X)" button beside the panel toggles (SET-DLG-01). */
export function SettingsButton({ commands, onOpen }: SettingsButtonProps) {
  const t = useTranslation();
  const shortcut = commands.labels("edit.settings").shortcuts[0];
  return (
    <TooltipTrigger delay={500}>
      <Button className="app-aux-button" onPress={onOpen}>
        {t("shell.aux.settings")}
      </Button>
      <Tooltip className="app-tooltip">
        {shortcut === undefined
          ? t("shell.aux.settings")
          : t("shell.aux.settingsTip", { shortcut })}
      </Tooltip>
    </TooltipTrigger>
  );
}
