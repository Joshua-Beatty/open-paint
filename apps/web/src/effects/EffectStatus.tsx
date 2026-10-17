import type { Document } from "@openpaint/document";
import { useEffect, useSyncExternalStore } from "react";
import { SelectionOutlineOverlay } from "../canvas-overlay/SelectionOutlineOverlay";
import { selectionTintShown } from "../canvas-overlay/selection-outline";
import type { StatusStore } from "../status/status-store";
import type { EffectRuntime } from "./effect-runtime";

/**
 * Shows an effect render's progress in the status bar (FX-FW-PROGRESS-01). It renders nothing, and
 * only it re-renders when the progress changes, not the app around it (L3).
 */
export function EffectProgress({ runtime, store }: { runtime: EffectRuntime; store: StatusStore }) {
  const phase = useSyncExternalStore(runtime.subscribe, () => runtime.state?.phase);
  const percent = useSyncExternalStore(runtime.subscribe, () => {
    const state = runtime.state;
    return state?.phase === "rendering" ? state.percent : undefined;
  });
  useEffect(() => {
    store.setProgress(phase === "rendering" ? { value: percent } : undefined);
  }, [phase, percent, store]);
  return null;
}

/**
 * The selection outline, with its tint hidden while a dialog previews on the canvas. It reads the
 * effect phase itself, so an effect opening or closing re-renders only the outline.
 */
export function EffectAwareSelectionOutline({
  runtime,
  store,
  document,
  animate,
  antialiased,
  layerPropertiesOpen,
}: {
  runtime: EffectRuntime;
  store: StatusStore;
  document: Document | undefined;
  animate: boolean;
  antialiased: boolean;
  layerPropertiesOpen: boolean;
}) {
  const phase = useSyncExternalStore(runtime.subscribe, () => runtime.state?.phase);
  return (
    <SelectionOutlineOverlay
      store={store}
      document={document}
      animate={animate}
      antialiased={antialiased}
      tint={selectionTintShown({ layerProperties: layerPropertiesOpen, effect: phase })}
    />
  );
}
