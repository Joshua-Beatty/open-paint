import type { PropertyValues } from "@openpaint/properties";
import type { SettingsStore } from "@openpaint/storage";

/** Remembers the last-used save options of each file type (FMT-UI-01). */
export interface SaveConfigStore {
  /** The stored values of a type, or undefined when none were saved. */
  load(typeId: string): unknown;
  store(typeId: string, values: PropertyValues): void;
}

/**
 * Keeps each type's last-used options in the `file.saveConfig.<format>` setting (SET-STO-03). The
 * settings store is read when it is needed, since it opens after the app starts.
 */
export function settingsSaveConfig(read: () => SettingsStore | null): SaveConfigStore {
  const key = (typeId: string) => `file.saveConfig.${typeId}`;
  return {
    load: (typeId) => read()?.get(key(typeId)),
    store: (typeId, values) => read()?.set(key(typeId), values),
  };
}
