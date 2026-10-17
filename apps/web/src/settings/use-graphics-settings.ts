import type { EngineStatus } from "@openpaint/engine";
import type { SettingsStore } from "@openpaint/storage";
import { useEffect } from "react";

/**
 * Keeps the live GPU performance class and the device-loss flags in the settings (SET-DLG-07,
 * SET-STO-03). The class sets the GPU quality default; the flags persist `graphics.errorFlags`.
 */
export function useGraphicsSettings(
  settings: SettingsStore | null,
  status: EngineStatus | undefined,
): void {
  useEffect(() => {
    if (settings === null || status === undefined) return;
    settings.setGpuPerformanceClass(status.performanceClass);
    if (settings.get("graphics.errorFlags") !== status.errorFlags) {
      settings.set("graphics.errorFlags", status.errorFlags);
    }
  }, [settings, status]);
}
