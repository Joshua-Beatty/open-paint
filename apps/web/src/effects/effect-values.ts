import type { EffectValueStore } from "@openpaint/effects";
import type { EffectCategory } from "@openpaint/extension-api";
import type { SettingsStore } from "@openpaint/storage";

/**
 * Keeps each effect's last-used values in the `effects.lastValues.<id>` setting, and each
 * adjustment's in `adjustments.lastValues.<id>` (FX-FW-TOKEN-01, ADJ-COMMON-07, SET-STO-03). The
 * store is read lazily, so values saved before the settings open are not lost.
 */
/**
 * The Quality default of the distortion effects (FX-A-00-03): the Default Quality Level setting of
 * the active backend. Without a readable setting, it is the factory level for this GPU class.
 */
export function defaultQualityOf(
  settings: SettingsStore | null,
  gpu: boolean,
  factoryLevel: number,
): number {
  const value = settings?.get(gpu ? "effects.defaultQualityGpu" : "effects.defaultQualityCpu");
  return typeof value === "number" ? value : factoryLevel;
}

export function settingsEffectValues(settings: SettingsStore | null): EffectValueStore {
  const keyOf = (effectId: string, category: EffectCategory) =>
    category === "adjustment"
      ? `adjustments.lastValues.${effectId}`
      : `effects.lastValues.${effectId}`;
  return {
    get: (effectId, category) => settings?.get(keyOf(effectId, category)),
    set: (effectId, category, values) => settings?.set(keyOf(effectId, category), values),
  };
}
