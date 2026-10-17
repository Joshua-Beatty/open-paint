import { HATCH_PATTERNS } from "@openpaint/document";
import { enUS } from "@openpaint/i18n";
import { iconShape } from "@openpaint/properties";
import { describe, expect, it } from "vitest";
import { FILL_FIELD, TOOL_IDS } from "../settings/settings-pages";
import {
  fieldPaths,
  keyOfPath,
  propertyFor,
  readField,
  writesOf,
} from "../settings/settings-schema";
import {
  optionBlockOf,
  optionFieldsOf,
  TOOL_REGISTRY,
  TOOL_ROSTER,
  toolShowsOption,
} from "./roster";
import { toolIconData } from "./tool-icons";

describe("Selection Mode choices (TL-OPT-SELMODE)", () => {
  it("names each mode and gives its tooltip with the modifier that chooses it", () => {
    const [field] = optionFieldsOf(["selection.combineMode"]);
    const options = field?.options ?? [];
    expect(options.map((option) => option.value)).toEqual([
      "Replace",
      "Union",
      "Exclude",
      "Intersect",
      "Xor",
    ]);
    const tips = options.map((option) =>
      option.tooltip === undefined ? "" : enUS[option.tooltip],
    );
    expect(tips).toEqual([
      "Replace (no modifier)",
      "Add (Ctrl + left button)",
      "Subtract (Alt + left button)",
      "Intersect (Alt + right button)",
      "Invert (Ctrl + right button)",
    ]);
  });
});

/** Hotkey, skip-if-active and commit-capable flags from the TL-ROSTER-01 table. */
const SPEC: Readonly<Record<string, readonly [string, boolean, boolean]>> = {
  rectangleSelect: ["S", false, false],
  moveSelectedPixels: ["M", false, true],
  lassoSelect: ["S", false, false],
  moveSelection: ["M", false, true],
  ellipseSelect: ["S", false, false],
  zoom: ["Z", false, false],
  magicWand: ["S", false, true],
  pan: ["H", false, false],
  paintBucket: ["F", false, true],
  gradient: ["G", false, true],
  paintbrush: ["B", true, false],
  eraser: ["E", true, false],
  pencil: ["P", true, false],
  colorPicker: ["K", true, false],
  cloneStamp: ["L", false, false],
  recolor: ["R", true, false],
  text: ["T", false, true],
  lineCurve: ["O", false, true],
  shapes: ["O", false, true],
};

describe("tool roster", () => {
  it("registers the 19 tools in roster order (TL-ROSTER-01)", () => {
    expect(TOOL_REGISTRY.list().map((tool) => tool.id)).toEqual([...TOOL_IDS]);
    expect(TOOL_ROSTER).toHaveLength(19);
  });

  it("uses the hotkey and flags of each tool in the spec table", () => {
    for (const tool of TOOL_REGISTRY.list()) {
      expect([tool.hotkey, tool.skipIfActive, tool.commitCapable]).toEqual(SPEC[tool.id]);
    }
  });

  it("gives every tool a name, help text and icon", () => {
    for (const tool of TOOL_REGISTRY.list()) {
      expect(enUS[tool.label]).toBeDefined();
      expect(enUS[tool.help]).toBeDefined();
      expect(toolIconData(tool.icon)?.length, tool.id).toBeGreaterThan(0);
    }
  });

  it("draws every tool icon from the icon set, but Line / Curve's own stroked curve", () => {
    for (const tool of TOOL_REGISTRY.list()) {
      const shape = iconShape(toolIconData(tool.icon) ?? "");
      expect(shape.path.length, tool.id).toBeGreaterThan(0);
      expect(shape.filled, tool.id).toBe(tool.id !== "lineCurve");
      // Phosphor's 256 unit grid, but the Zoom and Shapes icons from Remix Icon's 24 unit grid.
      const grid = tool.id === "lineCurve" ? 16 : ["zoom", "shapes"].includes(tool.id) ? 24 : 256;
      expect(shape.viewBox, tool.id).toBe(`0 0 ${grid} ${grid}`);
    }
  });

  it("builds each options schema from the option settings the roster lists", () => {
    for (const entry of TOOL_ROSTER) {
      const schema = TOOL_REGISTRY.get(entry.id)?.options;
      expect(schema?.properties.map((property) => property.key)).toEqual(
        entry.options.map((name) => keyOfPath(`tools.${name}`)),
      );
    }
  });

  it("shows the options that each tool family lists (TL-ROSTER-01)", () => {
    expect(toolShowsOption("paintbrush", "brush.size")).toBe(true);
    expect(toolShowsOption("paintbrush", "selection.renderingQuality")).toBe(true);
    expect(toolShowsOption("eraser", "blendMode")).toBe(false);
    expect(toolShowsOption("pencil", "blendMode")).toBe(true);
    expect(toolShowsOption("zoom", "brush.size")).toBe(false);
  });

  it("offers Solid, then every hatch pattern with its swatch, in one Fill drop-down (TL-OPT-FILL)", () => {
    for (const id of ["paintBucket", "paintbrush", "lineCurve", "shapes"]) {
      const fills = optionBlockOf(id).fields.filter((field) =>
        fieldPaths(field).some((path) => /^tools\.brush\.(fillType|hatchStyle)$/.test(path)),
      );
      expect(fills, id).toHaveLength(1);
      const [fill] = fills;
      if (fill === undefined) throw new Error(`no Fill drop-down for ${id}`);
      expect(fieldPaths(fill)).toEqual(["tools.brush.hatchStyle", "tools.brush.fillType"]);
      const property = propertyFor(fill, { gpuPerformanceClass: "VeryLow" });
      if (property.kind !== "choice") throw new Error("Fill is not a choice");
      expect(property.options.map((option) => option.value)).toEqual([
        "Solid",
        ...HATCH_PATTERNS.ids(),
      ]);
      expect(property.options.map((option) => enUS[option.label])).toEqual([
        "Solid",
        "Horizontal",
        "Vertical",
        "Forward diagonal",
        "Backward diagonal",
        "Cross",
        "Diagonal cross",
        "50% gray",
        "Dotted grid",
      ]);
      expect(property.options.every((option) => (option.icon ?? "").length > 0)).toBe(true);
    }
  });

  it("reads and writes the fill type and hatch style through the Fill drop-down", () => {
    const fill = FILL_FIELD;
    const stored: Record<string, string> = {
      "toolDefaults.brush.fillType": "Solid",
      "toolDefaults.brush.hatchStyle": "Cross",
    };
    const get = (path: string) => stored[path];
    expect(readField(fill, get)).toBe("Solid");
    stored["toolDefaults.brush.fillType"] = "Hatch";
    expect(readField(fill, get)).toBe("Cross");
    stored["toolDefaults.brush.fillType"] = "None";
    expect(readField(fill, get)).toBe("Solid");
    expect(writesOf(fill, "Vertical")).toEqual([
      ["toolDefaults.brush.hatchStyle", "Vertical"],
      ["toolDefaults.brush.fillType", "Hatch"],
    ]);
    expect(writesOf(fill, "Solid")).toEqual([["toolDefaults.brush.fillType", "Solid"]]);
  });
});
