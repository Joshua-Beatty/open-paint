import { MemorySettingsBackend, SettingsStore } from "@openpaint/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PANEL_LAYOUT, rightBodies } from "./panel-layout";
import { panelActions, readPanelLayout } from "./panel-layout-settings";

describe("panel layout settings (SET-STO-03, SET-LIFE-04)", () => {
  let store: SettingsStore;

  beforeEach(async () => {
    store = await SettingsStore.open({
      backend: new MemorySettingsBackend(),
      channel: null,
      mirror: null,
      lifecycle: null,
      flushDelayMs: 60_000,
    });
  });

  afterEach(async () => {
    await store.dispose();
  });

  it("reads the default layout on first launch (UI-FTW-02)", () => {
    expect(readPanelLayout(store)).toEqual(DEFAULT_PANEL_LAYOUT);
  });

  it("toggles a panel's visibility both ways, and the read layout follows", () => {
    const actions = panelActions(store);
    actions.toggleVisible("history");
    expect(readPanelLayout(store).visible.history).toBe(false);
    actions.toggleVisible("history");
    expect(readPanelLayout(store).visible.history).toBe(true);
  });

  it("collapses a right-sidebar panel and never collapses Tools", () => {
    panelActions(store).setCollapsed("layers", true);
    expect(readPanelLayout(store).collapsed.layers).toBe(true);
    expect(readPanelLayout(store).collapsed.tools).toBe(false);
  });

  it("clamps the stored right-sidebar width to 220 to 480", () => {
    const actions = panelActions(store);
    actions.setRightSidebarWidth(999);
    expect(readPanelLayout(store).rightSidebarWidth).toBe(480);
    actions.setRightSidebarWidth(10);
    expect(store.get("layout.rightSidebar.width")).toBe(220);
  });

  it("stores the split shares and reads them back", () => {
    panelActions(store).setSplitRatios([0.2, 0.3, 0.5]);
    expect(readPanelLayout(store).splitRatios).toEqual([0.2, 0.3, 0.5]);
  });

  it("expands Colors to its editor's height and keeps the stored shares", () => {
    const actions = panelActions(store);
    actions.setSplitRatios([0.2, 0.5, 0.3]);
    actions.setColorsExpanded(true);
    const layout = readPanelLayout(store);
    expect(layout.colorsExpanded).toBe(true);
    expect(layout.splitRatios).toEqual([0.2, 0.5, 0.3]);
    expect(rightBodies(layout, 800).colors).toBe(397);
  });

  it("resets every layout setting to its default (SET-STO-05)", () => {
    const actions = panelActions(store);
    actions.toggleVisible("tools");
    actions.setCollapsed("history", true);
    actions.setRightSidebarWidth(400);
    actions.setSplitRatios([0.5, 0.25, 0.25]);
    actions.reset();
    expect(readPanelLayout(store)).toEqual(DEFAULT_PANEL_LAYOUT);
  });

  it("does nothing, and does not throw, before the store has opened", () => {
    const actions = panelActions(null);
    expect(() => {
      actions.toggleVisible("tools");
      actions.setCollapsed("layers", true);
      actions.setColorsExpanded(true);
      actions.setSplitRatios([0.2, 0.3, 0.5]);
      actions.setRightSidebarWidth(300);
      actions.reset();
    }).not.toThrow();
  });
});
