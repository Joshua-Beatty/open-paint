import { useTranslation } from "@openpaint/i18n/react";
import { TooltipTrigger } from "@openpaint/ui";
import { Group, ToggleButton, Tooltip } from "react-aria-components";
import type { MenuCommands } from "../menus/menu-model";
import { PANEL_TITLES } from "./PanelFrame";
import type { PanelId, PanelLayout } from "./panel-layout";
import { PANEL_COMMANDS } from "./panel-layout-settings";

/** The aux toggles in their UI-AUX-01 order. */
const AUX_ORDER: readonly PanelId[] = ["tools", "history", "layers", "colors"];

export interface AuxPanelTogglesProps {
  readonly layout: PanelLayout;
  readonly commands: MenuCommands;
  readonly onToggle: (panel: PanelId) => void;
}

/**
 * The panel toggles at the right of the menu bar (UI-AUX-01). Each one is checked while its panel
 * is visible, and its tooltip shows the panel's shortcut.
 */
export function AuxPanelToggles({ layout, commands, onToggle }: AuxPanelTogglesProps) {
  const t = useTranslation();
  return (
    <Group aria-label={t("shell.aux.panels")} className="app-aux-panels">
      {AUX_ORDER.map((panel) => {
        const name = t(PANEL_TITLES[panel]);
        const shortcut = commands.labels(PANEL_COMMANDS[panel]).shortcuts[0];
        return (
          <TooltipTrigger key={panel} delay={500}>
            <ToggleButton
              className="app-aux-button"
              aria-label={name}
              isSelected={layout.visible[panel]}
              onChange={() => onToggle(panel)}
            >
              {name}
            </ToggleButton>
            <Tooltip className="app-tooltip">
              {shortcut === undefined ? name : t("shell.aux.toggleTip", { panel: name, shortcut })}
            </Tooltip>
          </TooltipTrigger>
        );
      })}
    </Group>
  );
}
