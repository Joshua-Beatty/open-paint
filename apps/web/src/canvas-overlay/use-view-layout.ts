import type { ViewLayout } from "@openpaint/engine";
import { useSyncExternalStore } from "react";
import type { StatusStore } from "../status/status-store";

/**
 * The engine's view layout from the status store. Unlike reading the whole state, it re-renders only
 * when the layout changes, not on every pointer move (L3).
 */
export function useViewLayout(store: StatusStore): ViewLayout | undefined {
  return useSyncExternalStore(store.subscribe, () => store.state.layout);
}
