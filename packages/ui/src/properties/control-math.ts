import type { ControlOptions, PropertyDefinition } from "@openpaint/properties";

/** One component of a vector property. */
export type Axis = "x" | "y" | "z";

/** A closed numeric interval. */
export interface Range {
  readonly min: number;
  readonly max: number;
}

/** Slider and up-down steps of one control (or one axis of it), resolved against defaults. */
export interface StepSettings {
  readonly small: number;
  readonly large: number;
  readonly increment: number;
  readonly ticks: boolean;
}

const AXES: readonly Axis[] = ["x", "y", "z"];

const HUE_GRADIENT =
  "linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)";
/** Red sits at the centre of the track. */
const HUE_CENTERED_GRADIENT =
  "linear-gradient(to right, #00ffff, #0000ff, #ff00ff, #ff0000, #ffff00, #00ff00, #00ffff)";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function clampTo(value: number, range: Range): number {
  return Math.min(range.max, Math.max(range.min, value));
}

/** Rounds away binary noise so that repeated steps do not drift (for example 0.1 + 0.2). */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** The range of one scalar property, or of one component of a vector property. */
export function rangeOf(definition: PropertyDefinition, axis: Axis = "x"): Range {
  switch (definition.kind) {
    case "int32":
    case "double":
      return { min: definition.min, max: definition.max };
    case "vector2":
      return axisRange(definition.min, definition.max, axis);
    case "vector3":
      return axisRange(definition.min, definition.max, axis);
    default:
      return { min: 0, max: 1 };
  }
}

function axisRange(
  min: Readonly<Partial<Record<Axis, number>>>,
  max: Readonly<Partial<Record<Axis, number>>>,
  axis: Axis,
): Range {
  return { min: min[axis] ?? 0, max: max[axis] ?? 0 };
}

/** The axes a vector property has, in display order. */
export function axesOf(definition: PropertyDefinition): readonly Axis[] {
  if (definition.kind === "vector2") return AXES.slice(0, 2);
  if (definition.kind === "vector3") return AXES;
  return [];
}

/** Defaults used when a control sets no step: 1 and a tenth for integers, 1% and 10% otherwise. */
export function defaultSteps(range: Range, integer: boolean): { small: number; large: number } {
  const span = Math.max(0, range.max - range.min);
  if (integer) return { small: 1, large: Math.max(1, Math.round(span / 10)) };
  return { small: span / 100, large: span / 10 };
}

interface RawSteps {
  readonly small?: number;
  readonly large?: number;
  readonly increment?: number;
  readonly ticks?: boolean;
}

/** The step options that apply to one axis. Axis-specific options win over the shared ones. */
function rawStepsFor(control: ControlOptions, axis: Axis | undefined): RawSteps {
  switch (axis) {
    case "x":
      return {
        small: control.sliderSmallChangeX ?? control.sliderSmallChange,
        large: control.sliderLargeChangeX ?? control.sliderLargeChange,
        increment: control.upDownIncrementX ?? control.upDownIncrement,
        ticks: control.sliderShowTickMarksX ?? control.sliderShowTickMarks,
      };
    case "y":
      return {
        small: control.sliderSmallChangeY ?? control.sliderSmallChange,
        large: control.sliderLargeChangeY ?? control.sliderLargeChange,
        increment: control.upDownIncrementY ?? control.upDownIncrement,
        ticks: control.sliderShowTickMarksY ?? control.sliderShowTickMarks,
      };
    case "z":
      return {
        small: control.sliderSmallChangeZ ?? control.sliderSmallChange,
        large: control.sliderLargeChangeZ ?? control.sliderLargeChange,
        increment: control.upDownIncrementZ ?? control.upDownIncrement,
        ticks: control.sliderShowTickMarksZ ?? control.sliderShowTickMarks,
      };
    default:
      return {
        small: control.sliderSmallChange,
        large: control.sliderLargeChange,
        increment: control.upDownIncrement,
        ticks: control.sliderShowTickMarks,
      };
  }
}

export function stepSettings(
  control: ControlOptions | undefined,
  range: Range,
  integer: boolean,
  axis?: Axis,
): StepSettings {
  const fallback = defaultSteps(range, integer);
  const given = rawStepsFor(control ?? {}, axis);
  const small = given.small ?? fallback.small;
  return {
    small,
    large: given.large ?? fallback.large,
    increment: given.increment ?? small,
    ticks: given.ticks ?? false,
  };
}

export function decimalsOf(control: ControlOptions | undefined, integer: boolean): number {
  return control?.decimalPlaces ?? (integer ? 0 : 2);
}

/** The exponent of the non-linear slider mapping, or undefined for a linear slider. */
export function exponentOf(control: ControlOptions | undefined): number | undefined {
  if (!control?.useExponentialScale) return undefined;
  return control.exponentialScale ?? 2;
}

/** Moves a value by `delta`. Past an end it wraps to the other end when `wraps`, else stops. */
export function stepValue(value: number, delta: number, range: Range, wraps: boolean): number {
  const next = value + delta;
  if (next > range.max) return wraps ? range.min : range.max;
  if (next < range.min) return wraps ? range.max : range.min;
  return next;
}

/**
 * The wheel and stepper steps of a whole-number field by the value's size: 1 below 20, 2 below
 * 50, 5 below 100, 10 below 200, 25 below 500, 50 below 1000 and 100 from there. Each limit is a
 * multiple of the step below it, so stepping never jumps over one.
 */
const MAGNITUDE_STEPS: ReadonlyArray<readonly [limit: number, step: number]> = [
  [20, 1],
  [50, 2],
  [100, 5],
  [200, 10],
  [500, 25],
  [1000, 50],
  [Number.POSITIVE_INFINITY, 100],
];

/** Ctrl makes each magnitude step this many times larger. */
const LARGE_STEP_FACTOR = 5;

/** Tolerance for values that are already on a step multiple. */
const EPSILON = 1e-9;

/** The step from a non-negative value up (`below` false) or down to the next value below it. */
function magnitudeStepAt(magnitude: number, below: boolean): number {
  for (const [limit, step] of MAGNITUDE_STEPS) {
    if (below ? magnitude <= limit : magnitude < limit) return step;
  }
  return 1;
}

function stepOnce(value: number, direction: 1 | -1, large: boolean): number {
  if (value < 0 || (value === 0 && direction < 0)) {
    return -stepOnce(-value, direction === 1 ? -1 : 1, large);
  }
  const factor = large ? LARGE_STEP_FACTOR : 1;
  if (direction > 0) {
    const step = magnitudeStepAt(value, false) * factor;
    return (Math.floor(value / step + EPSILON) + 1) * step;
  }
  const step = magnitudeStepAt(value, true) * factor;
  return (Math.ceil(value / step - EPSILON) - 1) * step;
}

/**
 * Steps a whole-number value `steps` times (signed) with steps that grow with its size (see
 * MAGNITUDE_STEPS), landing on multiples of the step so values stay round: 21 goes up to 22 and
 * down to 20, and 20 goes down to 19. `large` (Ctrl) makes each step five times larger. Negative
 * values mirror positive ones. The result is clamped to the range.
 */
export function magnitudeStepValue(
  value: number,
  steps: number,
  range: Range,
  large = false,
): number {
  const direction = steps < 0 ? -1 : 1;
  let next = value;
  for (let index = 0; index < Math.abs(Math.trunc(steps)); index++) {
    next = stepOnce(next, direction, large);
  }
  // `+ 0` turns a mirrored -0 into 0.
  return clampTo(roundTo(next, 10), range) + 0;
}

/** Snaps a value to the step grid that starts at the range minimum, then clamps it. */
export function snapValue(value: number, range: Range, step: number): number {
  const clamped = clampTo(value, range);
  if (!(step > 0)) return clamped;
  const snapped = roundTo(range.min + Math.round((clamped - range.min) / step) * step, 10);
  return clampTo(snapped, range);
}

/** Maps a value to a slider position in [0, 1]. An exponent bends the scale for fine low values. */
export function fractionOf(value: number, range: Range, exponent?: number): number {
  const span = range.max - range.min;
  if (!(span > 0)) return 0;
  const linear = clamp01((value - range.min) / span);
  return exponent === undefined ? linear : linear ** (1 / exponent);
}

/** The inverse of `fractionOf`. */
export function valueAtFraction(fraction: number, range: Range, exponent?: number): number {
  const position = clamp01(fraction);
  const linear = exponent === undefined ? position : position ** exponent;
  return range.min + (range.max - range.min) * linear;
}

/** Slider positions of the tick marks: one per large step, excluding both ends. */
export function tickFractions(range: Range, large: number, exponent?: number): number[] {
  const span = range.max - range.min;
  if (!(large > 0) || !(span > 0) || span / large > 100) return [];
  const fractions: number[] = [];
  for (let i = 1; i * large < span - 1e-9; i += 1) {
    fractions.push(fractionOf(range.min + i * large, range, exponent));
  }
  return fractions;
}

/**
 * The value for a key press on a slider or dial, or undefined when the key is not a slider key.
 * Arrows step by the small change, Page keys by the large change, and Home and End jump to the ends.
 */
export function keyboardValue(
  key: string,
  value: number,
  steps: StepSettings,
  range: Range,
  wraps: boolean,
): number | undefined {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return stepValue(value, steps.small, range, wraps);
    case "ArrowLeft":
    case "ArrowDown":
      return stepValue(value, -steps.small, range, wraps);
    case "PageUp":
      return stepValue(value, steps.large, range, wraps);
    case "PageDown":
      return stepValue(value, -steps.large, range, wraps);
    case "Home":
      return range.min;
    case "End":
      return range.max;
    default:
      return undefined;
  }
}

/** Number format options for a value with `decimals` digits, or a percentage of 1 with `decimals` digits. */
export function numberFormatOptions(decimals: number, percent: boolean): Intl.NumberFormatOptions {
  return percent
    ? { style: "percent", maximumFractionDigits: decimals }
    : { maximumFractionDigits: decimals };
}

/** A value as text: 0.75 is "0.75", or "75%" as a percentage. */
export function formatNumber(
  value: number,
  decimals: number,
  percent: boolean,
  locale?: string,
): string {
  return new Intl.NumberFormat(locale, numberFormatOptions(decimals, percent)).format(value);
}

/**
 * The value of typed text, or undefined when it is not a number. A percentage is typed as its
 * number of percent, with or without the sign, so "75" and "75 %" are both 0.75. A comma may
 * stand for the decimal point.
 */
export function parseNumberText(text: string, percent: boolean): number | undefined {
  const cleaned = text.replace(/[%\s]/g, "").replace(",", ".");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return undefined;
  return percent ? parsed / 100 : parsed;
}

/** The horizontal fraction of a pointer position over a track, or undefined for a zero-size track. */
export function fractionAtPoint(clientX: number, left: number, width: number): number | undefined {
  if (!(width > 0)) return undefined;
  return clamp01((clientX - left) / width);
}

/** Wraps an angle into [min, max) on the circle (a range of 360 degrees, or any span). */
export function wrapValue(value: number, range: Range): number {
  const span = range.max - range.min;
  if (!(span > 0)) return range.min;
  const offset = (((value - range.min) % span) + span) % span;
  return range.min + offset;
}

/** The angle of a point relative to the dial centre, in degrees, measured clockwise from 3 o'clock. */
export function angleOf(dx: number, dy: number): number {
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Track background for the slider's `controlStyle` or `controlColors` option. */
export function sliderBackground(control: ControlOptions | undefined): string | undefined {
  if (control?.controlColors && control.controlColors.length > 0) {
    return `linear-gradient(to right, ${control.controlColors.join(", ")})`;
  }
  switch (control?.controlStyle) {
    case "hue":
      return HUE_GRADIENT;
    case "hueCentered":
      return HUE_CENTERED_GRADIENT;
    case "saturationHue":
      return "linear-gradient(to right, #808080, #ff0000)";
    default:
      return undefined;
  }
}
