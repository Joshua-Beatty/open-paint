import { describe, expect, it } from "vitest";
import {
  defaultValue,
  definePropertySchema,
  migrateValues,
  resolveValues,
  serializeValues,
} from "./index";

const colorSchema = definePropertySchema({
  properties: [
    {
      kind: "color",
      key: "paint",
      label: "property.quality",
      defaultValue: { r: 0.25, g: 0.5, b: 0.75, a: 1 },
      alphaMode: "supportsAlpha",
    },
    {
      kind: "vector2",
      key: "pan",
      label: "property.quality",
      defaultValue: { x: 0, y: 0 },
      min: { x: -1, y: -1 },
      max: { x: 1, y: 1 },
    },
    {
      kind: "choice",
      key: "mode",
      label: "property.quality",
      defaultValue: "a",
      options: [
        { value: "a", label: "property.quality" },
        { value: "b", label: "property.quality" },
      ],
    },
  ],
});

describe("resolveValues", () => {
  it("uses defaults for missing values and for values of the wrong type", () => {
    expect(resolveValues(colorSchema, undefined)).toEqual({
      paint: { r: 0.25, g: 0.5, b: 0.75, a: 1 },
      pan: { x: 0, y: 0 },
      mode: "a",
    });
    expect(resolveValues(colorSchema, { mode: 7, pan: "left" })).toEqual({
      paint: { r: 0.25, g: 0.5, b: 0.75, a: 1 },
      pan: { x: 0, y: 0 },
      mode: "a",
    });
  });

  it("returns copies, so changing a result never changes the schema default", () => {
    const paint = colorSchema.properties[0];
    if (!paint) throw new Error("The schema has no color property.");
    const resolved = resolveValues(colorSchema, undefined);
    expect(resolved.paint).not.toBe(paint.defaultValue);
    expect(defaultValue(paint)).toEqual({ r: 0.25, g: 0.5, b: 0.75, a: 1 });
  });

  it("enforces the soft min/max and linked-boolean invariants on stored values", () => {
    const linked = definePropertySchema({
      properties: [
        { kind: "boolean", key: "linked", label: "property.quality", defaultValue: false },
        { kind: "int32", key: "low", label: "property.quality", defaultValue: 1, min: 0, max: 9 },
        { kind: "int32", key: "high", label: "property.quality", defaultValue: 5, min: 0, max: 9 },
        { kind: "int32", key: "w", label: "property.quality", defaultValue: 2, min: 0, max: 9 },
        { kind: "int32", key: "h", label: "property.quality", defaultValue: 2, min: 0, max: 9 },
      ],
      rules: [
        { kind: "softMinMax", lower: "low", upper: "high" },
        { kind: "linkValuesWhenBoolean", source: "linked", when: true, keys: ["w", "h"] },
      ],
    });
    expect(resolveValues(linked, { low: 8, high: 3, linked: true, w: 7, h: 1 })).toMatchObject({
      low: 8,
      high: 8,
      w: 7,
      h: 7,
    });
  });
});

describe("serializeValues", () => {
  it("produces a plain JSON object that round-trips", () => {
    const values = resolveValues(colorSchema, { paint: { r: 1, g: 0, b: 0, a: 0.5 }, mode: "b" });
    const json = JSON.parse(JSON.stringify(serializeValues(colorSchema, values))) as unknown;
    expect(json).toEqual({
      paint: { r: 1, g: 0, b: 0, a: 0.5 },
      pan: { x: 0, y: 0 },
      mode: "b",
    });
    expect(resolveValues(colorSchema, json)).toEqual(values);
  });
});

describe("migrateValues", () => {
  const v2 = definePropertySchema({
    version: 2,
    properties: [
      {
        kind: "double",
        key: "radius",
        label: "property.radius",
        defaultValue: 2,
        min: 0,
        max: 300,
      },
    ],
    migrations: [
      {
        from: 1,
        migrate: ({ amount, ...rest }) => ({ ...rest, radius: amount }),
      },
    ],
  });

  it("applies the migrations that follow the stored version", () => {
    expect(migrateValues(v2, { amount: 7 }, 1)).toEqual({ radius: 7 });
  });

  it("reads values at the current version without migrating", () => {
    expect(migrateValues(v2, { radius: 9 }, 2)).toEqual({ radius: 9 });
  });

  it("keeps the values of versions that have no migration and clamps them", () => {
    const v3 = definePropertySchema({
      version: 3,
      properties: v2.properties,
      migrations: [{ from: 2, migrate: (record) => record }],
    });
    expect(migrateValues(v3, { radius: 500 }, 1)).toEqual({ radius: 300 });
  });

  it("falls back to defaults when the stored record is not an object", () => {
    expect(migrateValues(v2, "garbage", 1)).toEqual({ radius: 2 });
  });
});
