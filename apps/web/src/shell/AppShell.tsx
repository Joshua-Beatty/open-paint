import { useTranslation } from "@openpaint/i18n/react";
import type { FocusEvent, PointerEvent, ReactNode, Ref } from "react";
import { Toolbar } from "react-aria-components";
import "./shell.css";
import "./compact.css";
import { type CompactLayout, DESKTOP_LAYOUT } from "./use-compact-layout";

export interface AppShellProps {
  /** The right sidebar's width in CSS px. Omit it to use the stylesheet default (UI-FTW-08). */
  rightSidebarWidth?: number;
  /** Receives the canvas area, so keyboard focus can return there (UI-FTW-01). */
  canvasRef?: Ref<HTMLElement>;
  /** The main menu bar and the aux menu buttons (UI-WIN-01, item 1). */
  menuBar?: ReactNode;
  /**
   * The common-actions strip (UI-WIN-01 item 2, UI-TB-01). It has its own line at the top of the
   * toolbar area, so the tool options below it get the full width of their one row.
   */
  commonActions?: ReactNode;
  /** The tool chooser and Tool Config Strip, below the common actions (UI-WIN-01, item 2). */
  toolOptions?: ReactNode;
  /** The image tab strip (UI-WIN-01, item 3). */
  imageTabs?: ReactNode;
  /** The docked left sidebar. Omit it when hidden, and the canvas takes its width (UI-FTW-07). */
  leftSidebar?: ReactNode;
  /** The docked right sidebar. Omit it when hidden, and the canvas takes its width (UI-FTW-07). */
  rightSidebar?: ReactNode;
  /** The status bar (UI-SB). */
  statusBar?: ReactNode;
  /**
   * The compact layout for phones and small tablets. The menu bar and common actions are replaced
   * by `compactStart` and `compactEnd`, the right sidebar by `sheet`, and the left sidebar is a
   * one-column tool rail.
   */
  layout?: CompactLayout;
  /** The start of the compact top bar: the menu button, Undo and Redo. */
  compactStart?: ReactNode;
  /** The end of the compact top bar: the panel buttons. */
  compactEnd?: ReactNode;
  /** The compact panel sheet over the canvas, when one is open. */
  sheet?: ReactNode;
  /** The canvas area for the active image. */
  children: ReactNode;
}

/**
 * The canvas area was focused, or is being used, with a pointer. Some browsers show a focus ring on
 * the focused element as soon as any key is pressed, so a Shift, Ctrl or Alt held during a drawing
 * would outline the whole canvas; the attribute keeps the ring off until focus leaves the area.
 * Focus that comes back by keyboard (a menu or panel handing it back) still shows the ring
 * (WEB-A11Y). Set on the element directly, so no render happens per press.
 */
function markPointerFocus(event: PointerEvent<HTMLElement>): void {
  // Only on a change: any DOM change repaints the page, which costs Firefox a read-back of the
  // engine's canvas on the engine worker just as a stroke starts (L13).
  if (!event.currentTarget.hasAttribute("data-pointer-focus")) {
    event.currentTarget.setAttribute("data-pointer-focus", "");
  }
}

/** Focus left the canvas area: the next focus shows a ring again if the keyboard brings it. */
function clearPointerFocus(event: FocusEvent<HTMLElement>): void {
  const next = event.relatedTarget;
  if (next instanceof Node && event.currentTarget.contains(next)) return;
  event.currentTarget.removeAttribute("data-pointer-focus");
}

/**
 * The application frame from UI-WIN-01: menu bar, tool options, image tabs, a main row of left
 * sidebar, canvas area and right sidebar, then the status bar. The sidebars take their columns out
 * of the row, so the canvas area always fills the rest and panels never overlay it (WEB-UI-01).
 */
export function AppShell({
  menuBar,
  commonActions,
  toolOptions,
  imageTabs,
  leftSidebar,
  rightSidebar,
  statusBar,
  rightSidebarWidth,
  canvasRef,
  layout = DESKTOP_LAYOUT,
  compactStart,
  compactEnd,
  sheet,
  children,
}: AppShellProps) {
  const t = useTranslation();
  const { compact } = layout;
  const rightColumn =
    rightSidebarWidth === undefined ? "var(--right-sidebar-width)" : `${rightSidebarWidth}px`;
  const columns = [
    leftSidebar === undefined ? "0px" : "var(--left-sidebar-width)",
    "minmax(0, 1fr)",
    rightSidebar === undefined ? "0px" : rightColumn,
  ].join(" ");
  const className = compact
    ? [
        "app-shell is-compact",
        layout.short ? "is-short" : "",
        layout.sideSheet ? "is-side-sheet" : "",
        leftSidebar === undefined ? "" : "has-rail",
      ]
        .filter((name) => name !== "")
        .join(" ")
    : "app-shell";

  // The canvas area keeps its place in the tree in both layouts: the engine's canvas lives in it
  // and cannot be created again.
  return (
    <div className={className} style={compact ? undefined : { gridTemplateColumns: columns }}>
      {compact ? (
        <div className="app-compact-start">{compactStart}</div>
      ) : (
        <div className="app-menu-bar">{menuBar}</div>
      )}
      <div className="app-tool-options">
        {compact ? null : commonActions}
        <Toolbar className="app-tool-config" aria-label={t("shell.toolOptions")}>
          {toolOptions}
        </Toolbar>
      </div>
      {compact ? <div className="app-compact-end">{compactEnd}</div> : null}
      {compact && imageTabs === undefined ? null : (
        <div className="app-image-tabs">{imageTabs}</div>
      )}
      {leftSidebar !== undefined && (
        <aside className="app-sidebar app-sidebar-left">{leftSidebar}</aside>
      )}
      <main
        ref={canvasRef}
        tabIndex={-1}
        className="app-canvas-area"
        onPointerDownCapture={markPointerFocus}
        onBlur={clearPointerFocus}
      >
        {children}
      </main>
      {rightSidebar !== undefined && !compact && (
        <aside className="app-sidebar app-sidebar-right">{rightSidebar}</aside>
      )}
      {compact && sheet !== undefined ? sheet : null}
      <footer className="app-status-bar">{statusBar}</footer>
    </div>
  );
}
