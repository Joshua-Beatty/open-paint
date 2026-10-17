import type { SettingsStore } from "@openpaint/storage";
import type { BuiltInCommandId } from "../commands/catalog";
import {
  clampRightWidth,
  DEFAULT_PANEL_LAYOUT,
  type PanelId,
  type PanelLayout,
  type RightPanelId,
} from "./panel-layout";

/** The command that toggles each panel (UI-AUX-01, UI-KEY-01). */
export const PANEL_COMMANDS: Readonly<Record<PanelId, BuiltInCommandId>> = {
  tools: "view.panelTools",
  colors: "view.panelColors",
  layers: "view.panelLayers",
  history: "view.panelHistory",
};

/** Changes to the docked panels. Each one writes the `layout.*` settings (SET-STO-03). */
export interface PanelActions {
  toggleVisible(panel: PanelId): void;
  setCollapsed(panel: RightPanelId, collapsed: boolean): void;
  /**
   * Expands or compacts Colors. The split shares stay as they are: expanded Colors takes the
   * height it needs from Layers and History (rightBodies), and compacting it gives that back.
   */
  setColorsExpanded(expanded: boolean): void;
  setSplitRatios(ratios: readonly number[]): void;
  setRightSidebarWidth(width: number): void;
  /** "Reset panel layout" (SET-STO-05, UI-FTW-02). */
  reset(): void;
}

/** Reads the docked panels from the settings store. The store has already validated the values. */
export function readPanelLayout(store: SettingsStore): PanelLayout {
  const flag = (path: string, fallback: boolean): boolean => {
    const value = store.get(path);
    return typeof value === "boolean" ? value : fallback;
  };
  const width = store.get("layout.rightSidebar.width");
  const ratios = store.get("layout.rightSidebar.splitRatios");
  const numbers = Array.isArray(ratios)
    ? ratios.filter((value): value is number => typeof value === "number")
    : [];
  return {
    visible: {
      tools: flag("layout.panels.tools.visible", true),
      colors: flag("layout.panels.colors.visible", true),
      layers: flag("layout.panels.layers.visible", true),
      history: flag("layout.panels.history.visible", true),
    },
    collapsed: {
      tools: false,
      colors: flag("layout.panels.colors.collapsed", false),
      layers: flag("layout.panels.layers.collapsed", false),
      history: flag("layout.panels.history.collapsed", false),
    },
    colorsExpanded: flag("layout.panels.colors.expanded", false),
    rightSidebarWidth:
      typeof width === "number" ? clampRightWidth(width) : DEFAULT_PANEL_LAYOUT.rightSidebarWidth,
    splitRatios: numbers.length === 3 ? numbers : [],
  };
}

/** The actions over a store. Without a store they do nothing, as before settings have opened. */
export function panelActions(store: SettingsStore | null): PanelActions {
  if (store === null) {
    return {
      toggleVisible: () => {},
      setCollapsed: () => {},
      setColorsExpanded: () => {},
      setSplitRatios: () => {},
      setRightSidebarWidth: () => {},
      reset: () => {},
    };
  }
  return {
    toggleVisible(panel) {
      const path = `layout.panels.${panel}.visible`;
      store.set(path, store.get(path) !== true);
    },
    setCollapsed(panel, collapsed) {
      store.set(`layout.panels.${panel}.collapsed`, collapsed);
    },
    setColorsExpanded(expanded) {
      store.set("layout.panels.colors.expanded", expanded);
    },
    setSplitRatios(ratios) {
      store.set("layout.rightSidebar.splitRatios", [...ratios]);
    },
    setRightSidebarWidth(width) {
      store.set("layout.rightSidebar.width", clampRightWidth(width));
    },
    reset() {
      store.resetPanelLayout();
    },
  };
}
