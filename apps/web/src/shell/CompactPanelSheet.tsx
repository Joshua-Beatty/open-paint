import { useTranslation } from "@openpaint/i18n/react";
import { Icon } from "@openpaint/ui";
import type { KeyboardEvent, ReactNode } from "react";
import { Button, Group, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { PHOSPHOR } from "../icons/icon-set";
import { PANEL_TITLES } from "./PanelFrame";
import type { RightPanelId } from "./panel-layout";

/** The panels the compact sheet shows, one at a time, in the right sidebar's order. */
export const SHEET_PANELS: readonly RightPanelId[] = ["colors", "layers", "history"];

const PANEL_ICONS: Readonly<Record<RightPanelId, string>> = {
  colors: PHOSPHOR.palette,
  layers: PHOSPHOR.stack,
  history: PHOSPHOR.clockCounterClockwise,
};

export interface PanelSheetButtonsProps {
  /** The panel the sheet shows, or undefined while it is closed. */
  readonly open: RightPanelId | undefined;
  readonly onToggle: (panel: RightPanelId) => void;
}

/**
 * The compact top bar's panel buttons, in the place of the aux panel toggles (UI-AUX-01). Each one
 * opens the sheet at its panel, or closes the sheet when it already shows that panel.
 */
export function PanelSheetButtons({ open, onToggle }: PanelSheetButtonsProps) {
  const t = useTranslation();
  return (
    <Group aria-label={t("shell.aux.panels")} className="app-compact-panels">
      {SHEET_PANELS.map((panel) => (
        <ToggleButton
          key={panel}
          className="app-compact-button"
          aria-label={t(PANEL_TITLES[panel])}
          data-panel-toggle={panel}
          isSelected={open === panel}
          onChange={() => onToggle(panel)}
        >
          <Icon icon={PANEL_ICONS[panel]} className="app-common-icon" />
        </ToggleButton>
      ))}
    </Group>
  );
}

export interface CompactPanelSheetProps {
  readonly panel: RightPanelId;
  readonly onSelect: (panel: RightPanelId) => void;
  readonly onClose: () => void;
  readonly colors?: ReactNode;
  readonly layers?: ReactNode;
  readonly history?: ReactNode;
}

/**
 * The compact layout's panel sheet: Colors, Layers or History, one at a time, over the canvas. It
 * is a bottom sheet in portrait and a drawer at the right edge otherwise (the stylesheet decides
 * from the shell's classes). It is not modal: the canvas stays usable beside it. Esc inside it,
 * its close button or its panel button again closes it.
 */
export function CompactPanelSheet({
  panel,
  onSelect,
  onClose,
  colors,
  layers,
  history,
}: CompactPanelSheetProps) {
  const t = useTranslation();
  const title = t(PANEL_TITLES[panel]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };
  return (
    <section className="app-sheet" aria-label={title} data-panel={panel} onKeyDown={onKeyDown}>
      <header className="app-sheet-header">
        <ToggleButtonGroup
          className="app-sheet-tabs"
          aria-label={t("shell.aux.panels")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[panel]}
          onSelectionChange={(keys) => {
            const [next] = keys;
            if (typeof next === "string" && next !== panel) onSelect(next as RightPanelId);
          }}
        >
          {SHEET_PANELS.map((id) => (
            <ToggleButton key={id} id={id} className="app-sheet-tab">
              {t(PANEL_TITLES[id])}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Button
          className="app-compact-button app-sheet-close"
          aria-label={t("shell.sheet.close", { panel: title })}
          onPress={onClose}
        >
          <Icon icon={PHOSPHOR.x} className="app-common-icon" />
        </Button>
      </header>
      <div className="app-sheet-body">
        {panel === "colors" ? colors : panel === "layers" ? layers : history}
      </div>
    </section>
  );
}
