import { EXTENSION_API_MAJOR, type ToolDescriptor, ToolRegistry } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import type { BooleanChoices, ChoiceOption, ControlOptions } from "@openpaint/properties";
import type { SettingsContext } from "@openpaint/storage";
import { TOOL_OPTION_FIELDS } from "../settings/settings-pages";
import {
  blockSchema,
  type FieldSpec,
  type FormBlock,
  keyOfPath,
  settingsOptionLabel,
} from "../settings/settings-schema";
import { BOOLEAN_ICONS, FIELD_ICONS, OPTION_ICONS } from "./option-icons";
import { TOOL_ROSTER } from "./tool-roster";

export { TOOL_ROSTER, type ToolEntry } from "./tool-roster";

/** The Move Selected Pixels "Sampling" choices, under their TL-OPT-RESAMP names. */
const RESAMPLING_CHOICES: readonly ChoiceOption[] = [
  { value: "NearestNeighbor", label: "tool.option.nearestNeighbor" as MessageId },
  { value: "Linear", label: "tool.option.bilinear" as MessageId },
  { value: "MultisampleLinear", label: "tool.option.multisampleBilinear" as MessageId },
  { value: "Anisotropic", label: "tool.option.anisotropic" as MessageId },
  { value: "HighQualityCubic", label: "tool.option.bicubic" as MessageId },
];

/** The Move Selected Pixels "Gamma mode" choices (TL-OPT-GAMMA). */
const GAMMA_CHOICES: readonly ChoiceOption[] = [
  { value: "Linear", label: "tool.option.gammaCorrected" as MessageId },
  { value: "Companded", label: "tool.option.ignoreGamma" as MessageId },
];

/** The Shapes tool's draw and fill modes, under their TL-SHAPE-01 names. */
const DRAW_TYPE_CHOICES: readonly ChoiceOption[] = [
  {
    value: "Outline",
    label: "tool.option.drawOutline" as MessageId,
    shortLabel: "tool.option.drawOutlineShort" as MessageId,
  },
  {
    value: "Interior",
    label: "tool.option.drawFilled" as MessageId,
    shortLabel: "tool.option.drawFilledShort" as MessageId,
  },
  {
    value: "Both",
    label: "tool.option.drawFilledOutline" as MessageId,
    shortLabel: "tool.option.drawFilledOutlineShort" as MessageId,
  },
];

/** The Selection Mode choices (TL-OPT-SELMODE). Each tooltip names the modifier that chooses it. */
const COMBINE_CHOICES: readonly ChoiceOption[] = [
  {
    value: "Replace",
    label: "tool.option.combineReplace" as MessageId,
    tooltip: "tool.option.combineReplaceTip" as MessageId,
  },
  {
    value: "Union",
    label: "tool.option.combineAdd" as MessageId,
    tooltip: "tool.option.combineAddTip" as MessageId,
  },
  {
    value: "Exclude",
    label: "tool.option.combineSubtract" as MessageId,
    tooltip: "tool.option.combineSubtractTip" as MessageId,
  },
  {
    value: "Intersect",
    label: "tool.option.combineIntersect" as MessageId,
    tooltip: "tool.option.combineIntersectTip" as MessageId,
  },
  {
    value: "Xor",
    label: "tool.option.combineInvert" as MessageId,
    tooltip: "tool.option.combineInvertTip" as MessageId,
  },
];

/** The icon of one value of an on/off option. */
function booleanIcon(name: string, value: "on" | "off"): string {
  const icons = BOOLEAN_ICONS[name];
  if (icons === undefined) throw new Error(`No icons for "${name}".`);
  return icons[value];
}

/**
 * The options bar shows its on/off options as two-value drop-downs with an icon per value, like
 * its other drop-downs. The button reads on its own ("Pressure: On", "Antialiased"), and the list
 * offers each value as a full phrase (TL-OPT-AA, TL-OPT-BRUSH, TL-OPT-FLOOD, TL-OPT-GRAD).
 */
const BOOLEAN_CHOICES: Readonly<Record<string, BooleanChoices>> = {
  antialiasing: {
    onFirst: true,
    on: {
      icon: booleanIcon("antialiasing", "on"),
      label: "tool.option.antialiased" as MessageId,
      shortLabel: "tool.option.antialiasedShort" as MessageId,
    },
    off: {
      icon: booleanIcon("antialiasing", "off"),
      label: "tool.option.aliased" as MessageId,
      shortLabel: "tool.option.aliasedShort" as MessageId,
    },
  },
  "brush.pressure": {
    onFirst: true,
    on: {
      icon: booleanIcon("brush.pressure", "on"),
      label: "tool.option.pressureEnable" as MessageId,
      shortLabel: "tool.option.pressureOn" as MessageId,
      tooltip: "tool.option.pressureOnTip" as MessageId,
    },
    off: {
      icon: booleanIcon("brush.pressure", "off"),
      label: "tool.option.pressureDisable" as MessageId,
      shortLabel: "tool.option.pressureOff" as MessageId,
      tooltip: "tool.option.pressureOffTip" as MessageId,
    },
  },
  sampleAllLayers: {
    off: {
      icon: booleanIcon("sampleAllLayers", "off"),
      label: "tool.option.sampleLayer" as MessageId,
      shortLabel: "tool.option.sampleLayerShort" as MessageId,
      tooltip: "tool.option.sampleLayerTip" as MessageId,
    },
    on: {
      icon: booleanIcon("sampleAllLayers", "on"),
      label: "tool.option.sampleImage" as MessageId,
      shortLabel: "tool.option.sampleImageShort" as MessageId,
      tooltip: "tool.option.sampleImageTip" as MessageId,
    },
  },
  "gradient.alphaOnly": {
    off: {
      icon: booleanIcon("gradient.alphaOnly", "off"),
      label: "tool.option.colorMode" as MessageId,
      shortLabel: "tool.option.colorModeShort" as MessageId,
      tooltip: "tool.option.colorModeTip" as MessageId,
    },
    on: {
      icon: booleanIcon("gradient.alphaOnly", "on"),
      label: "tool.option.transparencyMode" as MessageId,
      shortLabel: "tool.option.transparencyModeShort" as MessageId,
      tooltip: "tool.option.transparencyModeTip" as MessageId,
    },
  },
};

/**
 * The short names that drop-downs show before their values, for values that do not say on their
 * own what they choose: "Blend: Normal", not "Normal" (ControlOptions.inlineCaption).
 */
const INLINE_CAPTIONS: Readonly<Record<string, MessageId>> = {
  "brush.fillType": "tool.option.captionFill" as MessageId,
  blendMode: "tool.option.captionBlend" as MessageId,
  "selection.combineMode": "tool.option.captionSelectionMode" as MessageId,
  "move.resampling": "tool.option.sampling" as MessageId,
  floodMode: "tool.option.captionFloodMode" as MessageId,
  sampleMode: "tool.option.captionSample" as MessageId,
  "colorPicker.clickBehavior": "tool.option.captionAfterClick" as MessageId,
  "gradient.type": "tool.option.captionGradient" as MessageId,
  "text.alignment": "tool.option.captionAlign" as MessageId,
  "text.renderingMode": "tool.option.captionRendering" as MessageId,
  "shapes.drawType": "tool.option.captionDraw" as MessageId,
  "shapes.curveType": "tool.option.captionCurve" as MessageId,
  "pen.startCap": "tool.option.captionStartCap" as MessageId,
  "pen.endCap": "tool.option.captionEndCap" as MessageId,
};

/** Controls that a tool's options bar shows differently from the Settings › Tools page. */
const CONTROL_OVERRIDES: Readonly<Record<string, ControlOptions>> = Object.fromEntries(
  [...new Set([...Object.keys(BOOLEAN_CHOICES), ...Object.keys(INLINE_CAPTIONS)])].map((name) => {
    const booleanChoices = BOOLEAN_CHOICES[name];
    const inlineCaption = INLINE_CAPTIONS[name];
    const control: ControlOptions = {
      ...(booleanChoices !== undefined && { booleanChoices }),
      ...(inlineCaption !== undefined && { inlineCaption }),
    };
    return [name, control];
  }),
);

/** Path smoothing as "Smoothing: On" or "Off", listed as full phrases (TL-OPT-SMOOTH). */
const SMOOTHING_CHOICES: readonly ChoiceOption[] = [
  {
    value: "Enabled",
    label: "tool.option.smoothingEnable" as MessageId,
    shortLabel: "tool.option.smoothingOn" as MessageId,
  },
  {
    value: "Disabled",
    label: "tool.option.smoothingDisable" as MessageId,
    shortLabel: "tool.option.smoothingOff" as MessageId,
  },
];

/** The Recolor basis color, "Sample once" or "Match secondary" (TL-BRUSH-RC, TL-OPT-RECOLOR). */
const RECOLOR_SAMPLING_CHOICES: readonly ChoiceOption[] = [
  {
    value: "Once",
    label: "tool.option.recolorOnce" as MessageId,
    shortLabel: "tool.option.recolorOnceShort" as MessageId,
  },
  {
    value: "SecondaryColor",
    label: "tool.option.recolorSecondary" as MessageId,
    shortLabel: "tool.option.recolorSecondaryShort" as MessageId,
  },
];

/** The dash styles, which name themselves; Solid reads "Solid line" on the button (TL-OPT-PEN). */
const DASH_STYLE_CHOICES: readonly ChoiceOption[] = [
  {
    value: "Solid",
    label: "settings.option.solid" as MessageId,
    shortLabel: "tool.option.solidLine" as MessageId,
  },
  ...["Dashes", "Dotted", "DashDot", "DashDotDot"].map((value) => ({
    value,
    label: settingsOptionLabel(value),
  })),
];

/** The brush tip shapes, "Round tip" or "Square tip" on the button (TL-OPT-BRUSH). */
const BRUSH_TYPE_CHOICES: readonly ChoiceOption[] = [
  {
    value: "Circle",
    label: "settings.option.circle" as MessageId,
    shortLabel: "tool.option.roundTip" as MessageId,
  },
  {
    value: "Square",
    label: "settings.option.square" as MessageId,
    shortLabel: "tool.option.squareTip" as MessageId,
  },
];

/** How Tolerance treats transparency (TL-OPT-FLOOD, TL-ALG-TOL), named as alpha modes. */
const TOLERANCE_ALPHA_CHOICES: readonly ChoiceOption[] = [
  {
    value: "Premultiplied",
    label: "tool.option.premultipliedAlpha" as MessageId,
    shortLabel: "settings.option.premultiplied" as MessageId,
  },
  {
    value: "Straight",
    label: "tool.option.straightAlpha" as MessageId,
  },
];

/**
 * The selection quality (TL-OPT-SELQ) under its full names in the list. The button names the
 * selection edge, so it does not read as a second Antialiasing option beside TL-OPT-AA.
 */
const SELECTION_QUALITY_CHOICES: readonly ChoiceOption[] = [
  {
    value: "HighQualityAntialiased",
    label: "tool.option.selectionAntialiased" as MessageId,
    shortLabel: "tool.option.selectionAntialiasedShort" as MessageId,
    tooltip: "tool.option.selectionQualityTip" as MessageId,
  },
  {
    value: "Aliased",
    label: "tool.option.selectionPixelated" as MessageId,
    shortLabel: "tool.option.selectionPixelatedShort" as MessageId,
    tooltip: "tool.option.selectionQualityTip" as MessageId,
  },
];

/** Choice lists that a tool's options bar shows under their own names, not the settings' names. */
const CHOICE_OVERRIDES: Readonly<Record<string, readonly ChoiceOption[]>> = {
  "selection.renderingQuality": SELECTION_QUALITY_CHOICES,
  "move.resampling": RESAMPLING_CHOICES,
  gammaMode: GAMMA_CHOICES,
  "selection.combineMode": COMBINE_CHOICES,
  "shapes.drawType": DRAW_TYPE_CHOICES,
  inputSmoothing: SMOOTHING_CHOICES,
  "recolor.samplingMode": RECOLOR_SAMPLING_CHOICES,
  "brush.type": BRUSH_TYPE_CHOICES,
  toleranceAlphaMode: TOLERANCE_ALPHA_CHOICES,
  "pen.dashStyle": DASH_STYLE_CHOICES,
};

/**
 * The option fields named by their setting names under the `tools.` tree, such as `brush.size`. The
 * label and control of each come from the Tools page field table, so both show the same controls.
 */
export function optionFieldsOf(options: readonly string[]): readonly FieldSpec[] {
  return options.map((name) => {
    const field = TOOL_OPTION_FIELDS.get(name);
    if (field === undefined) throw new Error(`No option field for "${name}".`);
    const path = `tools.${name}`;
    const icon = FIELD_ICONS[name];
    const control: ControlOptions = {
      ...field.control,
      ...(icon !== undefined && { icon }),
      ...CONTROL_OVERRIDES[name],
    };
    const optionIcons = OPTION_ICONS[name];
    const placed: FieldSpec = {
      ...field,
      key: keyOfPath(path),
      path,
      ...(Object.keys(control).length > 0 && { control }),
      ...(optionIcons !== undefined && { optionIcons }),
    };
    const choices = CHOICE_OVERRIDES[name];
    return choices === undefined ? placed : { ...placed, options: choices };
  });
}

/** The option fields of one tool, under the `tools.` tree. */
function optionBlock(options: readonly string[]): FormBlock {
  return { fields: optionFieldsOf(options) };
}

/**
 * Tool option defaults do not depend on the GPU, so the performance class in the context is
 * not used.
 */
const OPTION_CONTEXT: SettingsContext = { gpuPerformanceClass: "VeryLow" };

const BLOCKS: ReadonlyMap<string, FormBlock> = new Map(
  TOOL_ROSTER.map((entry) => [entry.id, optionBlock(entry.options)]),
);

/** The options bar block of a tool, shared by the options strip and the schema. */
export function optionBlockOf(toolId: string): FormBlock {
  const block = BLOCKS.get(toolId);
  if (block === undefined) throw new Error(`Unknown tool "${toolId}".`);
  return block;
}

/** Whether a tool's options bar shows an option setting, for example `brush.size`. */
export function toolShowsOption(toolId: string, name: string): boolean {
  return TOOL_ROSTER.find((entry) => entry.id === toolId)?.options.includes(name) ?? false;
}

/** The built-in tools, registered in roster order (TL-FRAME-07). */
export const TOOL_REGISTRY: ToolRegistry = (() => {
  const registry = new ToolRegistry();
  for (const entry of TOOL_ROSTER) {
    const descriptor: ToolDescriptor = {
      id: entry.id,
      apiVersion: EXTENSION_API_MAJOR,
      label: `settings.tool.${entry.id}` as MessageId,
      help: `tool.help.${entry.id}` as MessageId,
      icon: `tool.${entry.id}`,
      hotkey: entry.hotkey,
      skipIfActive: entry.skipIfActive,
      commitCapable: entry.commitCapable,
      options: blockSchema(optionBlockOf(entry.id), OPTION_CONTEXT),
    };
    registry.register(descriptor);
  }
  return registry;
})();
