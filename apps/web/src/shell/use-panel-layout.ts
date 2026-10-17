import type { SettingsStore } from "@openpaint/storage";
import { type RefObject, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { DEFAULT_PANEL_LAYOUT, type PanelLayout } from "./panel-layout";
import { type PanelActions, panelActions, readPanelLayout } from "./panel-layout-settings";

export interface PanelController {
  readonly layout: PanelLayout;
  readonly actions: PanelActions;
}

/** Every setting the panel layout reads starts with this (readPanelLayout). */
const PANEL_SETTING_PREFIX = "layout.";

/** `previous` when `next` holds the same values, so React sees no change. */
function sameOrNext(previous: PanelLayout, next: PanelLayout): PanelLayout {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/** The docked panels, kept in step with the settings store, and the actions that change them. */
export function usePanelLayout(store: SettingsStore | null): PanelController {
  const [layout, setLayout] = useState<PanelLayout>(() =>
    store === null ? DEFAULT_PANEL_LAYOUT : readPanelLayout(store),
  );
  useEffect(() => {
    if (store === null) return undefined;
    // Every setting change notifies; the layout keeps its identity unless a panel setting changed,
    // so unrelated changes (a tool option dragged on a slider) do not re-render the shell (L3).
    const update = () => setLayout((previous) => sameOrNext(previous, readPanelLayout(store)));
    update();
    return store.onChange(({ path }) => {
      if (path.startsWith(PANEL_SETTING_PREFIX)) update();
    });
  }, [store]);
  const actions = useMemo(() => panelActions(store), [store]);
  return { layout, actions };
}

/** The window's inner width, updated on resize. Browser zoom and monitor changes resize too. */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

/** The height of an element in CSS px, kept current with a ResizeObserver where one exists. */
export function useElementHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}
