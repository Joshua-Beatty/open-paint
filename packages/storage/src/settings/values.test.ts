import { describe, expect, it } from "vitest";
import { findDefinition, type SettingDefinition } from "./definitions";
import { cloneSetting, normalizeSetting, parseMirrored } from "./values";

function definition(path: string): SettingDefinition {
  const found = findDefinition(path);
  if (!found) throw new Error(`No definition for ${path}`);
  return found;
}

describe("normalizeSetting (SET-STO-02)", () => {
  it("clamps floats to the range and keeps decimals", () => {
    const brightness = definition("canvas.checkerboardBrightness");
    expect(normalizeSetting(brightness, 0)).toBe(0.25);
    expect(normalizeSetting(brightness, 9)).toBe(1);
    expect(normalizeSetting(brightness, 0.4)).toBe(0.4);
  });

  it("rounds integers and then clamps them", () => {
    const quality = definition("effects.defaultQualityCpu");
    expect(normalizeSetting(quality, 2.6)).toBe(3);
    expect(normalizeSetting(quality, 0)).toBe(1);
    expect(normalizeSetting(quality, 99)).toBe(5);
  });

  it("rejects non-finite numbers and values of the wrong type", () => {
    expect(normalizeSetting(definition("tools.brush.size"), Number.NaN)).toBeUndefined();
    expect(normalizeSetting(definition("tools.brush.size"), Infinity)).toBeUndefined();
    expect(normalizeSetting(definition("tools.brush.size"), "3")).toBeUndefined();
    expect(normalizeSetting(definition("canvas.dropShadow"), 1)).toBeUndefined();
    expect(normalizeSetting(definition("app.lastRunVersion"), 1)).toBeUndefined();
  });

  it("accepts only the listed choices for enums", () => {
    const theme = definition("ui.theme");
    expect(normalizeSetting(theme, "Dark")).toBe("Dark");
    expect(normalizeSetting(theme, "Blue")).toBeUndefined();
    expect(normalizeSetting(theme, 1)).toBeUndefined();
  });

  it("rounds colour channels into 0 to 255", () => {
    const colour = definition("canvas.customBorderColor");
    expect(normalizeSetting(colour, { r: 300, g: -4, b: 10.6, a: 255 })).toEqual({
      r: 255,
      g: 0,
      b: 11,
      a: 255,
    });
    expect(normalizeSetting(colour, { r: 1, g: 2, b: 3 })).toBeUndefined();
  });

  it("rounds rectangles to integers", () => {
    const bounds = definition("window.dialogs.save.bounds");
    expect(normalizeSetting(bounds, { x: 1.4, y: 2.5, width: 300, height: 200.6 })).toEqual({
      x: 1,
      y: 3,
      width: 300,
      height: 201,
    });
  });

  it("accepts only the array lengths the setting allows", () => {
    const ratios = definition("layout.rightSidebar.splitRatios");
    expect(normalizeSetting(ratios, [])).toEqual([]);
    expect(normalizeSetting(ratios, [0.2, 0.3, 0.5])).toEqual([0.2, 0.3, 0.5]);
    expect(normalizeSetting(ratios, [0.2, 0.3])).toBeUndefined();
    expect(normalizeSetting(ratios, [0.2, 0.3, 2])).toEqual([0.2, 0.3, 1]);
  });

  it("keeps at most the maximum number of list entries", () => {
    const recent = definition("file.recent");
    const entries = Array.from({ length: 12 }, (_, index) => ({ name: `f${index}.png` }));
    expect(normalizeSetting(recent, entries)).toHaveLength(10);
  });

  it("keeps JSON objects as independent copies", () => {
    const shape = definition("toolDefaults.shapes.shape");
    const source = { name: "rectangle", category: "basic" };
    const stored = normalizeSetting(shape, source) as Record<string, unknown>;
    source.name = "ellipse";
    expect(stored).toEqual({ name: "rectangle", category: "basic" });
    expect(normalizeSetting(shape, "rectangle")).toBeUndefined();
  });

  it("keeps handles unchanged and rejects non-objects", () => {
    const location = definition("file.lastPickerLocation");
    const handle = { kind: "directory" };
    expect(normalizeSetting(location, handle)).toBe(handle);
    expect(normalizeSetting(location, "C:/")).toBeUndefined();
  });
});

describe("cloneSetting", () => {
  it("copies colours so that changes do not reach the stored value", () => {
    const original = { r: 1, g: 2, b: 3, a: 4 };
    const copy = cloneSetting("color", original) as typeof original;
    copy.r = 99;
    expect(original.r).toBe(1);
  });
});

describe("parseMirrored", () => {
  it("returns a valid mirrored value and ignores anything else", () => {
    const theme = definition("ui.theme");
    expect(parseMirrored(theme, "Light")).toBe("Light");
    expect(parseMirrored(theme, "Sepia")).toBeUndefined();
    expect(parseMirrored(theme, null)).toBeUndefined();
  });
});
