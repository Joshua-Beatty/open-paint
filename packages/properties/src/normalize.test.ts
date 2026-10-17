import { describe, expect, it } from "vitest";
import { normalizeValue, type PropertyDefinition } from "./index";

const int: PropertyDefinition = {
  kind: "int32",
  key: "quality",
  label: "property.quality",
  defaultValue: 3,
  min: 1,
  max: 4,
};

describe("normalizeValue", () => {
  it("accepts booleans only", () => {
    const flag: PropertyDefinition = {
      kind: "boolean",
      key: "flag",
      label: "property.quality",
      defaultValue: false,
    };
    expect(normalizeValue(flag, true)).toEqual({ status: "valid", value: true });
    expect(normalizeValue(flag, 1)).toEqual({ status: "invalid" });
  });

  it("rounds and clamps Int32 values and rejects non-finite numbers", () => {
    expect(normalizeValue(int, 3)).toEqual({ status: "valid", value: 3 });
    expect(normalizeValue(int, 2.6)).toEqual({ status: "repaired", value: 3 });
    expect(normalizeValue(int, 500)).toEqual({ status: "repaired", value: 4 });
    expect(normalizeValue(int, Number.POSITIVE_INFINITY)).toEqual({ status: "invalid" });
    expect(normalizeValue(int, Number.NaN)).toEqual({ status: "invalid" });
    expect(normalizeValue(int, "3")).toEqual({ status: "invalid" });
  });

  it("clamps Double values to their range without rounding", () => {
    const double: PropertyDefinition = {
      kind: "double",
      key: "radius",
      label: "property.radius",
      defaultValue: 2,
      min: 0,
      max: 10,
    };
    expect(normalizeValue(double, 2.6)).toEqual({ status: "valid", value: 2.6 });
    expect(normalizeValue(double, -4)).toEqual({ status: "repaired", value: 0 });
  });

  it("clamps each vector axis to its own bounds", () => {
    const vector: PropertyDefinition = {
      kind: "vector2",
      key: "pan",
      label: "property.quality",
      defaultValue: { x: 0, y: 0 },
      min: { x: -10, y: 0 },
      max: { x: 10, y: 1 },
    };
    expect(normalizeValue(vector, { x: 4, y: 2 })).toEqual({
      status: "repaired",
      value: { x: 4, y: 1 },
    });
    expect(normalizeValue(vector, { x: 4 })).toEqual({ status: "invalid" });
  });

  it("validates Vector3 components", () => {
    const vector: PropertyDefinition = {
      kind: "vector3",
      key: "roll",
      label: "property.quality",
      defaultValue: { x: 0, y: 0, z: 0 },
      min: { x: -180, y: -180, z: 0 },
      max: { x: 180, y: 180, z: 90 },
    };
    expect(normalizeValue(vector, { x: 0, y: 0, z: 0 })).toEqual({
      status: "valid",
      value: { x: 0, y: 0, z: 0 },
    });
    expect(normalizeValue(vector, { x: 0, y: 0, z: 120 })).toEqual({
      status: "repaired",
      value: { x: 0, y: 0, z: 90 },
    });
  });

  it("accepts only options of a choice", () => {
    const choice: PropertyDefinition = {
      kind: "choice",
      key: "mode",
      label: "property.quality",
      defaultValue: 2,
      options: [
        { value: "a", label: "property.quality" },
        { value: 2, label: "property.quality" },
      ],
    };
    expect(normalizeValue(choice, 2)).toEqual({ status: "valid", value: 2 });
    expect(normalizeValue(choice, "a")).toEqual({ status: "valid", value: "a" });
    expect(normalizeValue(choice, "b")).toEqual({ status: "invalid" });
  });

  it("truncates strings longer than maxLength", () => {
    const text: PropertyDefinition = {
      kind: "string",
      key: "name",
      label: "property.quality",
      defaultValue: "",
      maxLength: 3,
    };
    expect(normalizeValue(text, "abcdef")).toEqual({ status: "repaired", value: "abc" });
    expect(normalizeValue(text, 7)).toEqual({ status: "invalid" });
  });

  it("requires a scheme for URIs and a non-empty image key", () => {
    const uri: PropertyDefinition = {
      kind: "uri",
      key: "link",
      label: "property.quality",
      defaultValue: "https://example.com",
    };
    expect(normalizeValue(uri, "https://example.com/a")).toEqual({
      status: "valid",
      value: "https://example.com/a",
    });
    expect(normalizeValue(uri, "example.com")).toEqual({ status: "invalid" });
    expect(normalizeValue(uri, "a:b c")).toEqual({ status: "invalid" });

    const image: PropertyDefinition = {
      kind: "image",
      key: "logo",
      label: "property.quality",
      defaultValue: "logo",
    };
    expect(normalizeValue(image, "")).toEqual({ status: "invalid" });
    expect(normalizeValue(image, "logo")).toEqual({ status: "valid", value: "logo" });
  });

  it("forces alpha to 1 for opaque colors and clamps channels", () => {
    const opaque: PropertyDefinition = {
      kind: "color",
      key: "paint",
      label: "property.quality",
      defaultValue: { r: 0, g: 0, b: 0, a: 1 },
      alphaMode: "opaqueOnly",
    };
    expect(normalizeValue(opaque, { r: 0.5, g: 0, b: 0, a: 0.5 })).toEqual({
      status: "repaired",
      value: { r: 0.5, g: 0, b: 0, a: 1 },
    });
    expect(normalizeValue(opaque, { r: 2, g: 0, b: 0, a: 1 })).toEqual({
      status: "repaired",
      value: { r: 1, g: 0, b: 0, a: 1 },
    });

    const translucent: PropertyDefinition = { ...opaque, alphaMode: "supportsAlpha" };
    expect(normalizeValue(translucent, { r: 0, g: 0, b: 0, a: 0.5 })).toEqual({
      status: "valid",
      value: { r: 0, g: 0, b: 0, a: 0.5 },
    });
    expect(normalizeValue(translucent, { r: 0, g: 0, b: 0 })).toEqual({ status: "invalid" });
  });

  it("clamps tab indices to the tab count and rounds them", () => {
    const tabs: PropertyDefinition = {
      kind: "tabState",
      key: "tab",
      label: "property.quality",
      defaultValue: 0,
      tabCount: 3,
    };
    expect(normalizeValue(tabs, 5)).toEqual({ status: "repaired", value: 2 });
    expect(normalizeValue(tabs, 1.4)).toEqual({ status: "repaired", value: 1 });
    expect(normalizeValue(tabs, 1)).toEqual({ status: "valid", value: 1 });
  });
});
