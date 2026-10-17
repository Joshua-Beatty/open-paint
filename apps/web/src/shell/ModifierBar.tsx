import type { MessageId } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import { Icon } from "@openpaint/ui";
import { useSyncExternalStore } from "react";
import { ToggleButton, Toolbar } from "react-aria-components";
import { PHOSPHOR } from "../icons/icon-set";
import type { VirtualKey, VirtualModifiers } from "../tools/virtual-modifiers";

const KEYS: readonly { readonly key: VirtualKey; readonly name: MessageId }[] = [
  { key: "shift", name: "touch.modifier.shift" },
  { key: "ctrl", name: "touch.modifier.ctrl" },
  { key: "alt", name: "touch.modifier.alt" },
  { key: "secondary", name: "touch.modifier.secondary" },
];

export interface ModifierBarProps {
  readonly modifiers: VirtualModifiers;
}

/**
 * On-screen Shift, Ctrl, Alt and right-button toggles over the canvas, for touch screens: a tool's
 * modifier behaviours (Shift constrains, Ctrl and Alt combine selections, the right button draws
 * with the secondary colour) have no other touch path. Each stays on until tapped again.
 */
export function ModifierBar({ modifiers }: ModifierBarProps) {
  const t = useTranslation();
  const state = useSyncExternalStore(modifiers.subscribe, () => modifiers.state);
  return (
    <Toolbar className="app-modifier-bar" aria-label={t("touch.modifiers")}>
      {KEYS.map(({ key, name }) => (
        <ToggleButton
          key={key}
          className="app-modifier-button"
          aria-label={t(name)}
          isSelected={state[key]}
          onChange={() => modifiers.toggle(key)}
        >
          {key === "secondary" ? (
            <Icon icon={PHOSPHOR.mouseRightClick} className="app-common-icon" />
          ) : (
            t(name)
          )}
        </ToggleButton>
      ))}
    </Toolbar>
  );
}
