import type { PropertyDefinition, PropertyValue } from "./types";
import { isRecord } from "./values";

/**
 * The outcome of checking a raw value against a property. `repaired` means the value was usable
 * after clamping, rounding or truncation. `invalid` means it cannot be used at all.
 */
export type Normalized =
  | { readonly status: "valid" | "repaired"; readonly value: PropertyValue }
  | { readonly status: "invalid" };

const INVALID: Normalized = { status: "invalid" };

/** A scheme, then something after the colon (for example `https:example.com`). */
const URI_PATTERN = /^[a-z][a-z\d+.-]*:\S+$/i;

interface NumberRepair {
  readonly value: number;
  readonly repaired: boolean;
}

function result(value: PropertyValue, repaired: boolean): Normalized {
  return { status: repaired ? "repaired" : "valid", value };
}

function repairNumber(
  value: unknown,
  min: number,
  max: number,
  integer: boolean,
): NumberRepair | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = integer ? Math.round(value) : value;
  const clamped = Math.min(max, Math.max(min, rounded));
  return { value: clamped, repaired: clamped !== value };
}

/** Checks a raw value against the property's type and constraints (EXT-06A-13 input). */
export function normalizeValue(definition: PropertyDefinition, value: unknown): Normalized {
  switch (definition.kind) {
    case "boolean":
      return typeof value === "boolean" ? result(value, false) : INVALID;
    case "int32":
    case "double": {
      const number = repairNumber(
        value,
        definition.min,
        definition.max,
        definition.kind === "int32",
      );
      return number ? result(number.value, number.repaired) : INVALID;
    }
    case "vector2": {
      if (!isRecord(value)) return INVALID;
      const x = repairNumber(value.x, definition.min.x, definition.max.x, false);
      const y = repairNumber(value.y, definition.min.y, definition.max.y, false);
      if (!x || !y) return INVALID;
      return result({ x: x.value, y: y.value }, x.repaired || y.repaired);
    }
    case "vector3": {
      if (!isRecord(value)) return INVALID;
      const x = repairNumber(value.x, definition.min.x, definition.max.x, false);
      const y = repairNumber(value.y, definition.min.y, definition.max.y, false);
      const z = repairNumber(value.z, definition.min.z, definition.max.z, false);
      if (!x || !y || !z) return INVALID;
      return result({ x: x.value, y: y.value, z: z.value }, x.repaired || y.repaired || z.repaired);
    }
    case "choice": {
      const option = definition.options.find((candidate) => candidate.value === value);
      return option ? result(option.value, false) : INVALID;
    }
    case "string":
      if (typeof value !== "string") return INVALID;
      if (definition.maxLength !== undefined && value.length > definition.maxLength) {
        return result(value.slice(0, definition.maxLength), true);
      }
      return result(value, false);
    case "uri":
      return typeof value === "string" && URI_PATTERN.test(value) ? result(value, false) : INVALID;
    case "image":
      return typeof value === "string" && value.length > 0 ? result(value, false) : INVALID;
    case "color": {
      if (!isRecord(value)) return INVALID;
      const r = repairNumber(value.r, 0, 1, false);
      const g = repairNumber(value.g, 0, 1, false);
      const b = repairNumber(value.b, 0, 1, false);
      const a = repairNumber(value.a, 0, 1, false);
      if (!r || !g || !b || !a) return INVALID;
      const opaque = definition.alphaMode === "opaqueOnly";
      const alpha = opaque ? 1 : a.value;
      const repaired = r.repaired || g.repaired || b.repaired || a.repaired || alpha !== a.value;
      return result({ r: r.value, g: g.value, b: b.value, a: alpha }, repaired);
    }
    case "tabState": {
      const tab = repairNumber(value, 0, definition.tabCount - 1, true);
      return tab ? result(tab.value, tab.repaired) : INVALID;
    }
  }
}
