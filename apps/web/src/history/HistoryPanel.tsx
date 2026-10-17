import type { Document } from "@openpaint/document";
import type { MessageId, Translate } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import { Icon, TooltipTrigger } from "@openpaint/ui";
import { useEffect, useMemo, useRef } from "react";
import { Button, Toolbar, Tooltip } from "react-aria-components";
import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import { PHOSPHOR } from "../icons/icon-set";
import { useDocumentRevision } from "../layers/use-document-revision";
import { currentStep, type HistoryIconKind, historyIconFor, historyIcons } from "./history-list";

/** The icon of a step, drawn in the panel's current color (UI-FTW-04). */
function HistoryIcon({ kind }: { readonly kind: HistoryIconKind }) {
  return (
    <svg className="app-history-icon" viewBox="0 0 16 16" aria-hidden="true" data-kind={kind}>
      {kind === "document" && (
        <path d="M4 1.5h5l3.5 3.5v9.5h-8.5zM9 1.5V5h3.5" fill="none" stroke="currentColor" />
      )}
      {kind === "layer" && (
        <path d="M8 2 14 5 8 8 2 5zM2 8l6 3 6-3M2 11l6 3 6-3" fill="none" stroke="currentColor" />
      )}
      {kind === "image" && (
        <path d="M1.5 2.5h13v11h-13zM3 12l3.5-4 2.5 3 2-2 2 3" fill="none" stroke="currentColor" />
      )}
      {kind === "selection" && (
        <path d="M2.5 2.5h11v11h-11z" fill="none" stroke="currentColor" strokeDasharray="2 1.5" />
      )}
      {kind === "pixels" && (
        <path d="M2 14c3 0 3-3 5-4l3 3c-1 2-4 2-8 1zM9 6l4-4 2 2-4 4z" fill="currentColor" />
      )}
      {kind === "generic" && <circle cx="8" cy="8" r="3" fill="currentColor" />}
    </svg>
  );
}

interface ToolbarAction {
  readonly key: string;
  /** The button's accessible name. */
  readonly name: MessageId;
  /** The 16 px icon, the same as the common-actions toolbar's. */
  readonly icon: string;
  readonly tip: MessageId;
  /** The command that runs when pressed, when the action has a shortcut. */
  readonly command?: BuiltInCommandId;
  readonly isEnabled: () => boolean;
  readonly run: () => void;
}

/** The tooltip of a toolbar button: its name, and its shortcut when it has one. */
function tooltipFor(
  t: Translate,
  action: ToolbarAction,
  commands: ShortcutController<BuiltInCommandId>,
): string {
  const name = t(action.tip);
  if (action.command === undefined) return name;
  const shortcut = commands.labels(action.command).shortcuts[0] ?? "";
  return t("history.panel.tip.shortcut", { name, shortcut });
}

export interface HistoryPanelProps {
  /** The active image, or undefined when none is open. */
  readonly doc: Document | undefined;
  readonly commands: ShortcutController<BuiltInCommandId>;
}

/**
 * The History panel (UI-FTW-04): the steps of the active image, oldest first, each with an icon and
 * its name. Undone steps are dimmed. Clicking a step undoes or redoes until it is the current one.
 * The list keeps the current step in view, and the toolbar holds Undo and Redo.
 */
export function HistoryPanel({ doc, commands }: HistoryPanelProps) {
  const t = useTranslation();
  useDocumentRevision(doc);
  const icons = useMemo(() => historyIcons(t), [t]);
  const listRef = useRef<HTMLOListElement>(null);
  const history = doc?.history;
  const entries = history?.entries ?? [];
  const current = currentStep(entries);
  const busy = history?.busy === true;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again when the current step or the image changes
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-current="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current, doc]);

  const actions: readonly ToolbarAction[] = [
    {
      key: "undo",
      name: "history.panel.undo",
      icon: PHOSPHOR.arrowUUpLeft,
      tip: "history.panel.tip.undo",
      command: "edit.undo",
      isEnabled: () => commands.isEnabled("edit.undo"),
      run: () => commands.invoke("edit.undo"),
    },
    {
      key: "redo",
      name: "history.panel.redo",
      icon: PHOSPHOR.arrowUUpRight,
      tip: "history.panel.tip.redo",
      command: "edit.redo",
      isEnabled: () => commands.isEnabled("edit.redo"),
      run: () => commands.invoke("edit.redo"),
    },
  ];

  return (
    <div className="app-history">
      {doc === undefined ? (
        <p className="app-history-empty">{t("history.panel.empty")}</p>
      ) : (
        <ol ref={listRef} className="app-history-list" aria-label={t("history.panel.list")}>
          {entries.map((entry, index) => {
            const isCurrent = index === current;
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are only appended or removed at the end, and the index is the step's position
                key={index}
                data-current={isCurrent ? "true" : undefined}
                aria-current={isCurrent ? "step" : undefined}
                className={entry.applied ? "app-history-row" : "app-history-row is-undone"}
              >
                <Button
                  className="app-history-item"
                  isDisabled={busy}
                  onPress={() => void history?.seek(index + 1)}
                >
                  <HistoryIcon kind={historyIconFor(entry.name, icons)} />
                  <span className="app-history-name">{entry.name}</span>
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      <Toolbar aria-label={t("history.panel.toolbar")} className="app-history-toolbar">
        {actions.map((action) => (
          <TooltipTrigger key={action.key} delay={500}>
            <Button
              className="app-panel-tool"
              aria-label={t(action.name)}
              isDisabled={!action.isEnabled()}
              onPress={action.run}
            >
              <Icon icon={action.icon} className="app-panel-tool-icon" />
            </Button>
            <Tooltip className="app-tooltip">{tooltipFor(t, action, commands)}</Tooltip>
          </TooltipTrigger>
        ))}
      </Toolbar>
    </div>
  );
}
