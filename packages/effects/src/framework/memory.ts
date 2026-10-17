import type { EffectCategory, EffectDescriptor } from "@openpaint/extension-api";
import {
  defaultValues,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
  serializeValues,
} from "@openpaint/properties";

/**
 * Where remembered parameter sets live, keyed by effect id (FX-FW-TOKEN-01). Settings storage
 * implements it with the `effects.lastValues.<id>` family, and the `adjustments.lastValues.<id>`
 * family for adjustments (ADJ-COMMON-07).
 */
export interface EffectValueStore {
  get(effectId: string, category: EffectCategory): unknown;
  set(effectId: string, category: EffectCategory, values: ReturnType<typeof serializeValues>): void;
}

/** The last Effect-category run, which Repeat re-runs (FX-FW-REPEAT-01). */
export interface LastEffect {
  readonly effectId: string;
  readonly values: PropertyValues;
}

/**
 * Parameter memory and the Repeat target (FX-FW-TOKEN-01, FX-FW-REPEAT-01, ADJ-COMMON-07). Values
 * are remembered only when the user presses OK. Adjustments never become the Repeat target.
 */
export class EffectMemory {
  readonly #store: EffectValueStore;
  #last: LastEffect | undefined;

  constructor(store: EffectValueStore) {
    this.#store = store;
  }

  /** The last run in the Effects category, or undefined before the first one this session. */
  get last(): LastEffect | undefined {
    return this.#last;
  }

  /**
   * The values a dialog opens with: the remembered values, validated against the schema. Missing or
   * invalid values use the schema's defaults, which for a dialog built at open time (`schema`) are
   * the defaults of that dialog, and so do the descriptor's `openAtDefaultProperties`.
   */
  valuesFor(
    descriptor: EffectDescriptor,
    schema: PropertySchema = descriptor.schema,
  ): PropertyValues {
    const remembered = resolveValues(schema, this.#store.get(descriptor.id, descriptor.category));
    const keys = descriptor.options?.openAtDefaultProperties ?? [];
    if (keys.length === 0) return remembered;
    const defaults = defaultValues(schema);
    const values: Record<string, PropertyValues[string]> = { ...remembered };
    for (const key of keys) {
      const value = defaults[key];
      if (value !== undefined) values[key] = value;
    }
    return values;
  }

  /** The declared defaults, which every Reset restores (FX-FW-TOKEN-01). */
  defaultsFor(
    descriptor: EffectDescriptor,
    schema: PropertySchema = descriptor.schema,
  ): PropertyValues {
    return defaultValues(schema);
  }

  /** Stores the values committed with OK. */
  remember(descriptor: EffectDescriptor, values: PropertyValues): void {
    this.#store.set(descriptor.id, descriptor.category, serializeValues(descriptor.schema, values));
  }

  /** Records a completed run. Only Effect-category effects become the Repeat target. */
  recordRun(descriptor: EffectDescriptor, values: PropertyValues): void {
    if (descriptor.category !== "effect") return;
    this.#last = { effectId: descriptor.id, values: { ...values } };
  }
}
