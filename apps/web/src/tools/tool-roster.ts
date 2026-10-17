/** One built-in tool: its hotkey, its flags and the options its options bar shows (TL-ROSTER-01). */
export interface ToolEntry {
  readonly id: string;
  readonly hotkey: string;
  readonly skipIfActive: boolean;
  readonly commitCapable: boolean;
  /** The option settings, by name under `tools.`, in options bar order. */
  readonly options: readonly string[];
}

const BRUSH_TIP = ["brush.type", "brush.size", "brush.pressure", "brush.hardness", "brush.spacing"];
const FLOOD = ["floodMode", "tolerance", "toleranceAlphaMode", "sampleAllLayers"];

/**
 * The Tools panel in roster order (TL-ROSTER-01). This is the single source of the tool order: the
 * Tools panel, the hotkeys, the options bar and the Settings › Tools default-tool chooser follow it.
 */
export const TOOL_ROSTER: readonly ToolEntry[] = [
  {
    id: "rectangleSelect",
    hotkey: "S",
    skipIfActive: false,
    commitCapable: false,
    options: [
      "selection.combineMode",
      "selection.drawMode",
      "selection.drawWidth",
      "selection.drawHeight",
      "selection.drawUnits",
    ],
  },
  {
    id: "moveSelectedPixels",
    hotkey: "M",
    skipIfActive: false,
    commitCapable: true,
    options: ["move.resampling", "gammaMode"],
  },
  {
    id: "lassoSelect",
    hotkey: "S",
    skipIfActive: false,
    commitCapable: false,
    options: ["selection.combineMode"],
  },
  { id: "moveSelection", hotkey: "M", skipIfActive: false, commitCapable: true, options: [] },
  {
    id: "ellipseSelect",
    hotkey: "S",
    skipIfActive: false,
    commitCapable: false,
    options: ["selection.combineMode"],
  },
  { id: "zoom", hotkey: "Z", skipIfActive: false, commitCapable: false, options: [] },
  {
    id: "magicWand",
    hotkey: "S",
    skipIfActive: false,
    commitCapable: true,
    options: ["selection.combineMode", ...FLOOD],
  },
  { id: "pan", hotkey: "H", skipIfActive: false, commitCapable: false, options: [] },
  {
    id: "paintBucket",
    hotkey: "F",
    skipIfActive: false,
    commitCapable: true,
    options: [
      "brush.fillType",
      ...FLOOD,
      "antialiasing",
      "blendMode",
      "selection.renderingQuality",
    ],
  },
  {
    id: "gradient",
    hotkey: "G",
    skipIfActive: false,
    commitCapable: true,
    options: [
      "gradient.type",
      "gradient.alphaOnly",
      "gradient.repeatType",
      "antialiasing",
      "blendMode",
    ],
  },
  {
    id: "paintbrush",
    hotkey: "B",
    skipIfActive: true,
    commitCapable: false,
    options: [
      ...BRUSH_TIP,
      "brush.fillType",
      "inputSmoothing",
      "antialiasing",
      "blendMode",
      "selection.renderingQuality",
    ],
  },
  {
    id: "eraser",
    hotkey: "E",
    skipIfActive: true,
    commitCapable: false,
    options: [...BRUSH_TIP, "inputSmoothing", "antialiasing", "selection.renderingQuality"],
  },
  { id: "pencil", hotkey: "P", skipIfActive: true, commitCapable: false, options: ["blendMode"] },
  {
    id: "colorPicker",
    hotkey: "K",
    skipIfActive: true,
    commitCapable: false,
    options: ["sampleMode", "sampleAllLayers", "colorPicker.clickBehavior"],
  },
  {
    id: "cloneStamp",
    hotkey: "L",
    skipIfActive: false,
    commitCapable: false,
    options: [
      ...BRUSH_TIP,
      "inputSmoothing",
      "antialiasing",
      "blendMode",
      "selection.renderingQuality",
    ],
  },
  {
    id: "recolor",
    hotkey: "R",
    skipIfActive: true,
    commitCapable: false,
    options: [
      ...BRUSH_TIP,
      "inputSmoothing",
      "antialiasing",
      "selection.renderingQuality",
      "tolerance",
      "toleranceAlphaMode",
      "recolor.samplingMode",
    ],
  },
  {
    id: "text",
    hotkey: "T",
    skipIfActive: false,
    commitCapable: true,
    options: [
      "text.fontFamily",
      "text.fontSize",
      "text.fontSizeMetric",
      "text.alignment",
      "text.renderingMode",
      "antialiasing",
      "blendMode",
    ],
  },
  {
    id: "lineCurve",
    hotkey: "O",
    skipIfActive: false,
    commitCapable: true,
    options: [
      "brush.size",
      "brush.fillType",
      "antialiasing",
      "blendMode",
      "selection.renderingQuality",
      "shapes.curveType",
      "pen.dashStyle",
      "pen.startCap",
      "pen.endCap",
    ],
  },
  {
    id: "shapes",
    hotkey: "O",
    skipIfActive: false,
    commitCapable: true,
    options: [
      "shapes.drawType",
      "brush.size",
      "brush.fillType",
      "antialiasing",
      "blendMode",
      "pen.dashStyle",
      "selection.renderingQuality",
    ],
  },
];
