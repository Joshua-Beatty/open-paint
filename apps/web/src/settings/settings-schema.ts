import type { MessageId } from "@openpaint/i18n";
import {
  type ChoiceOption,
  type ColorValue,
  type ControlOptions,
  definePropertySchema,
  type PropertyDefinition,
  type PropertyRule,
  type PropertySchema,
} from "@openpaint/properties";
import {
  defaultOf,
  findDefinition,
  type SettingsContext,
  type SettingValue,
} from "@openpaint/storage";
import { toPropertyValue } from "./settings-values";

/** One setting shown as a control. The key is unique within its form block. */
export interface FieldSpec {
  readonly key: string;
  /** The settings path, for example `canvas.dropShadow`. */
  readonly path: string;
  readonly label: MessageId;
  readonly control?: ControlOptions;
  /** Replaces the choices of an enum, or makes a text setting a choice (SET-DLG-05, SET-DLG-07a). */
  readonly options?: readonly ChoiceOption[];
  /** Enum values are blend modes, labelled from the blend catalog. */
  readonly blendLabels?: boolean;
  /** Icons (16 x 16 SVG path data) of a choice's values, shown before their labels. */
  readonly optionIcons?: Readonly<Record<string, string>>;
  /**
   * Shows several settings as this one control, such as the fill type and hatch style as one Fill
   * drop-down. The field's path names the setting that types the control and gives its default.
   */
  readonly binding?: FieldBinding;
}

/** How one control reads and writes several settings (FieldSpec.binding). */
export interface FieldBinding {
  /** The settings, by name under the field's tree (the first part of its path), in write order. */
  readonly names: readonly string[];
  /** The control's value from the settings' values, in `names` order. */
  readonly read: (values: readonly (SettingValue | undefined)[]) => SettingValue;
  /** The settings' values for a control value, in `names` order; undefined leaves one as it is. */
  readonly write: (value: SettingValue) => readonly (SettingValue | undefined)[];
}

/** The setting paths a field shows: its binding's settings, or its own path. */
export function fieldPaths(field: FieldSpec): readonly string[] {
  if (field.binding === undefined) return [field.path];
  const tree = field.path.slice(0, field.path.indexOf("."));
  return field.binding.names.map((name) => `${tree}.${name}`);
}

/** The stored value a field shows. */
export function readField(
  field: FieldSpec,
  get: (path: string) => SettingValue | undefined,
): SettingValue | undefined {
  if (field.binding === undefined) return get(field.path);
  return field.binding.read(fieldPaths(field).map(get));
}

/** The settings to write for a field's new value, as (path, value) pairs in write order. */
export function writesOf(
  field: FieldSpec,
  value: SettingValue,
): ReadonlyArray<readonly [string, SettingValue]> {
  if (field.binding === undefined) return [[field.path, value]];
  const values = field.binding.write(value);
  return fieldPaths(field).flatMap((path, index) => {
    const next = values[index];
    return next === undefined ? [] : [[path, next] as const];
  });
}

/** Controls that share one schema, so they lay out and share rules as one form. */
export interface FormBlock {
  readonly fields: readonly FieldSpec[];
  readonly rules?: readonly PropertyRule[];
}

/** The catalog label of a stored enum value, for example `settings.option.cpu` for `Cpu`. */
export function settingsOptionLabel(value: string): MessageId {
  return `settings.option.${value.charAt(0).toLowerCase()}${value.slice(1)}` as MessageId;
}

function choiceOptions(choices: readonly string[], blendLabels: boolean): ChoiceOption[] {
  return choices.map((value) => ({
    value,
    label: (blendLabels ? `blend.${value}` : settingsOptionLabel(value)) as MessageId,
  }));
}

/** A choice's options with the field's option icons added. */
function withIcons(options: readonly ChoiceOption[], field: FieldSpec): readonly ChoiceOption[] {
  const icons = field.optionIcons;
  if (icons === undefined) return options;
  return options.map((option) => {
    const icon = icons[String(option.value)];
    return icon === undefined ? option : { ...option, icon };
  });
}

/** The property a field edits, typed and defaulted from its setting definition (SET-STO-02). */
export function propertyFor(field: FieldSpec, context: SettingsContext): PropertyDefinition {
  const definition = findDefinition(field.path);
  if (definition === undefined) throw new Error(`Unknown setting: ${field.path}`);
  const fallback = defaultOf(definition, context);
  if (fallback === undefined) throw new Error(`Setting ${field.path} has no default.`);
  const base = {
    key: field.key,
    label: field.label,
    ...(field.control === undefined ? {} : { control: field.control }),
  };
  if (field.options !== undefined) {
    return {
      ...base,
      kind: "choice",
      defaultValue: String(fallback),
      options: withIcons(field.options, field),
    };
  }
  switch (definition.type) {
    case "boolean":
      return { ...base, kind: "boolean", defaultValue: fallback as boolean };
    case "integer":
      return {
        ...base,
        kind: "int32",
        defaultValue: fallback as number,
        min: definition.min ?? 0,
        max: definition.max ?? 0,
      };
    case "float":
      return {
        ...base,
        kind: "double",
        defaultValue: fallback as number,
        min: definition.min ?? 0,
        max: definition.max ?? 0,
      };
    case "enum":
      return {
        ...base,
        kind: "choice",
        defaultValue: String(fallback),
        options: withIcons(
          choiceOptions(definition.choices ?? [], field.blendLabels === true),
          field,
        ),
      };
    case "color":
      return {
        ...base,
        kind: "color",
        alphaMode: "opaqueOnly",
        defaultValue: toPropertyValue(fallback) as ColorValue,
      };
    case "string":
      return { ...base, kind: "string", defaultValue: fallback as string };
    default:
      throw new Error(`Setting ${field.path} cannot be shown as a control.`);
  }
}

/** The validated property schema of a form block (EXT-06 rules are checked on definition). */
export function blockSchema(block: FormBlock, context: SettingsContext): PropertySchema {
  return definePropertySchema({
    properties: block.fields.map((field) => propertyFor(field, context)),
    ...(block.rules === undefined ? {} : { rules: block.rules }),
  });
}

/** The key of a field for a setting path: the path with dots turned into underscores. */
export function keyOfPath(path: string): string {
  return path.replaceAll(".", "_");
}
