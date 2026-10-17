import type {
  SettingColor,
  SettingDefinition,
  SettingJsonObject,
  SettingPoint,
  SettingRectangle,
  SettingsContext,
  SettingValue,
} from "./definitions";

/**
 * Validates a value against its setting (SET-STO-02). Returns the normalized value, with numbers
 * clamped to the range and integers rounded, or undefined when the value has the wrong type.
 */
export function normalizeSetting(
  definition: SettingDefinition,
  raw: unknown,
): SettingValue | undefined {
  switch (definition.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "integer":
      return isFiniteNumber(raw) ? clampNumber(definition, Math.round(raw)) : undefined;
    case "float":
      return isFiniteNumber(raw) ? clampNumber(definition, raw) : undefined;
    case "string":
      return typeof raw === "string" ? raw : undefined;
    case "enum":
      return typeof raw === "string" && definition.choices?.includes(raw) ? raw : undefined;
    case "color":
      return normalizeColor(raw);
    case "rectangle":
      return normalizeRectangle(raw);
    case "point":
      return normalizePoint(raw);
    case "floatArray":
      return normalizeFloatArray(definition, raw);
    case "list":
      return Array.isArray(raw) ? raw.slice(0, definition.maxItems ?? raw.length) : undefined;
    case "object":
      return isRecord(raw) ? toJsonObject(raw) : undefined;
    case "handle":
      return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : undefined;
  }
}

/** The default for a setting in a context, or undefined when it has none. */
export function defaultOf(
  definition: SettingDefinition,
  context: SettingsContext,
): SettingValue | undefined {
  const value = definition.defaultFor ? definition.defaultFor(context) : definition.defaultValue;
  return value === undefined ? undefined : cloneSetting(definition.type, value);
}

/** An independent copy of a stored value, so callers cannot change what the store holds. */
export function cloneSetting(type: SettingDefinition["type"], value: SettingValue): SettingValue {
  switch (type) {
    case "color":
    case "rectangle":
    case "point":
      return { ...(value as SettingColor | SettingRectangle | SettingPoint) };
    case "floatArray":
    case "list":
      return (value as readonly unknown[]).slice();
    case "object":
      return toJsonObject(value as SettingJsonObject) ?? {};
    default:
      return value;
  }
}

/** Reads a mirrored string (localStorage) as a setting value, or undefined if it is not valid. */
export function parseMirrored(
  definition: SettingDefinition,
  stored: string | null,
): SettingValue | undefined {
  return stored === null ? undefined : normalizeSetting(definition, stored);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampNumber(definition: SettingDefinition, value: number): number {
  let clamped = value;
  if (definition.min !== undefined) clamped = Math.max(definition.min, clamped);
  if (definition.max !== undefined) clamped = Math.min(definition.max, clamped);
  return clamped || 0;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value))) || 0;
}

function normalizeColor(raw: unknown): SettingColor | undefined {
  if (!isRecord(raw)) return undefined;
  const { r, g, b, a } = raw;
  if (!isFiniteNumber(r) || !isFiniteNumber(g) || !isFiniteNumber(b) || !isFiniteNumber(a))
    return undefined;
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b), a: clampByte(a) };
}

function normalizeRectangle(raw: unknown): SettingRectangle | undefined {
  if (!isRecord(raw)) return undefined;
  const { x, y, width, height } = raw;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height))
    return undefined;
  return {
    x: Math.round(x) || 0,
    y: Math.round(y) || 0,
    width: Math.round(width) || 0,
    height: Math.round(height) || 0,
  };
}

function normalizePoint(raw: unknown): SettingPoint | undefined {
  if (!isRecord(raw)) return undefined;
  const { x, y } = raw;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return undefined;
  return { x: Math.round(x) || 0, y: Math.round(y) || 0 };
}

function normalizeFloatArray(definition: SettingDefinition, raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (definition.lengths && !definition.lengths.includes(raw.length)) return undefined;
  if (!raw.every(isFiniteNumber)) return undefined;
  return raw.map((value) => clampNumber(definition, value));
}

function toJsonObject(value: object): SettingJsonObject | undefined {
  try {
    const copy: unknown = JSON.parse(JSON.stringify(value));
    return isRecord(copy) ? copy : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
