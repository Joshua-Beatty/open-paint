import type { CanvasStyle, EngineHandle } from "@openpaint/engine";
import type { SettingColor, SettingsStore, SettingValue } from "@openpaint/storage";
import { useEffect } from "react";
import { type SettingReader, useSetting } from "./use-setting";

/** The four `canvas.*` settings that the canvas chrome uses (SET-DLG-04). */
export interface CanvasSettingValues {
  readonly dropShadow: SettingValue | undefined;
  readonly checkerboardBrightness: SettingValue | undefined;
  readonly borderEnabled: SettingValue | undefined;
  readonly borderColor: SettingValue | undefined;
}

/**
 * The canvas chrome for the stored settings. A border colour applies only while its checkbox is
 * ticked. Missing values take their factory defaults.
 */
export function canvasStyleOf(values: CanvasSettingValues): CanvasStyle {
  const border = values.borderColor as SettingColor | undefined;
  const borderEnabled = values.borderEnabled === true && border !== undefined;
  return {
    dropShadow: values.dropShadow !== false,
    checkerboardBrightness:
      typeof values.checkerboardBrightness === "number" ? values.checkerboardBrightness : 0.75,
    borderColor: borderEnabled ? [border.r, border.g, border.b] : null,
  };
}

/** Sends the canvas settings to the engine whenever one of them changes (SET-DLG-04). */
export function useCanvasStyle(engine: EngineHandle | undefined, settings: SettingsStore | null) {
  const dropShadow = useSetting(settings, "canvas.dropShadow");
  const checkerboardBrightness = useSetting(settings, "canvas.checkerboardBrightness");
  const borderEnabled = useSetting(settings, "canvas.customBorderColorEnabled");
  const borderColor = useSetting(settings, "canvas.customBorderColor");
  const styleKey = JSON.stringify(
    canvasStyleOf({ dropShadow, checkerboardBrightness, borderEnabled, borderColor }),
  );
  useEffect(() => {
    if (engine === undefined) return;
    void engine.setCanvasStyle(JSON.parse(styleKey) as CanvasStyle);
  }, [engine, styleKey]);
}

/**
 * Sends "Scrolling past the edge of the image (overscroll)" to the engine's view whenever it
 * changes (UI-VIEW-02, `ui.overscroll`). It is on until the store says otherwise, as its default is.
 */
export function useOverscroll(
  engine: Pick<EngineHandle, "view"> | undefined,
  settings: SettingReader | null,
) {
  const enabled = useSetting(settings, "ui.overscroll") !== false;
  useEffect(() => {
    if (engine === undefined) return;
    void engine.view({ type: "overscroll", enabled });
  }, [engine, enabled]);
}
