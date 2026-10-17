import { allowedControlTypes, effectiveControlType } from "./controls";
import { PropertySchemaError } from "./errors";
import { normalizeValue } from "./normalize";
import type {
  ControlOptions,
  LayoutNode,
  PropertyDefinition,
  PropertyRule,
  PropertySchema,
  PropertyValue,
} from "./types";
import { sameValue } from "./values";

/** The numeric control options that must be finite and not negative. */
const NON_NEGATIVE_OPTIONS = [
  "sliderSmallChange",
  "sliderSmallChangeX",
  "sliderSmallChangeY",
  "sliderSmallChangeZ",
  "sliderLargeChange",
  "sliderLargeChangeX",
  "sliderLargeChangeY",
  "sliderLargeChangeZ",
  "upDownIncrement",
  "upDownIncrementX",
  "upDownIncrementY",
  "upDownIncrementZ",
] as const satisfies readonly (keyof ControlOptions)[];

function fail(message: string): never {
  throw new PropertySchemaError(message);
}

/** The schema version. Defaults to 1. */
export function schemaVersion(schema: PropertySchema): number {
  return schema.version ?? 1;
}

export function findDefinition(
  schema: PropertySchema,
  key: string,
): PropertyDefinition | undefined {
  return schema.properties.find((definition) => definition.key === key);
}

/** The layout to show: the explicit one, or every visible control in declaration order. */
export function layoutOf(schema: PropertySchema): readonly LayoutNode[] {
  if (schema.layout) return schema.layout;
  return schema.properties
    .filter((definition) => effectiveControlType(definition) !== "hidden")
    .map((definition): LayoutNode => ({ kind: "control", key: definition.key }));
}

/**
 * Checks a schema against EXT-06 and returns it unchanged. Throws `PropertySchemaError` on the
 * first violation, so a broken effect or file type fails when it is registered, not when used.
 */
export function definePropertySchema(schema: PropertySchema): PropertySchema {
  const version = schemaVersion(schema);
  if (!Number.isInteger(version) || version < 1) {
    fail(`Schema version must be an integer of at least 1, got ${version}.`);
  }
  const definitions = new Map<string, PropertyDefinition>();
  for (const definition of schema.properties) {
    if (definition.key.length === 0) fail("A property key must not be empty.");
    if (definitions.has(definition.key)) fail(`Duplicate property key "${definition.key}".`);
    definitions.set(definition.key, definition);
    validateDefinition(definition);
  }
  for (const rule of schema.rules ?? []) validateRule(rule, definitions);
  validateDefaults(schema);
  if (schema.layout) validateLayout(schema.layout, definitions);
  validateMigrations(schema, version);
  return schema;
}

/**
 * Combines two schemas, for example the parameters of an effect and a panel of extra options.
 * Keys must be unique across both. Both schemas must not carry migrations.
 */
export function mergeSchemas(first: PropertySchema, second: PropertySchema): PropertySchema {
  if (first.migrations?.length && second.migrations?.length) {
    fail("Only one of two merged schemas may declare migrations.");
  }
  return definePropertySchema({
    version: Math.max(schemaVersion(first), schemaVersion(second)),
    properties: [...first.properties, ...second.properties],
    rules: [...(first.rules ?? []), ...(second.rules ?? [])],
    layout: [...layoutOf(first), ...layoutOf(second)],
    migrations: [...(first.migrations ?? []), ...(second.migrations ?? [])],
  });
}

function validateDefinition(definition: PropertyDefinition): void {
  const { key } = definition;
  switch (definition.kind) {
    case "int32":
    case "double":
      if (!(Number.isFinite(definition.min) && Number.isFinite(definition.max))) {
        fail(`"${key}" needs finite bounds.`);
      }
      if (definition.min > definition.max) fail(`"${key}" has min above max.`);
      if (
        definition.kind === "int32" &&
        !(Number.isInteger(definition.min) && Number.isInteger(definition.max))
      ) {
        fail(`Int32 "${key}" needs integer bounds.`);
      }
      break;
    case "vector2":
      validateAxes(key, [
        [definition.min.x, definition.max.x],
        [definition.min.y, definition.max.y],
      ]);
      break;
    case "vector3":
      validateAxes(key, [
        [definition.min.x, definition.max.x],
        [definition.min.y, definition.max.y],
        [definition.min.z, definition.max.z],
      ]);
      break;
    case "choice": {
      if (definition.options.length === 0) fail(`Choice "${key}" needs at least one option.`);
      const values = definition.options.map((option) => option.value);
      if (new Set(values).size !== values.length) fail(`Choice "${key}" has duplicate options.`);
      break;
    }
    case "string":
      if (
        definition.maxLength !== undefined &&
        (!Number.isInteger(definition.maxLength) || definition.maxLength < 0)
      ) {
        fail(`String "${key}" needs a maxLength of at least 0.`);
      }
      break;
    case "tabState":
      if (!Number.isInteger(definition.tabCount) || definition.tabCount < 1) {
        fail(`Tab state "${key}" needs a tabCount of at least 1.`);
      }
      break;
    default:
      break;
  }
  if (normalizeValue(definition, definition.defaultValue).status !== "valid") {
    fail(`The default value of "${key}" is not valid for its type and range.`);
  }
  validateControl(definition);
}

function validateAxes(key: string, bounds: ReadonlyArray<readonly [number, number]>): void {
  for (const [min, max] of bounds) {
    if (!(Number.isFinite(min) && Number.isFinite(max)) || min > max) {
      fail(`"${key}" needs finite per-axis bounds with min at or below max.`);
    }
  }
}

function validateControl(definition: PropertyDefinition): void {
  const control = definition.control;
  if (!control) return;
  const { key } = definition;
  if (
    control.controlType !== undefined &&
    !allowedControlTypes(definition.kind).includes(control.controlType)
  ) {
    fail(`Control "${control.controlType}" cannot show "${key}" (${definition.kind}).`);
  }
  if (control.booleanChoices !== undefined && definition.kind !== "boolean") {
    fail(`Only a boolean can show as a two-value drop-down, not "${key}" (${definition.kind}).`);
  }
  if (control.choiceGrid !== undefined) validateChoiceGrid(definition);
  for (const option of NON_NEGATIVE_OPTIONS) {
    const value = control[option];
    if (value !== undefined && !(Number.isFinite(value) && value >= 0)) {
      fail(`Control option ${option} of "${key}" must be finite and not negative.`);
    }
  }
  if (
    control.exponentialScale !== undefined &&
    !(Number.isFinite(control.exponentialScale) && control.exponentialScale > 0)
  ) {
    fail(`Control option exponentialScale of "${key}" must be positive.`);
  }
  if (
    control.decimalPlaces !== undefined &&
    !(
      Number.isInteger(control.decimalPlaces) &&
      control.decimalPlaces >= 0 &&
      control.decimalPlaces <= 15
    )
  ) {
    fail(`Control option decimalPlaces of "${key}" must be an integer from 0 to 15.`);
  }
  if (
    control.dialogWidthScale !== undefined &&
    !(Number.isFinite(control.dialogWidthScale) && control.dialogWidthScale > 0)
  ) {
    fail(`Control option dialogWidthScale of "${key}" must be positive.`);
  }
}

function validateChoiceGrid(definition: PropertyDefinition): void {
  const { key } = definition;
  const grid = definition.control?.choiceGrid;
  if (grid === undefined) return;
  if (definition.kind !== "choice" || effectiveControlType(definition) !== "radioButtons") {
    fail(`Only a choice shown as radio buttons can be laid out as a grid, not "${key}".`);
  }
  const columns = grid.rows[0]?.length ?? 0;
  if (columns === 0 || grid.rows.some((row) => row.length !== columns)) {
    fail(`The choice grid of "${key}" needs rows of one non-zero length.`);
  }
  const cells = grid.rows.flat().filter((value) => value !== null);
  const values = definition.options.map((option) => option.value);
  if (
    new Set(cells).size !== cells.length ||
    cells.length !== values.length ||
    cells.some((value) => !values.includes(value))
  ) {
    fail(`The choice grid of "${key}" must hold every option exactly once.`);
  }
  const inRange = (indexes: readonly number[] | undefined, count: number) =>
    (indexes ?? []).every((index) => Number.isInteger(index) && index >= 0 && index < count - 1);
  if (!inRange(grid.gapAfterRows, grid.rows.length) || !inRange(grid.gapAfterColumns, columns)) {
    fail(`The choice grid of "${key}" has a gap after its last row or column, or outside it.`);
  }
}

function lookup(
  definitions: ReadonlyMap<string, PropertyDefinition>,
  key: string,
  context: string,
): PropertyDefinition {
  const definition = definitions.get(key);
  if (!definition) fail(`${context} refers to unknown property "${key}".`);
  return definition;
}

function requireKind(definition: PropertyDefinition, kind: PropertyDefinition["kind"][]): void {
  if (!kind.includes(definition.kind)) {
    fail(`"${definition.key}" is ${definition.kind}, which this rule does not accept.`);
  }
}

function requireValid(definition: PropertyDefinition, value: PropertyValue, context: string): void {
  if (normalizeValue(definition, value).status === "invalid") {
    fail(`${context}: ${JSON.stringify(value)} is not a valid value for "${definition.key}".`);
  }
}

function numericRange(definition: PropertyDefinition): readonly [number, number] | undefined {
  return definition.kind === "int32" || definition.kind === "double"
    ? [definition.min, definition.max]
    : undefined;
}

function sameRange(first: PropertyDefinition, second: PropertyDefinition): boolean {
  const a = numericRange(first);
  const b = numericRange(second);
  return a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1];
}

function validateRule(
  rule: PropertyRule,
  definitions: ReadonlyMap<string, PropertyDefinition>,
): void {
  const context = `Rule ${rule.kind}`;
  switch (rule.kind) {
    case "readOnlyWhenBoolean": {
      requireKind(lookup(definitions, rule.source, context), ["boolean"]);
      lookup(definitions, rule.target, context);
      if (rule.source === rule.target) fail(`${context} needs two different properties.`);
      return;
    }
    case "readOnlyWhenValue": {
      const source = lookup(definitions, rule.source, context);
      lookup(definitions, rule.target, context);
      for (const value of rule.values) requireValid(source, value, context);
      if (rule.source === rule.target) fail(`${context} needs two different properties.`);
      return;
    }
    case "readOnlyWhenNameValues": {
      lookup(definitions, rule.target, context);
      for (const condition of rule.conditions) {
        requireValid(lookup(definitions, condition.name, context), condition.value, context);
      }
      return;
    }
    case "setTargetWhenSourceEquals": {
      const source = lookup(definitions, rule.source, context);
      const target = lookup(definitions, rule.target, context);
      for (const value of rule.values) requireValid(source, value, context);
      requireValid(target, rule.targetValue, context);
      if (rule.source === rule.target) fail(`${context} needs two different properties.`);
      return;
    }
    case "softMinMax": {
      const lower = lookup(definitions, rule.lower, context);
      const upper = lookup(definitions, rule.upper, context);
      requireKind(lower, ["int32", "double"]);
      requireKind(upper, ["int32", "double"]);
      if (rule.lower === rule.upper) fail(`${context} needs two different properties.`);
      if (lower.kind !== upper.kind || !sameRange(lower, upper)) {
        fail(`${context} needs both properties to share a kind and range.`);
      }
      return;
    }
    case "linkValuesWhenBoolean": {
      requireKind(lookup(definitions, rule.source, context), ["boolean"]);
      if (rule.keys.length < 2) fail(`${context} needs at least two linked properties.`);
      if (new Set(rule.keys).size !== rule.keys.length) fail(`${context} lists a key twice.`);
      const first = lookup(definitions, rule.keys[0] ?? "", context);
      for (const key of rule.keys) {
        const linked = lookup(definitions, key, context);
        if (key === rule.source) fail(`${context} cannot link its own boolean.`);
        if (linked.kind !== first.kind || !sameRange(linked, first)) {
          fail(`${context} needs linked properties to share a kind and range.`);
        }
      }
      return;
    }
  }
}

/** Defaults must satisfy the soft min/max and linked-boolean invariants when the rules apply. */
function validateDefaults(schema: PropertySchema): void {
  const defaults = new Map<string, PropertyValue>(
    schema.properties.map((definition) => [definition.key, definition.defaultValue] as const),
  );
  for (const rule of schema.rules ?? []) {
    if (rule.kind === "softMinMax") {
      const lower = defaults.get(rule.lower);
      const upper = defaults.get(rule.upper);
      if (typeof lower === "number" && typeof upper === "number" && lower > upper) {
        fail(`The defaults of "${rule.lower}" and "${rule.upper}" break softMinMax.`);
      }
    }
    if (rule.kind === "linkValuesWhenBoolean" && defaults.get(rule.source) === rule.when) {
      const reference = defaults.get(rule.keys[0] ?? "");
      for (const key of rule.keys) {
        if (!sameValue(defaults.get(key), reference)) {
          fail(
            `The defaults of the keys linked to "${rule.source}" must match while it is ${rule.when}.`,
          );
        }
      }
    }
  }
}

function validateLayout(
  nodes: readonly LayoutNode[],
  definitions: ReadonlyMap<string, PropertyDefinition>,
): void {
  const used = new Set<string>();
  const claim = (key: string): void => {
    lookup(definitions, key, "Layout");
    if (used.has(key)) fail(`Layout places "${key}" more than once.`);
    used.add(key);
  };
  const visit = (node: LayoutNode): void => {
    switch (node.kind) {
      case "control":
        claim(node.key);
        return;
      case "panel":
        for (const child of node.children) visit(child);
        return;
      case "tabs": {
        claim(node.key);
        const tabs = lookup(definitions, node.key, "Layout");
        requireKind(tabs, ["tabState"]);
        if (tabs.kind !== "tabState" || node.pages.length !== tabs.tabCount) {
          fail(`Tabs for "${node.key}" need one page per tab.`);
        }
        for (const page of node.pages) {
          for (const child of page.children) visit(child);
        }
        return;
      }
    }
  };
  for (const node of nodes) visit(node);
}

function validateMigrations(schema: PropertySchema, version: number): void {
  const seen = new Set<number>();
  for (const migration of schema.migrations ?? []) {
    if (!Number.isInteger(migration.from) || migration.from < 1 || migration.from >= version) {
      fail(`A migration must read a version from 1 up to ${version - 1}, got ${migration.from}.`);
    }
    if (seen.has(migration.from)) fail(`Two migrations read version ${migration.from}.`);
    seen.add(migration.from);
  }
}
