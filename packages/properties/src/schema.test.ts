import { describe, expect, it } from "vitest";
import {
  allowedControlTypes,
  defaultValues,
  definePropertySchema,
  effectiveControlType,
  type Int32Property,
  layoutOf,
  mergeSchemas,
  type PropertyDefinition,
  type PropertySchema,
  PropertySchemaError,
  resolveValues,
} from "./index";

const schema = definePropertySchema({
  properties: [
    {
      kind: "double",
      key: "radius",
      label: "property.radius",
      defaultValue: 2,
      min: 0,
      max: 300,
      control: { decimalPlaces: 1, useExponentialScale: true },
    },
    { kind: "int32", key: "quality", label: "property.quality", defaultValue: 3, min: 1, max: 4 },
  ],
});

const quality: Int32Property = {
  kind: "int32",
  key: "quality",
  label: "property.quality",
  defaultValue: 3,
  min: 1,
  max: 4,
};

function withProperties(...properties: PropertyDefinition[]): PropertySchema {
  return { properties };
}

describe("property schema values", () => {
  it("builds the default values from the schema", () => {
    expect(defaultValues(schema)).toEqual({ radius: 2, quality: 3 });
  });

  it("clamps out-of-range values and rounds integers", () => {
    expect(resolveValues(schema, { radius: 500, quality: 2.6 })).toEqual({
      radius: 300,
      quality: 3,
    });
    expect(resolveValues(schema, { radius: -4, quality: 0 })).toEqual({ radius: 0, quality: 1 });
  });

  it("falls back to defaults for missing or non-finite values and drops unknown keys", () => {
    expect(resolveValues(schema, { radius: Number.NaN, extra: 9 })).toEqual({
      radius: 2,
      quality: 3,
    });
  });
});

describe("definePropertySchema", () => {
  it("accepts a schema and returns it unchanged", () => {
    expect(definePropertySchema(withProperties(quality))).toEqual({ properties: [quality] });
  });

  it("rejects duplicate keys and empty keys", () => {
    expect(() => definePropertySchema(withProperties(quality, quality))).toThrow(
      PropertySchemaError,
    );
    expect(() => definePropertySchema(withProperties({ ...quality, key: "" }))).toThrow(
      PropertySchemaError,
    );
  });

  it("rejects bad ranges and integer bounds on Int32", () => {
    expect(() => definePropertySchema(withProperties({ ...quality, min: 5, max: 1 }))).toThrow(
      /min above max/,
    );
    expect(() =>
      definePropertySchema(withProperties({ ...quality, min: 0.5, defaultValue: 1 })),
    ).toThrow(/integer bounds/);
  });

  it("rejects a default that is out of range or of the wrong type", () => {
    expect(() => definePropertySchema(withProperties({ ...quality, defaultValue: 9 }))).toThrow(
      /default value of "quality"/,
    );
    expect(() =>
      definePropertySchema(withProperties({ ...quality, defaultValue: "3" as unknown as number })),
    ).toThrow(PropertySchemaError);
  });

  it("validates choice options", () => {
    const choice = {
      kind: "choice",
      key: "mode",
      label: "property.quality",
      defaultValue: "a",
      options: [{ value: "a", label: "property.quality" }],
    } as const;
    expect(() => definePropertySchema(withProperties(choice))).not.toThrow();
    expect(() => definePropertySchema(withProperties({ ...choice, options: [] }))).toThrow(
      /at least one option/,
    );
    expect(() =>
      definePropertySchema(
        withProperties({
          ...choice,
          options: [
            { value: "a", label: "property.quality" },
            { value: "a", label: "property.quality" },
          ],
        }),
      ),
    ).toThrow(/duplicate options/);
  });

  it("requires a tab count of at least one and one page per tab", () => {
    const tabs = {
      kind: "tabState",
      key: "tab",
      label: "property.quality",
      defaultValue: 0,
      tabCount: 0,
    } as const;
    expect(() => definePropertySchema(withProperties(tabs))).toThrow(/tabCount/);
    const valid = { ...tabs, tabCount: 2 } as const;
    expect(() =>
      definePropertySchema({
        properties: [valid],
        layout: [
          { kind: "tabs", key: "tab", pages: [{ label: "property.quality", children: [] }] },
        ],
      }),
    ).toThrow(/one page per tab/);
  });

  it("only allows control types that show the property's kind", () => {
    expect(() =>
      definePropertySchema(withProperties({ ...quality, control: { controlType: "checkbox" } })),
    ).toThrow(/cannot show "quality"/);
    expect(() =>
      definePropertySchema(
        withProperties({ ...quality, control: { controlType: "incrementButton" } }),
      ),
    ).not.toThrow();
  });

  it("shows only a boolean as a two-value drop-down", () => {
    const face = { icon: "M2 2h12", label: "property.quality" } as const;
    const booleanChoices = { on: face, off: face };
    const flag = {
      kind: "boolean",
      key: "flag",
      label: "property.quality",
      defaultValue: false,
      control: { booleanChoices },
    } as const;
    expect(() => definePropertySchema(withProperties(flag))).not.toThrow();
    expect(() =>
      definePropertySchema(withProperties({ ...quality, control: { booleanChoices } })),
    ).toThrow(/Only a boolean/);
  });

  it("lays out only a radio-button choice as a grid holding every option once", () => {
    const choice = {
      kind: "choice",
      key: "corner",
      label: "property.position",
      defaultValue: "a",
      options: [
        { value: "a", label: "property.position" },
        { value: "b", label: "property.position" },
        { value: "c", label: "property.position" },
      ],
    } as const;
    const grid = (rows: (string | null)[][], extra: object = {}) =>
      definePropertySchema(
        withProperties({
          ...choice,
          control: { controlType: "radioButtons", choiceGrid: { rows, ...extra } },
        }),
      );
    expect(() =>
      grid(
        [
          ["a", "b"],
          ["c", null],
        ],
        { gapAfterRows: [0], gapAfterColumns: [0] },
      ),
    ).not.toThrow();
    expect(() => grid([["a", "b"], ["c"]])).toThrow(/one non-zero length/);
    expect(() => grid([["a", "b"]])).toThrow(/every option exactly once/);
    expect(() => grid([["a", "b", "b", "c"]])).toThrow(/every option exactly once/);
    expect(() => grid([["a", "b", "c"]], { gapAfterColumns: [2] })).toThrow(/gap/);
    expect(() =>
      definePropertySchema(
        withProperties({ ...choice, control: { choiceGrid: { rows: [["a", "b", "c"]] } } }),
      ),
    ).toThrow(/radio buttons/);
  });

  it("validates numeric control options", () => {
    expect(() =>
      definePropertySchema(withProperties({ ...quality, control: { decimalPlaces: 20 } })),
    ).toThrow(/decimalPlaces/);
    expect(() =>
      definePropertySchema(withProperties({ ...quality, control: { sliderSmallChange: -1 } })),
    ).toThrow(/sliderSmallChange/);
    expect(() =>
      definePropertySchema(withProperties({ ...quality, control: { exponentialScale: 0 } })),
    ).toThrow(/exponentialScale/);
  });

  it("validates rule keys and kinds", () => {
    const flag = {
      kind: "boolean",
      key: "flag",
      label: "property.quality",
      defaultValue: false,
    } as const;
    expect(() =>
      definePropertySchema({
        properties: [flag, quality],
        rules: [{ kind: "readOnlyWhenBoolean", target: "quality", source: "missing" }],
      }),
    ).toThrow(/unknown property "missing"/);
    expect(() =>
      definePropertySchema({
        properties: [flag, quality],
        rules: [{ kind: "readOnlyWhenBoolean", target: "quality", source: "quality" }],
      }),
    ).toThrow(/is int32/);
    expect(() =>
      definePropertySchema({
        properties: [flag],
        rules: [{ kind: "readOnlyWhenBoolean", target: "flag", source: "flag" }],
      }),
    ).toThrow(/two different properties/);
  });

  it("requires soft min/max pairs to share a kind and range", () => {
    const low = { ...quality, key: "low" };
    const high = { ...quality, key: "high", max: 9 };
    expect(() =>
      definePropertySchema({
        properties: [low, high],
        rules: [{ kind: "softMinMax", lower: "low", upper: "high" }],
      }),
    ).toThrow(/share a kind and range/);
    expect(() =>
      definePropertySchema({
        properties: [low, { ...high, max: 4 }],
        rules: [{ kind: "softMinMax", lower: "low", upper: "high" }],
      }),
    ).not.toThrow();
  });

  it("rejects defaults that break a soft min/max rule", () => {
    const low = { ...quality, key: "low", defaultValue: 4 };
    const high = { ...quality, key: "high", defaultValue: 2 };
    expect(() =>
      definePropertySchema({
        properties: [low, high],
        rules: [{ kind: "softMinMax", lower: "low", upper: "high" }],
      }),
    ).toThrow(/softMinMax/);
  });

  it("rejects a layout that places a key twice or refers to an unknown key", () => {
    expect(() =>
      definePropertySchema({
        properties: [quality],
        layout: [
          { kind: "control", key: "quality" },
          { kind: "panel", children: [{ kind: "control", key: "quality" }] },
        ],
      }),
    ).toThrow(/more than once/);
    expect(() =>
      definePropertySchema({ properties: [quality], layout: [{ kind: "control", key: "nope" }] }),
    ).toThrow(/unknown property "nope"/);
  });

  it("validates versions and migrations", () => {
    expect(() => definePropertySchema({ version: 0, properties: [quality] })).toThrow(/version/);
    expect(() =>
      definePropertySchema({
        version: 2,
        properties: [quality],
        migrations: [{ from: 2, migrate: (record) => record }],
      }),
    ).toThrow(/migration must read/);
    expect(() =>
      definePropertySchema({
        version: 3,
        properties: [quality],
        migrations: [
          { from: 1, migrate: (record) => record },
          { from: 1, migrate: (record) => record },
        ],
      }),
    ).toThrow(/Two migrations/);
  });
});

describe("control types", () => {
  it("uses the EXT-06A default control for each kind unless overridden", () => {
    expect(effectiveControlType(quality)).toBe("slider");
    expect(effectiveControlType({ ...quality, control: { controlType: "incrementButton" } })).toBe(
      "incrementButton",
    );
  });

  it("lists the default, the alternatives and hidden for a kind", () => {
    expect(allowedControlTypes("int32")).toEqual([
      "slider",
      "incrementButton",
      "colorWheel",
      "hidden",
    ]);
    expect(allowedControlTypes("boolean")).toEqual(["checkbox", "hidden"]);
    expect(allowedControlTypes("tabState")).toEqual(["hidden"]);
  });
});

describe("layout", () => {
  it("lists visible controls in declaration order when there is no explicit layout", () => {
    const withHidden = definePropertySchema({
      properties: [
        quality,
        {
          kind: "boolean",
          key: "flag",
          label: "property.quality",
          defaultValue: true,
          control: { controlType: "hidden" },
        },
        { kind: "boolean", key: "other", label: "property.quality", defaultValue: true },
      ],
    });
    expect(layoutOf(withHidden)).toEqual([
      { kind: "control", key: "quality" },
      { kind: "control", key: "other" },
    ]);
  });

  it("returns the explicit layout when one is given", () => {
    const layout = [{ kind: "control", key: "quality" }] as const;
    expect(layoutOf(definePropertySchema({ properties: [quality], layout }))).toBe(layout);
  });
});

describe("mergeSchemas", () => {
  it("combines the properties, rules and layouts of two schemas", () => {
    const merged = mergeSchemas(schema, withProperties({ ...quality, key: "extra" }));
    expect(merged.properties.map((property) => property.key)).toEqual([
      "radius",
      "quality",
      "extra",
    ]);
    expect(
      layoutOf(merged).map((node) => (node.kind === "control" ? node.key : node.kind)),
    ).toEqual(["radius", "quality", "extra"]);
  });

  it("rejects a merge with a duplicate key", () => {
    expect(() => mergeSchemas(schema, withProperties(quality))).toThrow(/Duplicate property key/);
  });
});
