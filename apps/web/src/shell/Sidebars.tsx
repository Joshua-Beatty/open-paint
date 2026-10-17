import { useTranslation } from "@openpaint/i18n/react";
import { Fragment, type KeyboardEvent, type PointerEvent, type ReactNode, useRef } from "react";
import { PANEL_TITLES, PanelFrame } from "./PanelFrame";
import {
  type Bodies,
  isSplitterMovable,
  minimumBody,
  moveSplitter,
  PANEL_HEADER_HEIGHT,
  type PanelLayout,
  RIGHT_SIDEBAR,
  type RightPanelId,
  rightBodies,
  splitRatiosFor,
  visibleRightPanels,
} from "./panel-layout";
import type { PanelActions } from "./panel-layout-settings";
import { useElementHeight } from "./use-panel-layout";

export interface LeftSidebarProps {
  readonly onRelinquish: () => void;
  /** The body of the Tools panel. */
  readonly tools?: ReactNode;
}

/** The left sidebar, which holds the Tools panel (UI-FTW-03). Its width comes from the shell. */
export function LeftSidebar({ onRelinquish, tools }: LeftSidebarProps) {
  return (
    <div className="app-sidebar-column">
      <PanelFrame panel="tools" collapsible={false} onRelinquish={onRelinquish}>
        {tools}
      </PanelFrame>
    </div>
  );
}

export interface RightSidebarProps {
  readonly layout: PanelLayout;
  readonly actions: PanelActions;
  /** The width the sidebar is drawn at, in CSS px. */
  readonly width: number;
  /** Whether the width can be dragged or stepped. It cannot below 1280 CSS px (UI-FTW-08). */
  readonly widthResizable: boolean;
  readonly onRelinquish: () => void;
  /**
   * The body of the Colors panel. It gets the function that expands or compacts the panel
   * (UI-FTW-06).
   */
  readonly colors?: (setExpanded: (expanded: boolean) => void) => ReactNode;
  /** The body of the Layers panel. */
  readonly layers?: ReactNode;
  /** The body of the History panel. */
  readonly history?: ReactNode;
}

/**
 * The right sidebar: Colors, Layers and History top to bottom, separated by splitters that resize
 * their heights, and an edge splitter that resizes the sidebar (UI-FTW-01, UI-FTW-08).
 */
export function RightSidebar({
  layout,
  actions,
  width,
  widthResizable,
  onRelinquish,
  colors,
  layers,
  history,
}: RightSidebarProps) {
  const t = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const total = useElementHeight(root);
  const bodies = rightBodies(layout, total);
  const visible = visibleRightPanels(layout);
  const widthDrag = useRef<{ x: number; width: number } | null>(null);

  const resizeBy = (delta: number) => actions.setRightSidebarWidth(width + delta);
  const setColorsExpanded = (expanded: boolean) => actions.setColorsExpanded(expanded);

  return (
    <div ref={root} className="app-sidebar-column app-right-sidebar">
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (WAI-ARIA) needs role separator on a div, since hr cannot take focus or drag */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("panel.widthSplitter")}
        aria-valuemin={RIGHT_SIDEBAR.min}
        aria-valuemax={RIGHT_SIDEBAR.max}
        aria-valuenow={width}
        aria-disabled={widthResizable ? undefined : true}
        tabIndex={widthResizable ? 0 : undefined}
        className="app-splitter app-splitter-width"
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          if (!widthResizable) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const rect = root.current?.getBoundingClientRect();
          widthDrag.current = { x: event.clientX, width: rect?.width ?? width };
        }}
        onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
          const start = widthDrag.current;
          if (start === null) return;
          actions.setRightSidebarWidth(start.width - (event.clientX - start.x));
        }}
        onPointerUp={() => {
          widthDrag.current = null;
        }}
        onPointerCancel={() => {
          widthDrag.current = null;
        }}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (!widthResizable) return;
          if (event.key === "ArrowLeft") resizeBy(RIGHT_SIDEBAR.keyboardStep);
          else if (event.key === "ArrowRight") resizeBy(-RIGHT_SIDEBAR.keyboardStep);
          else return;
          event.preventDefault();
        }}
      />
      {visible.map((panel, index) => {
        const upper = visible[index - 1];
        return (
          <Fragment key={panel}>
            {upper !== undefined && (
              <HeightSplitter
                upper={upper}
                lower={panel}
                layout={layout}
                bodies={bodies}
                total={total}
                actions={actions}
              />
            )}
            <PanelFrame
              panel={panel}
              collapsible
              collapsed={layout.collapsed[panel]}
              height={panelHeight(layout, bodies, panel)}
              onToggle={() => actions.setCollapsed(panel, !layout.collapsed[panel])}
              onRelinquish={onRelinquish}
            >
              {panel === "colors"
                ? colors?.(setColorsExpanded)
                : panel === "layers"
                  ? layers
                  : history}
            </PanelFrame>
          </Fragment>
        );
      })}
    </div>
  );
}

function panelHeight(layout: PanelLayout, bodies: Bodies, panel: RightPanelId): number {
  return layout.collapsed[panel] ? PANEL_HEADER_HEIGHT : PANEL_HEADER_HEIGHT + bodies[panel];
}

/** Keys move the splitter by this many CSS px, and Shift multiplies it. */
const SPLITTER_STEP = 8;

interface HeightSplitterProps {
  readonly upper: RightPanelId;
  readonly lower: RightPanelId;
  readonly layout: PanelLayout;
  readonly bodies: Bodies;
  /** The sidebar's height in CSS px. */
  readonly total: number;
  readonly actions: PanelActions;
}

/** The splitter between two adjacent panels. It moves only while both have a body. */
function HeightSplitter({ upper, lower, layout, bodies, total, actions }: HeightSplitterProps) {
  const t = useTranslation();
  const drag = useRef<{ y: number; bodies: Bodies } | null>(null);
  const movable = isSplitterMovable(layout, upper, lower);
  const minUpper = minimumBody(upper, layout.colorsExpanded);
  const minLower = minimumBody(lower, layout.colorsExpanded);
  const pair = bodies[upper] + bodies[lower];
  const move = (next: Bodies) => actions.setSplitRatios(splitRatiosFor(next, layout, total));

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (WAI-ARIA) needs role separator on a div, since hr cannot take focus or drag
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("panel.splitter", {
        upper: t(PANEL_TITLES[upper]),
        lower: t(PANEL_TITLES[lower]),
      })}
      aria-valuemin={minUpper}
      aria-valuemax={Math.max(minUpper, pair - minLower)}
      aria-valuenow={Math.round(bodies[upper])}
      aria-disabled={movable ? undefined : true}
      tabIndex={movable ? 0 : undefined}
      className="app-splitter"
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (!movable) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, bodies };
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        const start = drag.current;
        if (start === null) return;
        move(
          moveSplitter(start.bodies, upper, lower, event.clientY - start.y, layout.colorsExpanded),
        );
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (!movable) return;
        const step = event.shiftKey ? SPLITTER_STEP * 4 : SPLITTER_STEP;
        if (event.key === "ArrowUp")
          move(moveSplitter(bodies, upper, lower, -step, layout.colorsExpanded));
        else if (event.key === "ArrowDown")
          move(moveSplitter(bodies, upper, lower, step, layout.colorsExpanded));
        else return;
        event.preventDefault();
      }}
    />
  );
}
