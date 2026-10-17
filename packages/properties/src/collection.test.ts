import { describe, expect, it } from "vitest";
import {
  definePropertySchema,
  PropertyCollection,
  type PropertyEvents,
  PropertyValidationError,
} from "./index";

type ValueEvent = PropertyEvents["valueChanged"];
type ReadOnlyEvent = PropertyEvents["readOnlyChanged"];

function recordEvents(collection: PropertyCollection) {
  const values: ValueEvent[] = [];
  const readOnly: ReadOnlyEvent[] = [];
  collection.on("valueChanged", (event) => values.push(event));
  collection.on("readOnlyChanged", (event) => readOnly.push(event));
  return { values, readOnly };
}

const basic = definePropertySchema({
  properties: [
    {
      kind: "double",
      key: "amount",
      label: "property.radius",
      defaultValue: 5,
      min: 0,
      max: 10,
    },
    {
      kind: "double",
      key: "gain",
      label: "property.radius",
      defaultValue: 1,
      min: 0,
      max: 10,
      onInvalid: "ignore",
    },
    {
      kind: "int32",
      key: "count",
      label: "property.quality",
      defaultValue: 2,
      min: 0,
      max: 9,
      onInvalid: "reject",
    },
    {
      kind: "vector2",
      key: "pan",
      label: "property.quality",
      defaultValue: { x: 0, y: 0 },
      min: { x: -1, y: -1 },
      max: { x: 1, y: 1 },
    },
  ],
});

describe("PropertyCollection.merge (EXT-06A-14)", () => {
  it("holds the values of both collections under the merged schema", () => {
    const extra = definePropertySchema({
      properties: [{ kind: "boolean", key: "flag", label: "property.radius", defaultValue: true }],
    });
    const first = new PropertyCollection(basic, { amount: 7 });
    const second = new PropertyCollection(extra, { flag: false });

    const merged = PropertyCollection.merge(first, second);

    expect(merged.schema.properties.map((property) => property.key)).toEqual([
      "amount",
      "gain",
      "count",
      "pan",
      "flag",
    ]);
    expect(merged.get("amount")).toBe(7);
    expect(merged.get("flag")).toBe(false);
    expect(merged.get("gain")).toBe(1);
  });

  it("rejects schemas that share a key", () => {
    const first = new PropertyCollection(basic);
    expect(() => PropertyCollection.merge(first, first)).toThrow(/Duplicate property key/);
  });
});

describe("PropertyCollection writes", () => {
  it("clamps an invalid value to its range and raises valueChanged", () => {
    const collection = new PropertyCollection(basic);
    const { values } = recordEvents(collection);
    collection.set("amount", 50);
    expect(collection.get("amount")).toBe(10);
    expect(values).toEqual([{ key: "amount", value: 10 }]);
  });

  it("falls back to the default for a value that cannot be used under clamp", () => {
    const collection = new PropertyCollection(basic, { amount: 7 });
    collection.set("amount", Number.NaN);
    expect(collection.get("amount")).toBe(5);
  });

  it("keeps the old value under ignore and still raises valueChanged", () => {
    const collection = new PropertyCollection(basic, { gain: 3 });
    const { values } = recordEvents(collection);
    collection.set("gain", "loud");
    expect(collection.get("gain")).toBe(3);
    expect(values).toEqual([{ key: "gain", value: 3 }]);
  });

  it("throws PropertyValidationError under reject and keeps the value", () => {
    const collection = new PropertyCollection(basic, { count: 4 });
    expect(() => collection.set("count", "many")).toThrow(PropertyValidationError);
    expect(collection.get("count")).toBe(4);
    try {
      collection.set("count", "many");
    } catch (error) {
      expect(error).toBeInstanceOf(PropertyValidationError);
      expect((error as PropertyValidationError).key).toBe("count");
    }
    collection.set("count", 1.4);
    expect(collection.get("count")).toBe(1);
  });

  it("does not raise events for a write that changes nothing", () => {
    const collection = new PropertyCollection(basic, { amount: 4 });
    const { values } = recordEvents(collection);
    collection.set("amount", 4);
    expect(values).toEqual([]);
  });

  it("rejects unknown keys", () => {
    const collection = new PropertyCollection(basic);
    expect(() => collection.set("nope", 1)).toThrow(/Unknown property "nope"/);
    expect(() => collection.get("nope")).toThrow(/Unknown property "nope"/);
  });

  it("returns copies of vector values", () => {
    const collection = new PropertyCollection(basic, { pan: { x: 0.5, y: 0 } });
    expect(collection.get("pan")).not.toBe(collection.get("pan"));
    expect(collection.get("pan")).toEqual({ x: 0.5, y: 0 });
  });

  it("stops notifying after unsubscribing", () => {
    const collection = new PropertyCollection(basic);
    const seen: ValueEvent[] = [];
    const unsubscribe = collection.on("valueChanged", (event) => seen.push(event));
    collection.set("amount", 2);
    unsubscribe();
    collection.set("amount", 3);
    expect(seen).toEqual([{ key: "amount", value: 2 }]);
  });
});

describe("read-only state", () => {
  const locking = definePropertySchema({
    properties: [
      { kind: "boolean", key: "locked", label: "property.quality", defaultValue: false },
      { kind: "double", key: "amount", label: "property.radius", defaultValue: 5, min: 0, max: 10 },
      {
        kind: "double",
        key: "fixed",
        label: "property.radius",
        defaultValue: 1,
        min: 0,
        max: 10,
        readOnly: true,
      },
    ],
    rules: [{ kind: "readOnlyWhenBoolean", target: "amount", source: "locked" }],
  });

  it("follows a readOnlyWhenBoolean rule and raises readOnlyChanged", () => {
    const collection = new PropertyCollection(locking);
    const { readOnly } = recordEvents(collection);
    collection.set("locked", true);
    expect(collection.isReadOnly("amount")).toBe(true);
    expect(readOnly).toEqual([{ key: "amount", readOnly: true }]);

    collection.set("amount", 3);
    expect(collection.get("amount")).toBe(5);

    collection.set("locked", false);
    expect(collection.isReadOnly("amount")).toBe(false);
    expect(readOnly.at(-1)).toEqual({ key: "amount", readOnly: false });
  });

  it("respects the initial readOnly flag until a runtime flag replaces it", () => {
    const collection = new PropertyCollection(locking);
    collection.set("fixed", 4);
    expect(collection.get("fixed")).toBe(1);
    collection.setReadOnly("fixed", false);
    collection.set("fixed", 4);
    expect(collection.get("fixed")).toBe(4);
  });

  it("lets setReadOnly lock and unlock a property with events", () => {
    const collection = new PropertyCollection(locking);
    const { readOnly } = recordEvents(collection);
    collection.setReadOnly("amount", true);
    expect(readOnly).toEqual([{ key: "amount", readOnly: true }]);
    collection.set("amount", 9);
    expect(collection.get("amount")).toBe(5);
    collection.setReadOnly("amount", false);
    collection.set("amount", 9);
    expect(collection.get("amount")).toBe(9);
  });

  it("applies readOnlyWhenValue with inversion and readOnlyWhenNameValues", () => {
    const modes = definePropertySchema({
      properties: [
        {
          kind: "choice",
          key: "mode",
          label: "property.quality",
          defaultValue: "off",
          options: [
            { value: "off", label: "property.quality" },
            { value: "low", label: "property.quality" },
            { value: "high", label: "property.quality" },
          ],
        },
        { kind: "boolean", key: "locked", label: "property.quality", defaultValue: false },
        {
          kind: "double",
          key: "strength",
          label: "property.radius",
          defaultValue: 1,
          min: 0,
          max: 10,
        },
        { kind: "double", key: "tint", label: "property.radius", defaultValue: 1, min: 0, max: 10 },
      ],
      rules: [
        {
          kind: "readOnlyWhenValue",
          target: "strength",
          source: "mode",
          values: ["off"],
          inverted: true,
        },
        {
          kind: "readOnlyWhenNameValues",
          target: "tint",
          conditions: [
            { name: "mode", value: "high" },
            { name: "locked", value: true },
          ],
        },
      ],
    });
    const collection = new PropertyCollection(modes);
    expect(collection.isReadOnly("strength")).toBe(false);
    collection.set("mode", "low");
    expect(collection.isReadOnly("strength")).toBe(true);
    collection.set("strength", 3);
    expect(collection.get("strength")).toBe(1);

    expect(collection.isReadOnly("tint")).toBe(false);
    collection.set("locked", true);
    expect(collection.isReadOnly("tint")).toBe(true);
    collection.set("locked", false);
    collection.set("mode", "high");
    expect(collection.isReadOnly("tint")).toBe(true);
  });
});

describe("inter-property rules", () => {
  it("applies setTargetWhenSourceEquals, including the inverted form", () => {
    const schema = definePropertySchema({
      properties: [
        {
          kind: "choice",
          key: "mode",
          label: "property.quality",
          defaultValue: "off",
          options: [
            { value: "off", label: "property.quality" },
            { value: "low", label: "property.quality" },
          ],
        },
        {
          kind: "int32",
          key: "sides",
          label: "property.quality",
          defaultValue: 4,
          min: 0,
          max: 12,
          readOnly: true,
        },
        { kind: "double", key: "fine", label: "property.radius", defaultValue: 1, min: 0, max: 10 },
      ],
      rules: [
        {
          kind: "setTargetWhenSourceEquals",
          source: "mode",
          values: ["off"],
          target: "sides",
          targetValue: 0,
        },
        {
          kind: "setTargetWhenSourceEquals",
          source: "mode",
          values: ["off"],
          target: "fine",
          targetValue: 9,
          inverted: true,
        },
      ],
    });
    const collection = new PropertyCollection(schema);
    const { values } = recordEvents(collection);

    collection.set("mode", "low");
    expect(collection.get("sides")).toBe(4);
    expect(collection.get("fine")).toBe(9);

    collection.set("mode", "off");
    expect(collection.get("sides")).toBe(0);
    expect(collection.get("fine")).toBe(9);
    expect(values.map((event) => event.key)).toEqual(["mode", "fine", "mode", "sides"]);
  });

  it("keeps softMinMax by moving the other bound", () => {
    const schema = definePropertySchema({
      properties: [
        { kind: "int32", key: "lower", label: "property.quality", defaultValue: 1, min: 0, max: 9 },
        { kind: "int32", key: "upper", label: "property.quality", defaultValue: 5, min: 0, max: 9 },
      ],
      rules: [{ kind: "softMinMax", lower: "lower", upper: "upper" }],
    });
    const collection = new PropertyCollection(schema);
    const { values } = recordEvents(collection);

    collection.set("lower", 7);
    expect(collection.values()).toEqual({ lower: 7, upper: 7 });
    expect(values).toEqual([
      { key: "lower", value: 7 },
      { key: "upper", value: 7 },
    ]);

    collection.set("upper", 2);
    expect(collection.values()).toEqual({ lower: 2, upper: 2 });
  });

  it("keeps linked values equal while the boolean is true", () => {
    const schema = definePropertySchema({
      properties: [
        { kind: "boolean", key: "linked", label: "property.quality", defaultValue: false },
        { kind: "int32", key: "w", label: "property.quality", defaultValue: 2, min: 0, max: 9 },
        { kind: "int32", key: "h", label: "property.quality", defaultValue: 2, min: 0, max: 9 },
      ],
      rules: [{ kind: "linkValuesWhenBoolean", source: "linked", when: true, keys: ["w", "h"] }],
    });
    const collection = new PropertyCollection(schema);

    collection.set("w", 6);
    expect(collection.get("h")).toBe(2);

    collection.set("linked", true);
    expect(collection.get("h")).toBe(6);

    collection.set("h", 1);
    expect(collection.get("w")).toBe(1);

    collection.set("linked", false);
    collection.set("w", 4);
    expect(collection.get("h")).toBe(1);
  });

  it("settles when two rules write each other's sources", () => {
    const schema = definePropertySchema({
      properties: [
        { kind: "int32", key: "a", label: "property.quality", defaultValue: 0, min: 0, max: 9 },
        { kind: "int32", key: "b", label: "property.quality", defaultValue: 0, min: 0, max: 9 },
      ],
      rules: [
        {
          kind: "setTargetWhenSourceEquals",
          source: "a",
          values: [1],
          target: "b",
          targetValue: 2,
        },
        {
          kind: "setTargetWhenSourceEquals",
          source: "b",
          values: [2],
          target: "a",
          targetValue: 1,
        },
      ],
    });
    const collection = new PropertyCollection(schema);
    collection.set("a", 1);
    expect(collection.values()).toEqual({ a: 1, b: 2 });
  });
});

describe("clone, copy and serialize", () => {
  it("clones values and read-only flags into an independent collection", () => {
    const collection = new PropertyCollection(basic, { amount: 3 });
    collection.setReadOnly("amount", true);
    const copy = collection.clone();
    expect(copy.get("amount")).toBe(3);
    expect(copy.isReadOnly("amount")).toBe(true);
    copy.setReadOnly("amount", false);
    copy.set("amount", 8);
    expect(collection.get("amount")).toBe(3);
    expect(collection.isReadOnly("amount")).toBe(true);
  });

  it("copies only the compatible values from a record or another collection", () => {
    const collection = new PropertyCollection(basic);
    collection.copyFrom({ amount: 4, count: "many", extra: 1, pan: { x: 0.25, y: -0.5 } });
    expect(collection.values()).toEqual({
      amount: 4,
      gain: 1,
      count: 2,
      pan: { x: 0.25, y: -0.5 },
    });

    const source = new PropertyCollection(basic, { gain: 7 });
    collection.copyFrom(source);
    expect(collection.get("gain")).toBe(7);
  });

  it("serializes to plain JSON that reads back to the same values", () => {
    const collection = new PropertyCollection(basic, { pan: { x: 0.5, y: 0.5 } });
    const json = JSON.parse(JSON.stringify(collection.serialize())) as unknown;
    expect(json).toEqual(collection.values());
  });
});
