import type { MessageId } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import { type ReactNode, useId } from "react";
import { Button } from "react-aria-components";
import type { PanelId } from "./panel-layout";

export const PANEL_TITLES: Readonly<Record<PanelId, MessageId>> = {
  tools: "panel.tools",
  colors: "panel.colors",
  layers: "panel.layers",
  history: "panel.history",
};

export interface PanelFrameProps {
  readonly panel: PanelId;
  /** Whether the header has a collapse chevron. Tools has none (UI-FTW-01). */
  readonly collapsible: boolean;
  readonly collapsed?: boolean;
  /** The outer height in CSS px, header included. Omit it to fill the sidebar. */
  readonly height?: number;
  readonly onToggle?: () => void;
  /** Returns keyboard focus to the canvas after a pointer click in the panel (UI-FTW-01). */
  readonly onRelinquish: () => void;
  readonly children?: ReactNode;
}

/** A docked panel: a header with its title and chevron, and a body that a collapse hides. */
export function PanelFrame({
  panel,
  collapsible,
  collapsed = false,
  height,
  onToggle,
  onRelinquish,
  children,
}: PanelFrameProps) {
  const t = useTranslation();
  const titleId = useId();
  const bodyId = useId();
  const title = t(PANEL_TITLES[panel]);
  return (
    <section
      aria-labelledby={titleId}
      className={height === undefined ? "app-panel is-fill" : "app-panel"}
      style={height === undefined ? undefined : { height }}
    >
      <header className="app-panel-header">
        {collapsible && (
          <Button
            className="app-panel-chevron"
            aria-label={
              collapsed
                ? t("panel.expand", { panel: title })
                : t("panel.collapse", { panel: title })
            }
            aria-expanded={!collapsed}
            aria-controls={collapsed ? undefined : bodyId}
            onPress={(event) => {
              onToggle?.();
              if (event.pointerType !== "keyboard") onRelinquish();
            }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 10 10"
              className={
                collapsed ? "app-panel-chevron-icon is-collapsed" : "app-panel-chevron-icon"
              }
            >
              <path d="M2 3.5 5 6.5 8 3.5" />
            </svg>
          </Button>
        )}
        <h2 id={titleId} className="app-panel-title">
          {title}
        </h2>
      </header>
      {!collapsed && (
        <div id={bodyId} className="app-panel-body">
          {children}
        </div>
      )}
    </section>
  );
}
