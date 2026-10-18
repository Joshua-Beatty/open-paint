import { HATCH_PATTERNS } from "@openpaint/document";
import type { MessageId } from "@openpaint/i18n";
import type { ChoiceOption, ControlOptions } from "@openpaint/properties";
import { TOOL_ROSTER } from "../tools/tool-roster";
import { type FieldSpec, type FormBlock, keyOfPath, settingsOptionLabel } from "./settings-schema";
import { BRUSH_SIZE_PRESETS, CORNER_SIZE_PRESETS } from "./size-presets";

/**
 * The Settings sections in v1, in their SET-DLG-02 order. Deferred sections are not listed. The
 * open-source licenses page follows them at the owner's request (beyond SET-DLG-02).
 */
export const SETTINGS_SECTIONS = [
  "ui",
  "canvas",
  "tools",
  "pen",
  "graphics",
  "diagnostics",
  "licenses",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SECTION_LABELS: Readonly<Record<SettingsSection, MessageId>> = {
  ui: "settings.section.ui",
  canvas: "settings.section.canvas",
  tools: "settings.section.tools",
  pen: "settings.section.pen",
  graphics: "settings.section.graphics",
  diagnostics: "settings.section.diagnostics",
  licenses: "settings.section.licenses",
};

/**
 * The tool roster in TL-ROSTER-01 order, taken from the tool roster so the default-tool chooser
 * follows the registry (TL-FRAME-07). Each id names its catalog label `settings.tool.<id>`.
 */
export const TOOL_IDS: readonly string[] = TOOL_ROSTER.map((entry) => entry.id);

const TOOL_OPTIONS: readonly ChoiceOption[] = TOOL_IDS.map((id) => ({
  value: id,
  label: `settings.tool.${id}` as MessageId,
}));

type FieldExtras = {
  readonly control?: ControlOptions;
  readonly options?: readonly ChoiceOption[];
  readonly blendLabels?: boolean;
};

function field(path: string, label: MessageId, extras: FieldExtras = {}): FieldSpec {
  return {
    key: keyOfPath(path),
    path,
    label,
    ...(extras.control === undefined ? {} : { control: extras.control }),
    ...(extras.options === undefined ? {} : { options: extras.options }),
    ...(extras.blendLabels === undefined ? {} : { blendLabels: extras.blendLabels }),
  };
}

function toolField(name: string, label: MessageId, extras: FieldExtras = {}): FieldSpec {
  return field(`toolDefaults.${name}`, label, extras);
}

/**
 * SET-DLG-03: the User Interface page controls, in spec order. The selection outline quality
 * follows Animations, as UI-ANIM-01 lists it (DOC-SEL-04).
 */
export const UI_BLOCK: FormBlock = {
  fields: [
    field("ui.animations", "settings.field.animations"),
    field("ui.antialiasedSelectionOutline", "settings.field.antialiasedSelectionOutline", {
      control: { footnote: "settings.note.antialiasedSelectionOutline" },
    }),
    field("ui.overscroll", "settings.field.overscroll"),
    field("ui.autoScrollWhileDrawing", "settings.field.autoScroll"),
    field("ui.autoSelectNearestVisibleLayer", "settings.field.autoSelectNearest"),
    field("ui.theme", "settings.field.theme"),
    field("app.sessionRecovery", "settings.field.sessionRecovery", {
      control: { footnote: "settings.note.sessionRecovery" },
    }),
  ],
};

/** The Canvas page (SET-DLG-04). The border colour is read-only until its checkbox is ticked. */
export const CANVAS_BLOCK: FormBlock = {
  fields: [
    field("canvas.dropShadow", "settings.field.dropShadow"),
    field("canvas.checkerboardBrightness", "settings.field.checkerboard", {
      control: {
        decimalPlaces: 2,
        sliderSmallChange: 0.05,
        sliderLargeChange: 0.25,
        upDownIncrement: 0.01,
        showHeaderLine: false,
        controlColors: ["#000000", "#ffffff"],
      },
    }),
    field("canvas.customBorderColorEnabled", "settings.field.borderEnabled"),
    field("canvas.customBorderColor", "settings.field.borderColor"),
  ],
  rules: [
    {
      kind: "readOnlyWhenBoolean",
      target: keyOfPath("canvas.customBorderColor"),
      source: keyOfPath("canvas.customBorderColorEnabled"),
      inverted: true,
    },
  ],
};

/** The default-tool chooser of the Tools page (SET-DLG-05, TL-ROSTER-02). */
export const DEFAULT_TOOL_BLOCK: FormBlock = {
  fields: [
    toolField("activeTool", "settings.field.defaultTool", {
      control: { controlType: "radioButtons" },
      options: TOOL_OPTIONS,
    }),
  ],
};

export interface ToolRow {
  /** The row's heading key. Named apart from `title` so the display-text scan leaves it alone. */
  readonly caption: MessageId;
  readonly block: FormBlock;
}

/**
 * A fraction shown as a whole percentage that steps by 1 %, and by 5 % with Ctrl or Page Up and
 * Down (TL-OPT-BRUSH Hardness and Spacing, TL-OPT-FLOOD Tolerance).
 */
const PERCENT_STEPS: ControlOptions = {
  percent: true,
  decimalPlaces: 0,
  sliderSmallChange: 0.01,
  sliderLargeChange: 0.05,
  upDownIncrement: 0.01,
};

/**
 * The Fill drop-down (TL-OPT-FILL): Solid, then every hatch pattern of the pattern registry. It
 * shows the fill type and the hatch style as one control: Solid stores the Solid fill type, and a
 * pattern stores the Hatch fill type with that style. The hatch style is written first, so a
 * change that moves from Solid to a hatch changes the drawing once.
 */
export const FILL_FIELD: FieldSpec = {
  ...toolField("brush.fillType", "settings.field.tool.fillType"),
  options: ["Solid", ...HATCH_PATTERNS.ids()].map((value) => ({
    value,
    label: settingsOptionLabel(value),
  })),
  binding: {
    names: ["brush.hatchStyle", "brush.fillType"],
    read: ([hatchStyle, fillType]) =>
      fillType === "Hatch" && typeof hatchStyle === "string" ? hatchStyle : "Solid",
    write: (value) => (value === "Solid" ? [undefined, "Solid"] : [value, "Hatch"]),
  },
};

/** The ten embedded tool-option rows of the Tools page, in SET-DLG-05 order. */
export const TOOL_ROWS: readonly ToolRow[] = [
  {
    caption: "settings.row.options",
    block: {
      fields: [
        toolField("antialiasing", "settings.field.tool.antialiasing"),
        toolField("blendMode", "settings.field.tool.blendMode", { blendLabels: true }),
        toolField("gammaMode", "settings.field.tool.gammaMode"),
        toolField("inputSmoothing", "settings.field.tool.inputSmoothing"),
        toolField("selection.renderingQuality", "settings.field.tool.selectionQuality"),
      ],
    },
  },
  {
    caption: "settings.row.brush",
    block: {
      fields: [
        FILL_FIELD,
        toolField("brush.hardness", "settings.field.tool.hardness", {
          control: PERCENT_STEPS,
        }),
        toolField("brush.pressure", "settings.field.tool.pressure"),
        toolField("brush.size", "settings.field.tool.size", {
          control: { presets: BRUSH_SIZE_PRESETS },
        }),
        toolField("brush.spacing", "settings.field.tool.spacing", {
          // 1 % to 500 %: the bent scale gives the usual low spacings most of the track.
          control: { ...PERCENT_STEPS, useExponentialScale: true, exponentialScale: 2 },
        }),
      ],
    },
  },
  {
    caption: "settings.row.colorPicker",
    block: {
      fields: [toolField("colorPicker.clickBehavior", "settings.field.tool.clickBehavior")],
    },
  },
  {
    caption: "settings.row.wand",
    block: {
      fields: [
        toolField("floodMode", "settings.field.tool.floodMode"),
        toolField("recolor.samplingMode", "settings.field.tool.recolorSampling"),
        toolField("tolerance", "settings.field.tool.tolerance", {
          control: PERCENT_STEPS,
        }),
        toolField("toleranceAlphaMode", "settings.field.tool.toleranceAlpha"),
      ],
    },
  },
  {
    caption: "settings.row.gradient",
    block: {
      fields: [
        toolField("gradient.type", "settings.field.tool.gradientType"),
        toolField("gradient.repeatType", "settings.field.tool.repeatType"),
        toolField("gradient.alphaOnly", "settings.field.tool.alphaOnly"),
      ],
    },
  },
  {
    caption: "settings.row.shape",
    block: {
      fields: [
        toolField("pen.dashStyle", "settings.field.tool.dashStyle"),
        toolField("pen.startCap", "settings.field.tool.startCap"),
        toolField("pen.endCap", "settings.field.tool.endCap"),
        toolField("shapes.curveType", "settings.field.tool.curveType"),
        toolField("shapes.drawType", "settings.field.tool.drawType"),
        toolField("shapes.radius", "settings.field.tool.radius", {
          control: { presets: CORNER_SIZE_PRESETS },
        }),
      ],
    },
  },
  {
    caption: "settings.row.sampling",
    block: {
      fields: [
        toolField("sampleMode", "settings.field.tool.sampleMode"),
        toolField("sampleAllLayers", "settings.field.tool.sampleAllLayers"),
      ],
    },
  },
  {
    caption: "settings.row.move",
    block: {
      fields: [toolField("move.resampling", "settings.field.tool.resampling")],
    },
  },
  {
    caption: "settings.row.selection",
    block: {
      fields: [
        toolField("selection.combineMode", "settings.field.tool.combineMode"),
        toolField("selection.drawMode", "settings.field.tool.drawMode"),
      ],
    },
  },
  {
    caption: "settings.row.text",
    block: {
      fields: [
        toolField("text.alignment", "settings.field.tool.alignment"),
        toolField("text.renderingMode", "settings.field.tool.renderingMode"),
        toolField("text.fontSizeMetric", "settings.field.tool.sizeMetric"),
        toolField("text.fontSize", "settings.field.tool.fontSize", {
          control: { decimalPlaces: 1, openEnded: true },
        }),
        toolField("text.fontFamily", "settings.field.tool.fontFamily"),
      ],
    },
  },
];

/**
 * The options the tools' options bars show that the Tools page does not list (its test defers them
 * to the tools, M4): the brush type and the Rectangle Select draw size.
 */
const TOOLBAR_ONLY_FIELDS: readonly FieldSpec[] = [
  toolField("brush.type", "settings.field.tool.brushType"),
  toolField("selection.drawWidth", "settings.field.tool.drawWidth", {
    control: { decimalPlaces: 0, openEnded: true },
  }),
  toolField("selection.drawHeight", "settings.field.tool.drawHeight", {
    control: { decimalPlaces: 0, openEnded: true },
  }),
  toolField("selection.drawUnits", "settings.field.tool.drawUnits"),
];

/** Every tool option field, keyed by its setting name without the tree, such as `brush.size`. */
export const TOOL_OPTION_FIELDS: ReadonlyMap<string, FieldSpec> = new Map(
  [...TOOL_ROWS.flatMap((row) => row.block.fields), ...TOOLBAR_ONLY_FIELDS].map((field) => [
    field.path.slice("toolDefaults.".length),
    field,
  ]),
);

/** The Pen & Tablet page (SET-DLG-06). */
export const PEN_BLOCK: FormBlock = {
  fields: [
    field("penAndTablet.pressureInput", "settings.field.pressureInput", {
      control: { footnote: "settings.note.pressureInput" },
    }),
    field("penAndTablet.touchInput", "settings.field.touchInput", {
      control: { footnote: "settings.note.touchInput" },
    }),
  ],
};

/**
 * The Rendering backend choices (SET-DLG-07a). WebGPU is listed but disabled without an adapter.
 * `resolved` is the backend Automatic picked, shown in its label ("Automatic (WebGPU)").
 */
export function backendBlock(webgpuAvailable: boolean, resolved?: "WebGPU" | "Cpu"): FormBlock {
  const automatic: MessageId =
    resolved === undefined
      ? settingsOptionLabel("Automatic")
      : resolved === "WebGPU"
        ? "settings.option.automaticWebgpu"
        : "settings.option.automaticCpu";
  return {
    fields: [
      field("graphics.backend", "settings.field.backend", {
        control: { footnote: "settings.note.backend" },
        options: [
          { value: "Automatic", label: automatic },
          { value: "WebGPU", label: settingsOptionLabel("WebGPU"), disabled: !webgpuAvailable },
          { value: "Cpu", label: settingsOptionLabel("Cpu") },
        ],
      }),
    ],
  };
}

/** The effect quality defaults (SET-DLG-11) on the Graphics page. */
export const QUALITY_BLOCK: FormBlock = {
  fields: [
    field("effects.defaultQualityCpu", "settings.field.qualityCpu", {
      control: { footnote: "settings.note.quality" },
    }),
    field("effects.defaultQualityGpu", "settings.field.qualityGpu"),
  ],
};
