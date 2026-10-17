import { describe, expect, it } from "vitest";
import {
  findDefinition,
  SETTING_DEFINITIONS,
  type SettingDefinition,
  type SettingsContext,
} from "./definitions";
import { defaultOf, normalizeSetting } from "./values";

const context: SettingsContext = { gpuPerformanceClass: "VeryLow" };

function definitionAt(path: string): SettingDefinition {
  const definition = findDefinition(path);
  if (!definition) throw new Error(`No definition for ${path}`);
  return definition;
}

const TOOL_KEYS = [
  "activeTool",
  "antialiasing",
  "blendMode",
  "floodMode",
  "gammaMode",
  "inputSmoothing",
  "sampleMode",
  "sampleAllLayers",
  "colorPicker.clickBehavior",
  "move.resampling",
  "primaryColor",
  "secondaryColor",
  "recolor.samplingMode",
  "tolerance",
  "toleranceAlphaMode",
  "brush.type",
  "brush.pressure",
  "brush.fillType",
  "brush.hatchStyle",
  "brush.hardness",
  "brush.size",
  "brush.spacing",
  "text.alignment",
  "text.fontFamily",
  "text.fontSize",
  "text.fontSizeMetric",
  "text.fontStyle",
  "text.renderingMode",
  "gradient.type",
  "gradient.repeatType",
  "gradient.alphaOnly",
  "pen.dashStyle",
  "pen.startCap",
  "pen.endCap",
  "selection.combineMode",
  "selection.drawMode",
  "selection.drawWidth",
  "selection.drawHeight",
  "selection.drawUnits",
  "selection.renderingQuality",
  "shapes.curveType",
  "shapes.drawType",
  "shapes.lineCurveShape",
  "shapes.shape",
  "shapes.radius",
];

const FIXED_KEYS = [
  "app.lastRunVersion",
  "app.firstRunCompleted",
  "canvas.checkerboardBrightness",
  "canvas.customBorderColor",
  "canvas.customBorderColorEnabled",
  "canvas.dropShadow",
  "effects.defaultQualityCpu",
  "effects.defaultQualityGpu",
  "file.recent",
  "file.recentCount",
  "file.lastPickerLocation",
  "fileTypes.bmpColorProfiles",
  "graphics.backend",
  "graphics.errorFlags",
  "penAndTablet.pressureInput",
  "penAndTablet.penDetected",
  "performance.workerPolicy",
  "layout.panels.tools.visible",
  "layout.panels.tools.collapsed",
  "layout.panels.colors.visible",
  "layout.panels.colors.collapsed",
  "layout.panels.colors.expanded",
  "layout.panels.layers.visible",
  "layout.panels.layers.collapsed",
  "layout.panels.history.visible",
  "layout.panels.history.collapsed",
  "layout.rightSidebar.width",
  "layout.rightSidebar.splitRatios",
  "workspace.autoScrollSpeed",
  "workspace.currentPalette",
  "workspace.lastCanvasSizeAnchor",
  "workspace.lastCanvasSizeFill",
  "workspace.maintainAspectRatio.resize",
  "workspace.maintainAspectRatio.canvasSize",
  "workspace.maintainAspectRatio.newImage",
  "workspace.lastResampling",
  "workspace.lastResizeGammaMode",
  "workspace.lastNonPixelUnits",
  "workspace.measurementUnit",
  "workspace.showPixelGrid",
  "workspace.showRulers",
  "ui.theme",
  "ui.animations",
  "ui.antialiasedSelectionOutline",
  "ui.autoScrollWhileDrawing",
  "ui.autoSelectNearestVisibleLayer",
  "ui.overscroll",
];

const FAMILY_KEYS = [
  "effects.lastValues.gaussian-blur",
  "adjustments.lastValues.levels",
  "file.saveConfig.png",
  "window.dialogs.save.bounds",
];

describe("settings key table (SET-STO-03)", () => {
  it.each(FIXED_KEYS)("defines %s", (key) => {
    expect(findDefinition(key)?.key).toBe(key);
  });

  it.each(["tools", "toolDefaults"].flatMap((tree) => TOOL_KEYS.map((key) => `${tree}.${key}`)))(
    "defines %s in both tool trees",
    (key) => {
      expect(findDefinition(key)).toBeDefined();
    },
  );

  it.each(FAMILY_KEYS)("matches the family path %s", (key) => {
    expect(findDefinition(key)).toBeDefined();
  });

  it.each([
    "ui.language",
    "graphics.wideGamutOutput",
    "keyboard.bindings",
    "plugins.enabled",
    "effects.lastValues",
    "window.dialogs.bounds",
    "unknown.setting",
  ])("does not define %s", (key) => {
    expect(findDefinition(key)).toBeUndefined();
  });

  it("has one definition per path", () => {
    const keys = SETTING_DEFINITIONS.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(SETTING_DEFINITIONS.map((definition) => [definition.key, definition] as const))(
    "%s has a default that passes its own validation",
    (_, definition) => {
      const value = defaultOf(definition, context);
      if (value === undefined) return;
      expect(normalizeSetting(definition, value)).toEqual(value);
    },
  );

  it("uses the SET-STO-03 defaults", () => {
    const defaultAt = (path: string) => defaultOf(definitionAt(path), context);
    expect(defaultAt("canvas.checkerboardBrightness")).toBe(0.75);
    expect(defaultAt("canvas.customBorderColor")).toEqual({ r: 128, g: 128, b: 128, a: 255 });
    expect(defaultAt("tools.brush.size")).toBe(2);
    expect(defaultAt("toolDefaults.brush.hatchStyle")).toBe("BackwardDiagonal");
    expect(defaultAt("toolDefaults.move.resampling")).toBe("HighQualityCubic");
    expect(defaultAt("workspace.measurementUnit")).toBe("Pixel");
    expect(defaultAt("workspace.lastCanvasSizeAnchor")).toBe("TopLeft");
    expect(defaultAt("layout.rightSidebar.width")).toBe(280);
    expect(defaultAt("file.recentCount")).toBe(10);
    expect(defaultAt("graphics.backend")).toBe("Automatic");
    expect(defaultAt("ui.theme")).toBe("Automatic");
  });

  it("makes the GPU quality default depend on the performance class", () => {
    const definition = definitionAt("effects.defaultQualityGpu");
    expect(defaultOf(definition, { gpuPerformanceClass: "Good" })).toBe(2);
    expect(defaultOf(definition, { gpuPerformanceClass: "Low" })).toBe(1);
    expect(defaultOf(definition, { gpuPerformanceClass: "VeryLow" })).toBe(1);
  });

  it("mirrors only the theme to localStorage", () => {
    const mirrored = SETTING_DEFINITIONS.filter((definition) => definition.mirrored).map(
      (definition) => definition.key,
    );
    expect(mirrored).toEqual(["ui.theme"]);
  });
});
