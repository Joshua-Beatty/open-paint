import { SETTING_DEFINITIONS, type SettingsStore } from "@openpaint/storage";

/** The part of the settings store the Tools page actions use. */
export type ToolSettings = Pick<SettingsStore, "get" | "set" | "reset">;

/**
 * Copies every live toolbar setting (`tools.*`) into the tool defaults tree (SET-DLG-05, "Load From
 * Toolbar"). Both trees have the same shape, so each path maps to its `toolDefaults` twin.
 */
export function loadToolbarIntoDefaults(settings: ToolSettings): void {
  for (const definition of SETTING_DEFINITIONS) {
    if (!definition.key.startsWith("tools.")) continue;
    const value = settings.get(definition.key);
    if (value === undefined) continue;
    settings.set(`toolDefaults.${definition.key.slice("tools.".length)}`, value);
  }
}

/** Restores every tool default to its factory value (SET-DLG-05, "Reset"). */
export function resetToolDefaults(settings: ToolSettings): void {
  for (const definition of SETTING_DEFINITIONS) {
    if (definition.key.startsWith("toolDefaults.")) settings.reset(definition.key);
  }
}
