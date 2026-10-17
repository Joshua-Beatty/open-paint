import { normalizeValue } from "./normalize";
import { enforceInvariants } from "./rules";
import { schemaVersion } from "./schema";
import type {
  JsonValue,
  PropertyDefinition,
  PropertySchema,
  PropertyValue,
  PropertyValues,
} from "./types";
import { cloneValue, isRecord } from "./values";

/** The default value of one property, as an independent copy. */
export function defaultValue(definition: PropertyDefinition): PropertyValue {
  return cloneValue(definition.defaultValue);
}

/** A complete parameter set holding every default. */
export function defaultValues(schema: PropertySchema): PropertyValues {
  return Object.fromEntries(
    schema.properties.map((definition) => [definition.key, defaultValue(definition)] as const),
  );
}

/**
 * Returns a complete, valid parameter set from arbitrary input (stored settings, older versions,
 * partial objects). Missing and invalid values take the default, out-of-range values are clamped,
 * integers are rounded, keys outside the schema are dropped, and the rule invariants are enforced.
 * Never throws.
 */
export function resolveValues(
  schema: PropertySchema,
  values: unknown,
): Record<string, PropertyValue> {
  const source = isRecord(values) ? values : {};
  const resolved: Record<string, PropertyValue> = {};
  for (const definition of schema.properties) {
    const normalized = normalizeValue(definition, source[definition.key]);
    resolved[definition.key] =
      normalized.status === "invalid" ? defaultValue(definition) : cloneValue(normalized.value);
  }
  enforceInvariants(schema, resolved);
  return resolved;
}

/** A plain JSON object of property name to value, with every schema key present. */
export function serializeValues(
  schema: PropertySchema,
  values: PropertyValues,
): Record<string, JsonValue> {
  return Object.fromEntries(
    schema.properties.map(
      (definition) =>
        [definition.key, toJson(values[definition.key] ?? defaultValue(definition))] as const,
    ),
  );
}

function toJson(value: PropertyValue): JsonValue {
  return typeof value === "object" ? { ...value } : value;
}

/**
 * Reads values written at `fromVersion` of the schema and upgrades them with the migrations, one
 * version at a time. A version with no migration keeps its values, and only the keys that the
 * schema still knows survive. Then the result is resolved as in `resolveValues`.
 */
export function migrateValues(
  schema: PropertySchema,
  record: unknown,
  fromVersion: number,
): Record<string, PropertyValue> {
  let current: Readonly<Record<string, unknown>> = isRecord(record) ? record : {};
  const target = schemaVersion(schema);
  for (let version = fromVersion; version < target; version += 1) {
    const migration = schema.migrations?.find((candidate) => candidate.from === version);
    if (migration) current = migration.migrate(current);
  }
  return resolveValues(schema, current);
}
