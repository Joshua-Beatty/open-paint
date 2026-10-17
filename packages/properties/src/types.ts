import type { MessageId } from "@openpaint/i18n";
import type { ControlType } from "./controls";

/** A high-precision color (EXT-06A-10). Channels are floats in [0, 1]. */
export interface ColorValue {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** A pair of doubles (EXT-06A-04). */
export interface Vector2 {
  readonly x: number;
  readonly y: number;
}

/** A triple of doubles (EXT-06A-05). */
export interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A value of a StaticChoice property: an enum string or a number. */
export type ChoiceValue = string | number;

/** The value of one property, in the shape of its kind. */
export type PropertyValue = boolean | number | string | Vector2 | Vector3 | ColorValue;

/** Parameter values keyed by property name. */
export type PropertyValues = Readonly<Record<string, PropertyValue>>;

/** A value that survives `JSON.stringify`/`JSON.parse`. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** What a property does with a value that cannot be used (EXT-06A-13). Clamp is the default. */
export type InvalidValuePolicy = "ignore" | "clamp" | "reject";

/** Control options (EXT-06C-02). Every option is optional, and each control reads the ones it uses. */
export interface ControlOptions {
  /** Header label. Defaults to the property's label. */
  readonly displayName?: MessageId;
  /** Caption, for example the checkbox text. */
  readonly description?: MessageId;
  /** Overrides the default control of the property's kind (EXT-06A table). */
  readonly controlType?: ControlType;
  readonly buttonText?: MessageId;
  readonly useExponentialScale?: boolean;
  readonly exponentialScale?: number;
  readonly decimalPlaces?: number;
  /**
   * Shows a number as a percentage of 1: 0.75 reads "75%", and `decimalPlaces` counts the digits
   * of the percentage. Steps and the stored value stay fractions.
   */
  readonly percent?: boolean;
  /**
   * The range is a safety limit rather than a scale to pick within, such as a size in pixels.
   * Compact layouts show a number box for it instead of a slider.
   */
  readonly openEnded?: boolean;
  readonly sliderSmallChange?: number;
  readonly sliderSmallChangeX?: number;
  readonly sliderSmallChangeY?: number;
  readonly sliderSmallChangeZ?: number;
  readonly sliderLargeChange?: number;
  readonly sliderLargeChangeX?: number;
  readonly sliderLargeChangeY?: number;
  readonly sliderLargeChangeZ?: number;
  /**
   * Preset values of a number property. With presets, the control is an editable combo box with
   * −/+ buttons instead of a slider (TL-OPT-BRUSH).
   */
  readonly presets?: readonly number[];
  readonly upDownIncrement?: number;
  readonly upDownIncrementX?: number;
  readonly upDownIncrementY?: number;
  readonly upDownIncrementZ?: number;
  readonly sliderShowTickMarks?: boolean;
  readonly sliderShowTickMarksX?: boolean;
  readonly sliderShowTickMarksY?: boolean;
  readonly sliderShowTickMarksZ?: boolean;
  /** Resource key of a background image, for example under a pan control. */
  readonly staticImageUnderlay?: string;
  readonly multiline?: boolean;
  readonly showResetButton?: boolean;
  readonly dialogTitle?: MessageId;
  readonly dialogWidthScale?: number;
  readonly dialogIsResizable?: boolean;
  readonly footnote?: MessageId;
  /** The value wraps around at its ends (angles and hue). */
  readonly rangeWraps?: boolean;
  readonly controlStyle?: "default" | "hue" | "hueCentered" | "saturationHue";
  /** Custom gradient colors for a slider. */
  readonly controlColors?: readonly string[];
  readonly dialogHelpContentType?: "none" | "plainText" | "custom";
  /** Help text, or the value passed to `onHelpRequested` for the custom type. */
  readonly dialogHelpContent?: string;
  /**
   * Built-in help text from the message catalog, shown as plain-text help in the dialog's language.
   * It replaces `dialogHelpContent`, and implies the plain-text help type.
   */
  readonly dialogHelpMessage?: MessageId;
  readonly allowAllFiles?: boolean;
  /** File picker filter: dot-prefixed extensions. */
  readonly fileTypes?: readonly string[];
  readonly showHeaderLine?: boolean;
  readonly dialogShowBottomSeparator?: boolean;
  /**
   * Icon data (`iconShape`: 16 x 16 path data, stroked in the text color, or a `filledIcon`) that
   * names the property in a compact toolbar, where a drop-down shows an icon and its value instead of a heading.
   */
  readonly icon?: string;
  /**
   * Shows a boolean as a two-item drop-down instead of a checkbox, as compact toolbars do
   * (TL-OPT-AA, TL-OPT-FLOOD Sampling): the button shows the value's short label with its icon,
   * and the list offers both values with their icons. The control's name is the property's label.
   */
  readonly booleanChoices?: BooleanChoices;
  /**
   * A short name that a compact toolbar's drop-down shows before its value ("Blend: Normal"),
   * for values that do not say on their own what they choose.
   */
  readonly inlineCaption?: MessageId;
  /**
   * Lays a `radioButtons` choice out as a grid of icon buttons instead of a list (EXT-06C-02): a
   * single-choice radio group whose cells show each option's icon, with its label as the name and
   * tooltip. The arrow keys move through the grid.
   */
  readonly choiceGrid?: ChoiceGrid;
}

/** The cells of a choice grid (ControlOptions.choiceGrid). */
export interface ChoiceGrid {
  /**
   * The rows, top to bottom, each a list of option values left to right; `null` leaves a cell
   * empty. Every option appears exactly once, and every row has the same length.
   */
  readonly rows: readonly (readonly (ChoiceValue | null)[])[];
  /** Row indexes followed by a wider gap, which sets groups of cells apart. */
  readonly gapAfterRows?: readonly number[];
  /** Column indexes followed by a wider gap. */
  readonly gapAfterColumns?: readonly number[];
}

/** One value of a boolean shown as a drop-down: its icon, its names and an optional tooltip. */
export interface BooleanChoice {
  /** Icon data: 16 x 16 path data, stroked in the text color, or a `filledIcon`. */
  readonly icon: string;
  /** The list item, a phrase that reads on its own: "Enable path smoothing". */
  readonly label: MessageId;
  /** The button text while the value is chosen, such as "Smoothing: On". Defaults to `label`. */
  readonly shortLabel?: MessageId;
  readonly tooltip?: MessageId;
}

/** The two values of a boolean drop-down (ControlOptions.booleanChoices). */
export interface BooleanChoices {
  readonly on: BooleanChoice;
  readonly off: BooleanChoice;
  /** Lists the true value first, for example "On" before "Off". */
  readonly onFirst?: boolean;
}

interface PropertyBase {
  /** Property name and key in the owner's parameter set. */
  readonly key: string;
  /** Display name, used as the control's label unless `control.displayName` is set. */
  readonly label: MessageId;
  /** Initial read-only flag (EXT-06A-12). */
  readonly readOnly?: boolean;
  /** Invalid-value policy. Defaults to clamp. */
  readonly onInvalid?: InvalidValuePolicy;
  readonly control?: ControlOptions;
}

export interface BooleanProperty extends PropertyBase {
  readonly kind: "boolean";
  readonly defaultValue: boolean;
}

/** A 32-bit integer in [min, max]. Both bounds must be integers. */
export interface Int32Property extends PropertyBase {
  readonly kind: "int32";
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
}

/** A 64-bit float in [min, max]. */
export interface DoubleProperty extends PropertyBase {
  readonly kind: "double";
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
}

/** An (x, y) pair with per-axis bounds. */
export interface Vector2Property extends PropertyBase {
  readonly kind: "vector2";
  readonly defaultValue: Vector2;
  readonly min: Vector2;
  readonly max: Vector2;
}

/** An (x, y, z) triple with per-axis bounds. */
export interface Vector3Property extends PropertyBase {
  readonly kind: "vector3";
  readonly defaultValue: Vector3;
  readonly min: Vector3;
  readonly max: Vector3;
}

export interface ChoiceOption {
  readonly value: ChoiceValue;
  /** Localized display name of the list item (EXT-06C-03). */
  readonly label: MessageId;
  /** Tooltip of the list item, for example the modifier keys that choose it (TL-OPT-SELMODE). */
  readonly tooltip?: MessageId;
  /** The item is listed but cannot be chosen, for example a backend the browser lacks (SET-DLG-07a). */
  readonly disabled?: boolean;
  /** Icon data shown before the label: 16 x 16 path data, stroked, or a `filledIcon`. */
  readonly icon?: string;
  /** A shorter name that a compact toolbar's drop-down button shows; its list shows `label`. */
  readonly shortLabel?: MessageId;
}

/** One value from a fixed list. */
export interface ChoiceProperty extends PropertyBase {
  readonly kind: "choice";
  readonly defaultValue: ChoiceValue;
  readonly options: readonly ChoiceOption[];
}

/** Text. Longer values are truncated when `maxLength` is set. */
export interface StringProperty extends PropertyBase {
  readonly kind: "string";
  readonly defaultValue: string;
  readonly maxLength?: number;
}

/** A URL with a scheme (for example `https:`). */
export interface UriProperty extends PropertyBase {
  readonly kind: "uri";
  readonly defaultValue: string;
}

/** A reference to an image resource, by key. */
export interface ImageProperty extends PropertyBase {
  readonly kind: "image";
  readonly defaultValue: string;
}

/** A high-precision color. `opaqueOnly` forces alpha to 1. */
export interface ColorProperty extends PropertyBase {
  readonly kind: "color";
  readonly defaultValue: ColorValue;
  readonly alphaMode: "opaqueOnly" | "supportsAlpha";
}

/** The selected tab index of a tab container, in [0, tabCount - 1]. */
export interface TabStateProperty extends PropertyBase {
  readonly kind: "tabState";
  readonly defaultValue: number;
  readonly tabCount: number;
}

export type PropertyDefinition =
  | BooleanProperty
  | Int32Property
  | DoubleProperty
  | Vector2Property
  | Vector3Property
  | ChoiceProperty
  | StringProperty
  | UriProperty
  | ImageProperty
  | ColorProperty
  | TabStateProperty;

export type PropertyKind = PropertyDefinition["kind"];

/** A (property name, value) pair that matches a read-only condition. */
export interface PropertyCondition {
  readonly name: string;
  readonly value: PropertyValue;
}

/** Inter-property constraints (EXT-06B). `inverted` negates the condition. */
export type PropertyRule =
  | {
      readonly kind: "readOnlyWhenBoolean";
      readonly target: string;
      readonly source: string;
      readonly inverted?: boolean;
    }
  | {
      readonly kind: "readOnlyWhenValue";
      readonly target: string;
      readonly source: string;
      readonly values: readonly PropertyValue[];
      readonly inverted?: boolean;
    }
  | {
      readonly kind: "readOnlyWhenNameValues";
      readonly target: string;
      readonly conditions: readonly PropertyCondition[];
    }
  | {
      readonly kind: "setTargetWhenSourceEquals";
      readonly source: string;
      readonly values: readonly PropertyValue[];
      readonly target: string;
      readonly targetValue: PropertyValue;
      readonly inverted?: boolean;
    }
  | { readonly kind: "softMinMax"; readonly lower: string; readonly upper: string }
  | {
      readonly kind: "linkValuesWhenBoolean";
      readonly source: string;
      readonly when: boolean;
      readonly keys: readonly string[];
    };

/** Layout containers (EXT-06C-03): a control, a vertical panel, or a tab container. */
export type LayoutNode =
  | { readonly kind: "control"; readonly key: string }
  | { readonly kind: "panel"; readonly children: readonly LayoutNode[] }
  | {
      readonly kind: "tabs";
      /** Key of a tabState property. */
      readonly key: string;
      readonly pages: readonly TabPage[];
    };

export interface TabPage {
  readonly label: MessageId;
  readonly children: readonly LayoutNode[];
}

/**
 * Upgrades stored values from schema version `from` to `from + 1`. Keys it does not touch are
 * copied through, and invalid values fall back to defaults (EXT-02-13, SET-STO-02).
 */
export interface SchemaMigration {
  readonly from: number;
  readonly migrate: (record: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}

/** A property collection: the declarative schema of one effect, adjustment or file type. */
export interface PropertySchema {
  /** Schema version, an integer from 1. Defaults to 1. */
  readonly version?: number;
  readonly properties: readonly PropertyDefinition[];
  readonly rules?: readonly PropertyRule[];
  /** Explicit layout. Without one, every visible control is listed in declaration order. */
  readonly layout?: readonly LayoutNode[];
  readonly migrations?: readonly SchemaMigration[];
}
