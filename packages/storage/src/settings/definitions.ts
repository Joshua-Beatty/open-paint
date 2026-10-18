import { HATCH_PATTERNS, LayerBlendMode, RESAMPLE_FILTERS } from "@openpaint/document";

/**
 * The settings key table (SET-STO-02, SET-STO-03). Each entry has a path, a value type, a default,
 * and a range or choice list where the spec gives one. [LATER] keys are not part of v1.
 */

export type GpuPerformanceClass = "VeryLow" | "Low" | "Good";

/** Facts that some defaults depend on (SET-DLG-07, SET-STO-03). */
export interface SettingsContext {
  readonly gpuPerformanceClass: GpuPerformanceClass;
  /** True when the browser asks for reduced motion (WEB-UI-04). Animations default to off then. */
  readonly reducedMotion?: boolean;
}

export type SettingType =
  | "boolean"
  | "integer"
  | "float"
  | "string"
  | "enum"
  | "color"
  | "rectangle"
  | "point"
  | "floatArray"
  | "list"
  | "object"
  | "handle";

/** sRGB 8-bit straight-alpha colour (SET-STO-02). */
export interface SettingColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface SettingRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SettingPoint {
  readonly x: number;
  readonly y: number;
}

/** A JSON object for structured values such as brushes, shapes and save configurations. */
export type SettingJsonObject = { readonly [key: string]: unknown };

/**
 * A stored value. Enums are stored by name. Handles (file and directory handles) are stored as
 * the object the browser gives, which IndexedDB keeps through structured clone.
 */
export type SettingValue =
  | boolean
  | number
  | string
  | SettingColor
  | SettingRectangle
  | SettingPoint
  | readonly number[]
  | readonly unknown[]
  | SettingJsonObject
  | object;

export interface SettingDefinition {
  /** The full path, or a template such as `effects.lastValues.<id>` for families. */
  readonly key: string;
  readonly type: SettingType;
  /** The default. Undefined means the setting is absent until it is written. */
  readonly defaultValue?: SettingValue | undefined;
  /** A default that depends on the context, used instead of `defaultValue`. */
  readonly defaultFor?: ((context: SettingsContext) => SettingValue) | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly choices?: readonly string[] | undefined;
  /** Allowed array lengths for `floatArray`. */
  readonly lengths?: readonly number[] | undefined;
  readonly maxItems?: number | undefined;
  /** Matches the paths of a family setting. */
  readonly pattern?: RegExp | undefined;
  /** Also mirrored to localStorage so it can be read before IndexedDB opens (SET-STO-01). */
  readonly mirrored?: boolean | undefined;
}

const flag = (key: string, defaultValue: boolean): SettingDefinition => ({
  key,
  type: "boolean",
  defaultValue,
});

const whole = (
  key: string,
  defaultValue: number,
  min?: number,
  max?: number,
): SettingDefinition => ({
  key,
  type: "integer",
  defaultValue,
  min,
  max,
});

const real = (
  key: string,
  defaultValue: number,
  min?: number,
  max?: number,
): SettingDefinition => ({
  key,
  type: "float",
  defaultValue,
  min,
  max,
});

const text = (key: string, defaultValue: string): SettingDefinition => ({
  key,
  type: "string",
  defaultValue,
});

const choice = <T extends string>(
  key: string,
  choices: readonly T[],
  defaultValue: T,
): SettingDefinition => ({ key, type: "enum", choices, defaultValue });

const colour = (key: string, defaultValue: SettingColor): SettingDefinition => ({
  key,
  type: "color",
  defaultValue,
});

const json = (key: string, defaultValue?: SettingJsonObject): SettingDefinition => ({
  key,
  type: "object",
  defaultValue,
});

const UNITS = ["Pixel", "Inch", "Centimeter"] as const;
const BLEND_MODE_NAMES = Object.keys(LayerBlendMode) as Array<keyof typeof LayerBlendMode>;
const ANCHORS = [
  "TopLeft",
  "Top",
  "TopRight",
  "Left",
  "Middle",
  "Right",
  "BottomLeft",
  "Bottom",
  "BottomRight",
] as const;
const BLACK_COLOUR: SettingColor = { r: 0, g: 0, b: 0, a: 255 };
const WHITE_COLOUR: SettingColor = { r: 255, g: 255, b: 255, a: 255 };
const BORDER_GRAY: SettingColor = { r: 128, g: 128, b: 128, a: 255 };

/** Tool settings with paths relative to the tree. Each row exists under `tools` and `toolDefaults`. */
const TOOL_ROWS: readonly SettingDefinition[] = [
  text("activeTool", "paintbrush"),
  flag("antialiasing", true),
  choice("blendMode", [...BLEND_MODE_NAMES, "overwrite"], "normal"),
  choice("floodMode", ["Local", "Global"], "Local"),
  choice("gammaMode", ["Linear", "Companded"], "Linear"),
  choice("inputSmoothing", ["Disabled", "Enabled"], "Enabled"),
  choice(
    "sampleMode",
    ["PointSample", "Average3x3", "Average5x5", "Average11x11", "Average31x31", "Average51x51"],
    "PointSample",
  ),
  flag("sampleAllLayers", false),
  choice(
    "colorPicker.clickBehavior",
    ["NoToolSwitch", "SwitchToLastTool", "SwitchToPencilTool"],
    "NoToolSwitch",
  ),
  choice(
    "move.resampling",
    ["NearestNeighbor", "Linear", "MultisampleLinear", "Anisotropic", "HighQualityCubic"],
    "HighQualityCubic",
  ),
  colour("primaryColor", BLACK_COLOUR),
  colour("secondaryColor", WHITE_COLOUR),
  choice("recolor.samplingMode", ["Once", "SecondaryColor"], "Once"),
  real("tolerance", 0.5, 0, 1),
  choice("toleranceAlphaMode", ["Premultiplied", "Straight"], "Premultiplied"),
  choice("brush.type", ["Circle", "Square"], "Circle"),
  flag("brush.pressure", true),
  choice("brush.fillType", ["Solid", "Hatch", "None"], "Solid"),
  choice("brush.hatchStyle", HATCH_PATTERNS.ids(), "BackwardDiagonal"),
  real("brush.hardness", 0.75, 0, 1),
  real("brush.size", 2, 1, 2000),
  real("brush.spacing", 0.15, 0.01, 5),
  choice("text.alignment", ["Left", "Center", "Right"], "Left"),
  text("text.fontFamily", "Noto Sans"),
  real("text.fontSize", 12, 1, 2000),
  choice("text.fontSizeMetric", ["Points", "Fixed96Dpi"], "Points"),
  text("text.fontStyle", "Regular"),
  choice("text.renderingMode", ["Smooth", "Sharp", "Classic"], "Smooth"),
  choice(
    "gradient.type",
    [
      "LinearClamped",
      "LinearReflected",
      "LinearDiamond",
      "Radial",
      "Conical",
      "Spiral",
      "SpiralCounterClockwise",
    ],
    "LinearClamped",
  ),
  choice("gradient.repeatType", ["NoRepeat", "RepeatWrapped", "RepeatReflected"], "NoRepeat"),
  flag("gradient.alphaOnly", false),
  choice("pen.dashStyle", ["Solid", "Dashes", "Dotted", "DashDot", "DashDotDot"], "Solid"),
  choice("pen.startCap", ["Flat", "Arrow", "ArrowFilled", "Rounded"], "Flat"),
  choice("pen.endCap", ["Flat", "Arrow", "ArrowFilled", "Rounded"], "Flat"),
  choice("selection.combineMode", ["Replace", "Union", "Exclude", "Intersect", "Xor"], "Replace"),
  choice("selection.drawMode", ["Normal", "FixedRatio", "FixedSize"], "Normal"),
  real("selection.drawWidth", 400, 1, 100000),
  real("selection.drawHeight", 300, 1, 100000),
  choice("selection.drawUnits", UNITS, "Pixel"),
  choice(
    "selection.renderingQuality",
    ["Aliased", "HighQualityAntialiased"],
    "HighQualityAntialiased",
  ),
  choice("shapes.curveType", ["Straight", "Spline", "Bezier"], "Spline"),
  choice("shapes.drawType", ["Outline", "Interior", "Both"], "Outline"),
  json("shapes.lineCurveShape", { name: "Line" }),
  json("shapes.shape", { name: "rectangle" }),
  real("shapes.radius", 10, 0, 2000),
];

/** Settings keyed by a fixed path. */
const FIXED_DEFINITIONS: readonly SettingDefinition[] = [
  text("app.lastRunVersion", ""),
  flag("app.firstRunCompleted", false),
  flag("app.sessionRecovery", false),

  real("canvas.checkerboardBrightness", 0.75, 0.25, 1),
  colour("canvas.customBorderColor", BORDER_GRAY),
  flag("canvas.customBorderColorEnabled", false),
  flag("canvas.dropShadow", true),

  whole("effects.defaultQualityCpu", 2, 1, 5),
  {
    key: "effects.defaultQualityGpu",
    type: "integer",
    defaultFor: ({ gpuPerformanceClass }) => (gpuPerformanceClass === "Good" ? 2 : 1),
    min: 1,
    max: 8,
  },

  { key: "file.recent", type: "list", defaultValue: [], maxItems: 10 },
  whole("file.recentCount", 10, 0, 10),
  { key: "file.lastPickerLocation", type: "handle" },

  flag("fileTypes.bmpColorProfiles", false),

  choice("graphics.backend", ["Automatic", "WebGPU", "Cpu"], "Automatic"),
  whole("graphics.errorFlags", 0, 0, 3),

  flag("penAndTablet.pressureInput", true),
  flag("penAndTablet.penDetected", false),
  choice("penAndTablet.touchInput", ["Automatic", "Draw", "Navigate"], "Automatic"),

  choice(
    "performance.workerPolicy",
    ["ThreeQuarters", "AllButOne", "All", "Single"],
    "ThreeQuarters",
  ),

  ...(["tools", "colors", "layers", "history"] as const).flatMap((panel) => [
    flag(`layout.panels.${panel}.visible`, true),
    flag(`layout.panels.${panel}.collapsed`, false),
  ]),
  flag("layout.panels.colors.expanded", false),
  whole("layout.rightSidebar.width", 280, 220, 480),
  {
    key: "layout.rightSidebar.splitRatios",
    type: "floatArray",
    defaultValue: [],
    lengths: [0, 3],
    min: 0,
    max: 1,
  },

  whole("workspace.autoScrollSpeed", 2000, 20, 200000),
  text("workspace.currentPalette", ""),
  choice("workspace.lastCanvasSizeAnchor", ANCHORS, "TopLeft"),
  choice(
    "workspace.lastCanvasSizeFill",
    ["Transparent", "PrimaryColor", "SecondaryColor", "White", "Black"],
    "Transparent",
  ),
  flag("workspace.maintainAspectRatio.resize", true),
  flag("workspace.maintainAspectRatio.canvasSize", false),
  flag("workspace.maintainAspectRatio.newImage", false),
  choice("workspace.lastResampling", RESAMPLE_FILTERS, "bicubic"),
  choice("workspace.lastResizeGammaMode", ["Linear", "Companded"], "Linear"),
  choice("workspace.lastNonPixelUnits", UNITS, "Inch"),
  choice("workspace.measurementUnit", UNITS, "Pixel"),
  flag("workspace.showPixelGrid", false),
  flag("workspace.showRulers", false),

  { ...choice("ui.theme", ["Automatic", "Light", "Dark"], "Automatic"), mirrored: true },
  {
    key: "ui.animations",
    type: "boolean",
    defaultValue: true,
    defaultFor: ({ reducedMotion }) => reducedMotion !== true,
  },
  flag("ui.antialiasedSelectionOutline", true),
  flag("ui.autoScrollWhileDrawing", true),
  flag("ui.autoSelectNearestVisibleLayer", false),
  flag("ui.overscroll", true),
];

/** Settings with a dynamic path: one entry per effect, adjustment, format or dialog. */
const FAMILY_DEFINITIONS: readonly SettingDefinition[] = [
  { key: "effects.lastValues.<effectId>", type: "object", pattern: /^effects\.lastValues\.(.+)$/ },
  {
    key: "adjustments.lastValues.<adjustmentId>",
    type: "object",
    pattern: /^adjustments\.lastValues\.(.+)$/,
  },
  { key: "file.saveConfig.<format>", type: "object", pattern: /^file\.saveConfig\.(.+)$/ },
  {
    key: "window.dialogs.<name>.bounds",
    type: "rectangle",
    pattern: /^window\.dialogs\.([^.]+)\.bounds$/,
  },
];

const TOOL_TREES = ["tools", "toolDefaults"] as const;

const FIXED_BY_KEY: ReadonlyMap<string, SettingDefinition> = new Map(
  [
    ...FIXED_DEFINITIONS,
    ...TOOL_TREES.flatMap((tree) =>
      TOOL_ROWS.map((row): SettingDefinition => ({ ...row, key: `${tree}.${row.key}` })),
    ),
  ].map((definition) => [definition.key, definition]),
);

/** Every v1 setting definition, fixed paths first. */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  ...FIXED_BY_KEY.values(),
  ...FAMILY_DEFINITIONS,
];

/** The definition for a path, or undefined when no v1 setting has that path. */
export function findDefinition(path: string): SettingDefinition | undefined {
  return FIXED_BY_KEY.get(path) ?? FAMILY_DEFINITIONS.find((family) => family.pattern?.test(path));
}
