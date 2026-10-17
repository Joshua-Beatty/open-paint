import type { PropertyDefinition, PropertyKind } from "./types";

/** The 15 control types (EXT-06C-01). */
export const CONTROL_TYPES = [
  "anglePicker",
  "checkbox",
  "panAndSliders",
  "slider",
  "incrementButton",
  "dropdown",
  "textBox",
  "radioButtons",
  "colorWheel",
  "trackballAndSliders",
  "filePicker",
  "link",
  "folderPicker",
  "hidden",
  "label",
] as const;

export type ControlType = (typeof CONTROL_TYPES)[number];

interface ControlChoices {
  readonly defaultControl: ControlType;
  readonly alternatives: readonly ControlType[];
}

/**
 * The default control and the alternatives for each property kind (EXT-06A-01..11). `hidden` is
 * allowed for every kind. Image uses `label` because the proposed display-only image control is
 * not one of the 15 control types.
 */
const CONTROLS_BY_KIND: Record<PropertyKind, ControlChoices> = {
  boolean: { defaultControl: "checkbox", alternatives: [] },
  int32: { defaultControl: "slider", alternatives: ["incrementButton", "colorWheel"] },
  double: { defaultControl: "slider", alternatives: ["anglePicker"] },
  vector2: { defaultControl: "panAndSliders", alternatives: ["slider"] },
  vector3: { defaultControl: "trackballAndSliders", alternatives: ["slider"] },
  choice: { defaultControl: "dropdown", alternatives: ["radioButtons"] },
  string: { defaultControl: "textBox", alternatives: ["filePicker", "folderPicker", "label"] },
  uri: { defaultControl: "link", alternatives: [] },
  image: { defaultControl: "label", alternatives: [] },
  color: { defaultControl: "colorWheel", alternatives: [] },
  tabState: { defaultControl: "hidden", alternatives: [] },
};

export function defaultControlType(kind: PropertyKind): ControlType {
  return CONTROLS_BY_KIND[kind].defaultControl;
}

export function allowedControlTypes(kind: PropertyKind): readonly ControlType[] {
  const { defaultControl, alternatives } = CONTROLS_BY_KIND[kind];
  return [...new Set<ControlType>([defaultControl, ...alternatives, "hidden"])];
}

/** The control a property shows: its override, or the default for its kind. */
export function effectiveControlType(definition: PropertyDefinition): ControlType {
  return definition.control?.controlType ?? defaultControlType(definition.kind);
}
