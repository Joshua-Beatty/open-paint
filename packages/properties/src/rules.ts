import type { PropertyRule, PropertySchema, PropertyValue } from "./types";
import { sameValue } from "./values";

type MutableValues = Record<string, PropertyValue>;

function applyInversion(matches: boolean, inverted: boolean | undefined): boolean {
  return inverted ? !matches : matches;
}

/** True while a read-only rule targets `key` and its condition holds (EXT-06B-01..03). */
export function isReadOnlyByRules(
  schema: PropertySchema,
  key: string,
  values: Readonly<MutableValues>,
): boolean {
  return (schema.rules ?? []).some((rule) => {
    switch (rule.kind) {
      case "readOnlyWhenBoolean":
        return rule.target === key && applyInversion(values[rule.source] === true, rule.inverted);
      case "readOnlyWhenValue":
        return (
          rule.target === key &&
          applyInversion(
            rule.values.some((listed) => sameValue(values[rule.source], listed)),
            rule.inverted,
          )
        );
      case "readOnlyWhenNameValues":
        return (
          rule.target === key &&
          rule.conditions.some((condition) => sameValue(values[condition.name], condition.value))
        );
      default:
        return false;
    }
  });
}

function pairs(
  targets: readonly string[],
  value: PropertyValue | undefined,
): Array<[string, PropertyValue]> {
  return value === undefined
    ? []
    : targets.map((target): [string, PropertyValue] => [target, value]);
}

/** The writes that a change to `key` triggers through the reactive rules. */
function writesFor(
  rule: PropertyRule,
  key: string,
  values: Readonly<MutableValues>,
): Array<[string, PropertyValue]> {
  switch (rule.kind) {
    case "setTargetWhenSourceEquals": {
      if (rule.source !== key) return [];
      const matches = rule.values.some((listed) => sameValue(values[rule.source], listed));
      return applyInversion(matches, rule.inverted) ? [[rule.target, rule.targetValue]] : [];
    }
    case "softMinMax": {
      const lower = values[rule.lower];
      const upper = values[rule.upper];
      if (typeof lower !== "number" || typeof upper !== "number" || lower <= upper) return [];
      if (key === rule.lower) return [[rule.upper, lower]];
      if (key === rule.upper) return [[rule.lower, upper]];
      return [];
    }
    case "linkValuesWhenBoolean": {
      if (values[rule.source] !== rule.when) return [];
      const reference = rule.keys[0];
      if (reference === undefined) return [];
      if (key === rule.source) return pairs(rule.keys.slice(1), values[reference]);
      if (rule.keys.includes(key)) {
        return pairs(
          rule.keys.filter((linked) => linked !== key),
          values[key],
        );
      }
      return [];
    }
    default:
      return [];
  }
}

/**
 * Applies the reactive rules after `start` has changed, following the chain of writes they cause.
 * Writes are skipped when the value is already equal, and each key is expanded once, so cycles
 * settle. Returns the keys that changed because of the rules, in order.
 */
export function propagate(schema: PropertySchema, values: MutableValues, start: string): string[] {
  const rules = schema.rules ?? [];
  const changed: string[] = [];
  const queue = [start];
  const expanded = new Set<string>();
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    if (expanded.has(key)) continue;
    expanded.add(key);
    for (const rule of rules) {
      for (const [target, value] of writesFor(rule, key, values)) {
        if (sameValue(values[target], value)) continue;
        values[target] = value;
        changed.push(target);
        queue.push(target);
      }
    }
  }
  return changed;
}

/** Enforces the invariants of stored or resolved values: softMinMax and linked booleans. */
export function enforceInvariants(schema: PropertySchema, values: MutableValues): void {
  for (const rule of schema.rules ?? []) {
    if (rule.kind === "softMinMax") {
      const lower = values[rule.lower];
      const upper = values[rule.upper];
      if (typeof lower === "number" && typeof upper === "number" && lower > upper) {
        values[rule.upper] = lower;
      }
    }
    if (rule.kind === "linkValuesWhenBoolean" && values[rule.source] === rule.when) {
      const reference = rule.keys[0];
      const value = reference === undefined ? undefined : values[reference];
      if (value !== undefined) {
        for (const key of rule.keys.slice(1)) values[key] = value;
      }
    }
  }
}
