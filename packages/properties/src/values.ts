import type { PropertyValue, PropertyValues } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality for property values: primitives by `===`, vectors and colors by field. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** A copy that shares no mutable state with the original. */
export function cloneValue(value: PropertyValue): PropertyValue {
  return typeof value === "object" ? { ...value } : value;
}

/** Reads a numeric property. Throws when the key is missing or not a number. */
export function numberValue(values: PropertyValues, key: string): number {
  const value = values[key];
  if (typeof value !== "number") throw new TypeError(`Property "${key}" is not a number.`);
  return value;
}
