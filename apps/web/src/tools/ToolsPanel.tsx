import type { ToolDescriptor } from "@openpaint/extension-api";
import { useTranslation } from "@openpaint/i18n/react";
import { TooltipTrigger } from "@openpaint/ui";
import { ToggleButton, ToggleButtonGroup, Tooltip } from "react-aria-components";
import { ToolIcon } from "./tool-icons";
import "./tools.css";

export interface ToolsPanelProps {
  /** The tools in roster order (TL-ROSTER-01). */
  readonly tools: readonly ToolDescriptor[];
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
}

/** The Tools panel's grid is two buttons wide (UI-FTW-03). Matches `.tools-grid` in tools.css. */
export const TOOL_COLUMNS = 2;

/**
 * Whether the button at `index` of `count` spans the whole row: the last one when it would sit
 * alone in the last row, so an odd number of tools still fills the grid.
 */
export function spansRow(index: number, count: number): boolean {
  return count % TOOL_COLUMNS !== 0 && index === count - 1;
}

/**
 * The Tools panel body: a two-column grid of tool buttons in roster order (TL-ROSTER-01). With an
 * odd number of tools the last button spans both columns. Each tooltip reads "{name}" and
 * "Shortcut key: {key}" (TL-ROSTER-03).
 */
export function ToolsPanel({ tools, activeId, onSelect }: ToolsPanelProps) {
  const t = useTranslation();
  return (
    <ToggleButtonGroup
      className="tools-grid"
      aria-label={t("panel.tools")}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[activeId]}
      onSelectionChange={(keys) => {
        const [id] = keys;
        if (typeof id === "string" && id !== activeId) onSelect(id);
      }}
    >
      {tools.map((tool, index) => {
        const name = t(tool.label);
        const wide = spansRow(index, tools.length);
        return (
          <TooltipTrigger key={tool.id}>
            <ToggleButton
              id={tool.id}
              aria-label={name}
              className={wide ? "tool-button is-wide" : "tool-button"}
            >
              <ToolIcon icon={tool.icon} wide={wide} />
            </ToggleButton>
            <Tooltip className="tool-tooltip">
              {t("tool.tooltip", { name, key: tool.hotkey })}
            </Tooltip>
          </TooltipTrigger>
        );
      })}
    </ToggleButtonGroup>
  );
}
