import { PropertyValidationError } from "./errors";
import { normalizeValue } from "./normalize";
import { defaultValue, resolveValues, serializeValues } from "./resolve";
import { isReadOnlyByRules, propagate } from "./rules";
import { findDefinition, mergeSchemas } from "./schema";
import type {
  JsonValue,
  PropertyDefinition,
  PropertySchema,
  PropertyValue,
  PropertyValues,
} from "./types";
import { cloneValue, sameValue } from "./values";

export interface PropertyEvents {
  readonly valueChanged: { readonly key: string; readonly value: PropertyValue };
  readonly readOnlyChanged: { readonly key: string; readonly readOnly: boolean };
}

type PropertyListener<K extends keyof PropertyEvents> = (event: PropertyEvents[K]) => void;

type MutableValues = Record<string, PropertyValue>;

/**
 * The live values of one schema (EXT-06A-12). Writes follow the invalid-value policy, the
 * read-only flags and the rules, and every change raises `valueChanged` or `readOnlyChanged`.
 */
export class PropertyCollection {
  readonly #schema: PropertySchema;
  readonly #values: MutableValues;
  readonly #readOnlyFlags = new Map<string, boolean>();
  readonly #listeners: { [K in keyof PropertyEvents]: Set<PropertyListener<K>> } = {
    valueChanged: new Set(),
    readOnlyChanged: new Set(),
  };

  /** Starts from `values` resolved against the schema, so missing or invalid entries are defaults. */
  constructor(schema: PropertySchema, values?: unknown) {
    this.#schema = schema;
    this.#values = resolveValues(schema, values ?? {});
  }

  get schema(): PropertySchema {
    return this.#schema;
  }

  definition(key: string): PropertyDefinition {
    const definition = findDefinition(this.#schema, key);
    if (!definition) throw new Error(`Unknown property "${key}".`);
    return definition;
  }

  get(key: string): PropertyValue {
    this.definition(key);
    return cloneValue(this.#valueOf(key));
  }

  values(): PropertyValues {
    return Object.fromEntries(
      this.#schema.properties.map(
        (definition) => [definition.key, cloneValue(this.#valueOf(definition.key))] as const,
      ),
    );
  }

  /** The effective read-only state: the runtime flag (or the initial flag), or an active rule. */
  isReadOnly(key: string): boolean {
    const definition = this.definition(key);
    const flag = this.#readOnlyFlags.get(key) ?? definition.readOnly ?? false;
    return flag || isReadOnlyByRules(this.#schema, key, this.#values);
  }

  /**
   * Sets a value. A read-only property ignores the write. An invalid value follows the property's
   * policy: `ignore` keeps the old value, `clamp` (the default) falls back to the default, and
   * `reject` throws `PropertyValidationError`.
   */
  set(key: string, value: unknown): void {
    const definition = this.definition(key);
    if (this.isReadOnly(key)) return;
    const normalized = normalizeValue(definition, value);
    if (normalized.status !== "invalid") {
      this.#commit(key, normalized.value);
      return;
    }
    const policy = definition.onInvalid ?? "clamp";
    if (policy === "reject") {
      throw new PropertyValidationError(
        key,
        `"${JSON.stringify(value)}" is not valid for "${key}".`,
      );
    }
    if (policy === "ignore") {
      this.#emit("valueChanged", { key, value: this.get(key) });
      return;
    }
    this.#commit(key, defaultValue(definition));
  }

  /** Sets the read-only flag. Raises `readOnlyChanged` when the effective state changes. */
  setReadOnly(key: string, readOnly: boolean): void {
    this.definition(key);
    const before = this.#readOnlyStates();
    this.#readOnlyFlags.set(key, readOnly);
    this.#emitReadOnlyChanges(before);
  }

  /**
   * Copies every value that is valid for its property from `source` (another collection, or a
   * plain record such as stored settings). Missing and invalid entries leave the current value.
   */
  copyFrom(source: PropertyCollection | Readonly<Record<string, unknown>>): void {
    const record: Readonly<Record<string, unknown>> =
      source instanceof PropertyCollection ? source.values() : source;
    for (const definition of this.#schema.properties) {
      if (!(definition.key in record)) continue;
      const normalized = normalizeValue(definition, record[definition.key]);
      if (normalized.status !== "invalid") this.set(definition.key, normalized.value);
    }
  }

  clone(): PropertyCollection {
    const copy = new PropertyCollection(this.#schema, this.#values);
    for (const [key, readOnly] of this.#readOnlyFlags) copy.setReadOnly(key, readOnly);
    return copy;
  }

  /**
   * Merges two collections (EXT-06A-14) into a new one over `mergeSchemas(first, second)`, holding
   * the values of both. The schemas must not share a key. Read-only flags are not carried over.
   */
  static merge(first: PropertyCollection, second: PropertyCollection): PropertyCollection {
    return new PropertyCollection(mergeSchemas(first.schema, second.schema), {
      ...first.values(),
      ...second.values(),
    });
  }

  serialize(): Record<string, JsonValue> {
    return serializeValues(this.#schema, this.#values);
  }

  /** Subscribes to an event. Returns a function that unsubscribes. */
  on<K extends keyof PropertyEvents>(event: K, listener: PropertyListener<K>): () => void {
    const listeners = this.#listeners[event];
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  #valueOf(key: string): PropertyValue {
    const value = this.#values[key];
    if (value === undefined) throw new Error(`Unknown property "${key}".`);
    return value;
  }

  #commit(key: string, value: PropertyValue): void {
    if (sameValue(this.#values[key], value)) return;
    const before = this.#readOnlyStates();
    this.#values[key] = value;
    const changed = [key, ...propagate(this.#schema, this.#values, key)];
    for (const changedKey of changed) {
      this.#emit("valueChanged", { key: changedKey, value: this.get(changedKey) });
    }
    this.#emitReadOnlyChanges(before);
  }

  #readOnlyStates(): Map<string, boolean> {
    return new Map(
      this.#schema.properties.map(
        (definition) => [definition.key, this.isReadOnly(definition.key)] as const,
      ),
    );
  }

  #emitReadOnlyChanges(before: ReadonlyMap<string, boolean>): void {
    for (const [key, readOnly] of this.#readOnlyStates()) {
      if (before.get(key) !== readOnly) this.#emit("readOnlyChanged", { key, readOnly });
    }
  }

  #emit<K extends keyof PropertyEvents>(event: K, payload: PropertyEvents[K]): void {
    for (const listener of this.#listeners[event]) listener(payload);
  }
}
