import type { MessageId } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import { useState } from "react";
import { Input, Label, SearchField } from "react-aria-components";
import type { ShortcutPlatform } from "../commands/keys";
import {
  COMMAND_GROUPS,
  type CommandDefinition,
  type CommandGroup,
  type CommandRegistry,
} from "../commands/registry";
import { ModalDialog } from "./ModalDialog";

const GROUP_MESSAGES: Readonly<Record<CommandGroup, MessageId>> = {
  file: "menu.file",
  edit: "menu.edit",
  view: "menu.view",
  image: "menu.image",
  layers: "menu.layers",
  adjustments: "menu.adjustments",
  effects: "menu.effects",
  tools: "menu.tools",
  help: "menu.help",
};

type Translate = ReturnType<typeof useTranslation>;

/** The text a search matches: the command name and every shown key label. */
function shortcutSearchText<Id extends string>(
  command: CommandDefinition<Id>,
  registry: CommandRegistry<Id>,
  platform: ShortcutPlatform,
  t: Translate,
): string[] {
  const labels = registry.labels(command.id, platform);
  return [t(command.messageId, command.values), ...labels.shortcuts, ...labels.alternates];
}

export interface KeyboardShortcutsProps<Id extends string> {
  isOpen: boolean;
  onClose: () => void;
  registry: CommandRegistry<Id>;
  platform: ShortcutPlatform;
}

/**
 * The read-only Keyboard Shortcuts reference (SET-HELP-03). It lists every command that has a
 * shortcut, grouped by menu, with its primary and alternate bindings, all built from the registry.
 */
export function KeyboardShortcuts<Id extends string>({
  isOpen,
  onClose,
  registry,
  platform,
}: KeyboardShortcutsProps<Id>) {
  const t = useTranslation();
  const [query, setQuery] = useState("");
  const commands = registry.list();
  const needle = query.trim().toLowerCase();
  const groups = COMMAND_GROUPS.flatMap((group) => {
    const rows = commands.filter(
      (command) =>
        command.group === group &&
        (command.shortcuts.length > 0 || command.alternates?.length) &&
        (needle === "" ||
          shortcutSearchText(command, registry, platform, t).some((text) =>
            text.toLowerCase().includes(needle),
          )),
    );
    return rows.length > 0 ? [{ group, rows }] : [];
  });

  return (
    <ModalDialog isOpen={isOpen} onClose={onClose} title={t("command.help.keyboardShortcuts")} wide>
      <SearchField className="shortcut-search" value={query} onChange={setQuery}>
        <Label>{t("shortcuts.search")}</Label>
        <Input />
      </SearchField>
      {groups.length === 0 && <p role="status">{t("shortcuts.noMatches")}</p>}
      {groups.map(({ group, rows }) => (
        <section key={group} className="shortcut-group">
          <h3>{t(GROUP_MESSAGES[group])}</h3>
          <table className="shortcut-table">
            <thead>
              <tr>
                <th scope="col">{t("shortcuts.command")}</th>
                <th scope="col">{t("shortcuts.shortcut")}</th>
                <th scope="col">{t("shortcuts.alternate")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const labels = registry.labels(row.id, platform);
                return (
                  <tr key={row.id}>
                    <th scope="row">{t(row.messageId, row.values)}</th>
                    <td>{labels.shortcuts.join(" / ")}</td>
                    <td>{labels.alternates.join(" / ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </ModalDialog>
  );
}
