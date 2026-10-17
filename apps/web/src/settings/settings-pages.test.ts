import { enUS } from "@openpaint/i18n";
import { PropertyCollection } from "@openpaint/properties";
import { findDefinition, SETTING_DEFINITIONS } from "@openpaint/storage";
import { describe, expect, it } from "vitest";
import {
  backendBlock,
  CANVAS_BLOCK,
  DEFAULT_TOOL_BLOCK,
  PEN_BLOCK,
  QUALITY_BLOCK,
  SETTINGS_SECTIONS,
  TOOL_IDS,
  TOOL_ROWS,
  UI_BLOCK,
} from "./settings-pages";
import {
  blockSchema,
  type FormBlock,
  fieldPaths,
  keyOfPath,
  propertyFor,
  settingsOptionLabel,
} from "./settings-schema";

const context = { gpuPerformanceClass: "Good" as const };

function allBlocks(): [string, FormBlock][] {
  return [
    ["ui", UI_BLOCK],
    ["canvas", CANVAS_BLOCK],
    ["default tool", DEFAULT_TOOL_BLOCK],
    ["pen", PEN_BLOCK],
    ["backend", backendBlock(true)],
    ["quality", QUALITY_BLOCK],
    ...TOOL_ROWS.map((row): [string, FormBlock] => [row.caption, row.block]),
  ];
}

describe("settings pages", () => {
  it("lists the six v1 sections in SET-DLG-02 order, then the open-source licenses", () => {
    expect(SETTINGS_SECTIONS).toEqual([
      "ui",
      "canvas",
      "tools",
      "pen",
      "graphics",
      "diagnostics",
      "licenses",
    ]);
  });

  it("shows the selection outline quality after Animations, with its footnote (DOC-SEL-04)", () => {
    const [animations, outline] = UI_BLOCK.fields;
    expect(animations?.path).toBe("ui.animations");
    expect(outline?.path).toBe("ui.antialiasedSelectionOutline");
    expect(enUS[outline?.label ?? "settings.field.animations"]).toBe(
      "Antialiased selection outline",
    );
    expect(outline?.control?.footnote).toBe("settings.note.antialiasedSelectionOutline");
    expect(enUS["settings.note.antialiasedSelectionOutline"]).toBe(
      "Disabling this can significantly improve performance on lower end systems.",
    );
    expect(findDefinition("ui.antialiasedSelectionOutline")?.defaultValue).toBe(true);
  });

  it("builds a valid schema for every block", () => {
    for (const [, block] of allBlocks()) {
      expect(() => blockSchema(block, context)).not.toThrow();
    }
  });

  it("binds every field to a known setting with a catalog label", () => {
    for (const [, block] of allBlocks()) {
      for (const field of block.fields) {
        expect(findDefinition(field.path)).toBeDefined();
        expect(enUS[field.label]).toBeDefined();
      }
    }
  });

  it("gives every enum choice a catalog label", () => {
    for (const [, block] of allBlocks()) {
      for (const field of block.fields) {
        const definition = findDefinition(field.path);
        if (definition?.type !== "enum" || field.options !== undefined) continue;
        for (const choice of definition.choices ?? []) {
          const key = field.blendLabels === true ? `blend.${choice}` : settingsOptionLabel(choice);
          expect(enUS[key as keyof typeof enUS], key).toBeDefined();
        }
      }
    }
  });

  it("labels every roster tool and offers the whole roster as the default tool", () => {
    for (const id of TOOL_IDS)
      expect(enUS[`settings.tool.${id}` as keyof typeof enUS]).toBeDefined();
    const field = DEFAULT_TOOL_BLOCK.fields[0];
    expect(field?.path).toBe("toolDefaults.activeTool");
    const property = field === undefined ? undefined : propertyFor(field, context);
    expect(property?.kind === "choice" ? property.options.map((o) => o.value) : []).toEqual([
      ...TOOL_IDS,
    ]);
  });

  it("keeps the spec's ten tool-option rows in order", () => {
    expect(TOOL_ROWS.map((row) => row.caption)).toEqual([
      "settings.row.options",
      "settings.row.brush",
      "settings.row.colorPicker",
      "settings.row.wand",
      "settings.row.gradient",
      "settings.row.shape",
      "settings.row.sampling",
      "settings.row.move",
      "settings.row.selection",
      "settings.row.text",
    ]);
    for (const row of TOOL_ROWS) {
      for (const field of row.block.fields)
        expect(field.path.startsWith("toolDefaults.")).toBe(true);
    }
  });

  it("makes the border colour read-only until its checkbox is ticked", () => {
    const schema = blockSchema(CANVAS_BLOCK, context);
    const collection = new PropertyCollection(schema, {});
    const border = keyOfPath("canvas.customBorderColor");
    const enabled = keyOfPath("canvas.customBorderColorEnabled");
    expect(collection.isReadOnly(border)).toBe(true);
    collection.set(enabled, true);
    expect(collection.isReadOnly(border)).toBe(false);
    collection.set(enabled, false);
    expect(collection.isReadOnly(border)).toBe(true);
  });

  it("uses the factory defaults of the setting table", () => {
    const schema = blockSchema(CANVAS_BLOCK, context);
    const values = new PropertyCollection(schema, {}).values();
    expect(values[keyOfPath("canvas.dropShadow")]).toBe(true);
    expect(values[keyOfPath("canvas.checkerboardBrightness")]).toBe(0.75);
    expect(values[keyOfPath("canvas.customBorderColorEnabled")]).toBe(false);
  });

  it("disables the WebGPU choice when no adapter is available", () => {
    const options = (available: boolean) => {
      const field = backendBlock(available).fields[0];
      const property = field === undefined ? undefined : propertyFor(field, context);
      return property?.kind === "choice" ? property.options : [];
    };
    expect(options(false).find((o) => o.value === "WebGPU")?.disabled).toBe(true);
    expect(options(true).find((o) => o.value === "WebGPU")?.disabled).toBe(false);
    expect(options(false).map((o) => o.value)).toEqual(["Automatic", "WebGPU", "Cpu"]);
  });

  it("names the backend Automatic resolved to (SET-DLG-07a)", () => {
    const automaticLabel = (resolved?: "WebGPU" | "Cpu") => {
      const field = backendBlock(true, resolved).fields[0];
      return field?.options?.find((o) => o.value === "Automatic")?.label;
    };
    expect(automaticLabel()).toBe("settings.option.automatic");
    expect(automaticLabel("WebGPU")).toBe("settings.option.automaticWebgpu");
    expect(automaticLabel("Cpu")).toBe("settings.option.automaticCpu");
    expect(enUS["settings.option.automaticWebgpu"]).toBe("Automatic (WebGPU)");
  });

  it("defaults the GPU quality from the performance class (SET-STO-03)", () => {
    const quality = (cls: "VeryLow" | "Good") => {
      const field = QUALITY_BLOCK.fields[1];
      const property =
        field === undefined ? undefined : propertyFor(field, { gpuPerformanceClass: cls });
      return property?.kind === "int32" ? property.defaultValue : undefined;
    };
    expect(quality("Good")).toBe(2);
    expect(quality("VeryLow")).toBe(1);
  });

  it("exposes every v1 tool default except the ones that wait for the tools", () => {
    // Pickers for brushes and shapes, the font style, the colours (edited in the Colors panel) and
    // the draw size settings belong to the tools (M4).
    const deferred = [
      "toolDefaults.brush.type",
      "toolDefaults.shapes.lineCurveShape",
      "toolDefaults.shapes.shape",
      "toolDefaults.text.fontStyle",
      "toolDefaults.primaryColor",
      "toolDefaults.secondaryColor",
      "toolDefaults.selection.drawWidth",
      "toolDefaults.selection.drawHeight",
      "toolDefaults.selection.drawUnits",
    ];
    const paths = allBlocks().flatMap(([, block]) => block.fields.flatMap(fieldPaths));
    const missing = SETTING_DEFINITIONS.map((definition) => definition.key)
      .filter((key) => key.startsWith("toolDefaults."))
      .filter((key) => !paths.includes(key) && !deferred.includes(key));
    expect(missing).toEqual([]);
    expect(paths).toContain("ui.theme");
    expect(paths).toContain("graphics.backend");
    expect(paths).toContain("penAndTablet.pressureInput");
  });
});
