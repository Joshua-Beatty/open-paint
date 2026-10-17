import { useTranslation } from "@openpaint/i18n/react";
import { Icon, TooltipTrigger } from "@openpaint/ui";
import { memo } from "react";
import { Button, Separator, ToggleButton, Toolbar, Tooltip } from "react-aria-components";
import type { BuiltInCommandId } from "../commands/catalog";
import { PHOSPHOR } from "../icons/icon-set";
import type { CommonActionEntry, CommonActionsEntry } from "../menus/menu-model";

/** The 16 px icon of each button, from the app's icon set, drawn in the current text color. */
const ICONS: Partial<Record<BuiltInCommandId, string>> = {
  "file.new": PHOSPHOR.filePlus,
  "file.open": PHOSPHOR.folderOpen,
  "file.save": PHOSPHOR.floppyDisk,
  "file.saveAll": PHOSPHOR.floppyDiskBack,
  "file.print": PHOSPHOR.printer,
  "edit.cut": PHOSPHOR.scissors,
  "edit.copy": PHOSPHOR.copy,
  "edit.paste": PHOSPHOR.clipboard,
  "image.crop": PHOSPHOR.crop,
  "edit.deselect": PHOSPHOR.selectionSlash,
  "edit.undo": PHOSPHOR.arrowUUpLeft,
  "edit.redo": PHOSPHOR.arrowUUpRight,
  "view.pixelGrid": PHOSPHOR.gridNine,
  "view.rulers": PHOSPHOR.ruler,
};

/** The icon data of a common action's button, or undefined for a command without one. */
export function commonActionIcon(id: BuiltInCommandId): string | undefined {
  return ICONS[id];
}

function ActionIcon({ id }: { readonly id: BuiltInCommandId }) {
  return <Icon icon={ICONS[id] ?? ""} className="app-common-icon" />;
}

export interface CommonActionsBarProps {
  readonly entries: readonly CommonActionsEntry[];
  readonly onCommand: (id: BuiltInCommandId) => void;
}

function CommonActionButton({
  action,
  onCommand,
}: {
  readonly action: CommonActionEntry;
  readonly onCommand: (id: BuiltInCommandId) => void;
}) {
  const t = useTranslation();
  const tip =
    action.shortcut === undefined
      ? action.name
      : t("shell.common.tip", { name: action.name, shortcut: action.shortcut });
  return (
    <TooltipTrigger delay={500}>
      {action.toggle ? (
        <ToggleButton
          className="app-common-button"
          aria-label={action.name}
          isDisabled={!action.enabled}
          isSelected={action.checked}
          onChange={() => onCommand(action.id)}
        >
          <ActionIcon id={action.id} />
        </ToggleButton>
      ) : (
        <Button
          className="app-common-button"
          aria-label={action.name}
          isDisabled={!action.enabled}
          onPress={() => onCommand(action.id)}
        >
          <ActionIcon id={action.id} />
        </Button>
      )}
      <Tooltip className="app-tooltip">{tip}</Tooltip>
    </TooltipTrigger>
  );
}

/**
 * The common-actions strip (UI-TB-01): icon buttons for the file, clipboard, selection, history and
 * view commands, always shown, even with no image open. The entries come from the menu model, so
 * each button is enabled exactly when its menu item is. Arrow keys move between the buttons
 * (WEB-A11Y-01).
 */
function CommonActionsBarView({ entries, onCommand }: CommonActionsBarProps) {
  const t = useTranslation();
  return (
    <Toolbar aria-label={t("shell.commonActions")} className="app-common-actions">
      {entries.map((entry, index) =>
        entry.kind === "separator" ? (
          <Separator
            // biome-ignore lint/suspicious/noArrayIndexKey: the strip's layout is fixed, so a separator's position names it
            key={`separator-${index}`}
            orientation="vertical"
            className="app-common-separator"
          />
        ) : (
          <CommonActionButton key={entry.id} action={entry} onCommand={onCommand} />
        ),
      )}
    </Toolbar>
  );
}

function sameEntries(a: readonly CommonActionsEntry[], b: readonly CommonActionsEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    if (entry.kind === "separator" || other?.kind !== "action") return entry.kind === other?.kind;
    return (
      entry.id === other.id &&
      entry.name === other.name &&
      entry.shortcut === other.shortcut &&
      entry.enabled === other.enabled &&
      entry.checked === other.checked
    );
  });
}

/**
 * Renders again only when a button's state changes, not on every render of the app around it, so
 * pointer moves and previews never reach it (L3).
 */
export const CommonActionsBar = memo(
  CommonActionsBarView,
  (before, after) =>
    before.onCommand === after.onCommand && sameEntries(before.entries, after.entries),
);
