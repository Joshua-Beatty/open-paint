import { useTranslation } from "@openpaint/i18n/react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Group, Input, NumberField, useLocale } from "react-aria-components";
import {
  clampTo,
  formatNumber,
  fractionAtPoint,
  fractionOf,
  keyboardValue,
  magnitudeStepValue,
  numberFormatOptions,
  parseNumberText,
  type Range,
  roundTo,
  type StepSettings,
  snapValue,
  stepValue,
  tickFractions,
  valueAtFraction,
} from "./control-math";
import { StepperIcon } from "./icons";
import { useFrameRequest } from "./use-frame-request";
import { useWheelStep } from "./use-wheel-step";

export interface ScalarSliderProps {
  /** The accessible name of the slider. */
  readonly name: string;
  readonly value: number;
  readonly range: Range;
  readonly steps: StepSettings;
  /** Exponent of the non-linear mapping, or undefined for a linear slider. */
  readonly exponent?: number;
  readonly wraps: boolean;
  readonly background?: string;
  readonly valueText: string;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}

/**
 * A horizontal slider with pointer dragging and the keyboard model of an ARIA slider: arrows step
 * by the small change, Page keys by the large change, and Home and End go to the ends.
 */
export function ScalarSlider({
  name,
  value,
  range,
  steps,
  exponent,
  wraps,
  background,
  valueText,
  disabled,
  onChange,
}: ScalarSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // A drag sets the value at most once per frame, where the pointer is then (L1).
  const frame = useFrameRequest();
  const fraction = fractionOf(value, range, exponent);

  const pick = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const position = fractionAtPoint(clientX, rect.left, rect.width);
    if (position === undefined) return;
    onChange(snapValue(valueAtFraction(position, range, exponent), range, steps.small));
  };

  const trackStyle: CSSProperties | undefined =
    background === undefined ? undefined : { background };

  return (
    <div
      ref={trackRef}
      className="prop-slider"
      style={trackStyle}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        pick(event.clientX);
      }}
      onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
        if (!dragging.current) return;
        const { clientX } = event;
        frame.request(() => pick(clientX));
      }}
      onPointerUp={() => {
        dragging.current = false;
        frame.flush();
      }}
      onPointerCancel={() => {
        dragging.current = false;
        frame.flush();
      }}
    >
      {steps.ticks &&
        tickFractions(range, steps.large, exponent).map((position) => (
          <span
            key={position}
            className="prop-slider-tick"
            style={{ left: `${position * 100}%` }}
          />
        ))}
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={name}
        aria-valuemin={range.min}
        aria-valuemax={range.max}
        aria-valuenow={value}
        aria-valuetext={valueText}
        aria-disabled={disabled}
        className="prop-slider-thumb"
        style={{ left: `${fraction * 100}%` }}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (disabled) return;
          const next = keyboardValue(event.key, value, steps, range, wraps);
          if (next === undefined) return;
          event.preventDefault();
          onChange(snapValue(next, range, steps.small));
        }}
      />
    </div>
  );
}

export interface NumberBoxProps {
  /** The accessible name of the box. */
  readonly name: string;
  readonly value: number;
  readonly range: Range;
  readonly step: number;
  readonly decimals: number;
  readonly formatOptions?: Intl.NumberFormatOptions;
  /**
   * The value is a whole number: the wheel steps by an amount that grows with the value
   * (`magnitudeStepValue`) instead of `step`.
   */
  readonly magnitudeSteps?: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}

/** A numeric field with small up and down stepper buttons. Input that is not a number is ignored. */
export function NumberBox({
  name,
  value,
  range,
  step,
  decimals,
  formatOptions,
  magnitudeSteps = false,
  disabled,
  onChange,
}: NumberBoxProps) {
  const t = useTranslation();
  const wheelRef = useWheelStep<HTMLDivElement>((steps, large) => {
    const next = magnitudeSteps
      ? magnitudeStepValue(value, steps, range, large)
      : roundTo(stepValue(value, steps * (large ? step * 5 : step), range, false), 10);
    if (next !== value) onChange(next);
  }, disabled);
  return (
    <NumberField
      aria-label={t("property.valueFor", { name })}
      className="prop-number"
      value={value}
      minValue={range.min}
      maxValue={range.max}
      step={step}
      formatOptions={formatOptions ?? { maximumFractionDigits: decimals }}
      isDisabled={disabled}
      // The wheel steps the value while the pointer is over the field, focused or not.
      isWheelDisabled
      onChange={(next) => {
        if (Number.isFinite(next)) onChange(next);
      }}
    >
      <Group ref={wheelRef} className="prop-field">
        <Input className="prop-field-input" />
        <span className="prop-steppers">
          <Button slot="increment" className="prop-stepper" aria-label={t("property.increase")}>
            <StepperIcon up />
          </Button>
          <Button slot="decrement" className="prop-stepper" aria-label={t("property.decrease")}>
            <StepperIcon up={false} />
          </Button>
        </span>
      </Group>
    </NumberField>
  );
}

export interface InlineSliderProps {
  /** The accessible name of the slider. */
  readonly name: string;
  readonly value: number;
  readonly range: Range;
  readonly steps: StepSettings;
  /** Exponent of the non-linear mapping, or undefined for a linear slider. */
  readonly exponent?: number;
  readonly decimals: number;
  /** Shows the value as a percentage of 1, so 0.75 reads "75%". */
  readonly percent: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}

/** Pointer travel, in CSS px, past which a press on the slider drags instead of opening the box. */
const DRAG_THRESHOLD_PX = 3;

/**
 * A compact slider for a toolbar row: one field-sized box whose fill shows the value's place in
 * its range, with the value written on it. Dragging sets the value from the pointer, a click
 * without a drag (or Enter, F2 or a digit) opens a text box to type it, and the wheel steps it
 * while the pointer is over it, five times further with Ctrl. The keyboard is that of an ARIA
 * slider; Ctrl with an arrow takes the large step.
 */
export function InlineSlider({
  name,
  value,
  range,
  steps,
  exponent,
  decimals,
  percent,
  disabled,
  onChange,
}: InlineSliderProps) {
  const t = useTranslation();
  const { locale } = useLocale();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const sliderRef = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const press = useRef<{ x: number; dragging: boolean } | undefined>(undefined);
  // A drag sets the value at most once per frame, where the pointer is then (L1).
  const frame = useFrameRequest();
  const text = formatNumber(value, decimals, percent, locale);
  const wheelRef = useWheelStep<HTMLDivElement>(
    (count, large) => {
      const delta = count * (large ? steps.increment * 5 : steps.increment);
      const next = roundTo(stepValue(value, delta, range, false), 10);
      if (next !== value) onChange(next);
    },
    disabled || draft !== undefined,
  );

  useEffect(() => {
    if (draft === undefined && refocus.current) {
      refocus.current = false;
      sliderRef.current?.focus();
    }
  }, [draft]);

  const pick = (clientX: number) => {
    const rect = sliderRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const position = fractionAtPoint(clientX, rect.left, rect.width);
    if (position === undefined) return;
    const next = snapValue(valueAtFraction(position, range, exponent), range, steps.small);
    if (next !== value) onChange(next);
  };

  const finish = (commit: boolean, returnFocus: boolean) => {
    if (commit && draft !== undefined) {
      const typed = parseNumberText(draft, percent);
      if (typed !== undefined) {
        const next = clampTo(roundTo(typed, decimals + (percent ? 2 : 0)), range);
        if (next !== value) onChange(next);
      }
    }
    refocus.current = returnFocus;
    setDraft(undefined);
  };

  const style = {
    "--prop-fill": `${fractionOf(value, range, exponent) * 100}%`,
  } as CSSProperties;

  return (
    <div ref={wheelRef} className="prop-inline-slider" style={style}>
      {draft === undefined ? (
        <div
          ref={sliderRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={name}
          aria-valuemin={range.min}
          aria-valuemax={range.max}
          aria-valuenow={value}
          aria-valuetext={text}
          aria-disabled={disabled}
          className="prop-inline-slider-track"
          onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
            if (disabled || event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            press.current = { x: event.clientX, dragging: false };
          }}
          onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
            const current = press.current;
            if (current === undefined) return;
            if (!current.dragging && Math.abs(event.clientX - current.x) < DRAG_THRESHOLD_PX)
              return;
            current.dragging = true;
            const { clientX } = event;
            frame.request(() => pick(clientX));
          }}
          onPointerUp={() => {
            const current = press.current;
            press.current = undefined;
            frame.flush();
            if (current !== undefined && !current.dragging) setDraft(text);
          }}
          onPointerCancel={() => {
            press.current = undefined;
            frame.flush();
          }}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (disabled) return;
            if (event.key === "Enter" || event.key === "F2") {
              event.preventDefault();
              setDraft(text);
              return;
            }
            if (/^[0-9.,-]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
              setDraft(event.key);
              return;
            }
            const large = event.ctrlKey && event.key.startsWith("Arrow");
            const stepped = large ? { ...steps, small: steps.large } : steps;
            const next = keyboardValue(event.key, value, stepped, range, false);
            if (next === undefined) return;
            event.preventDefault();
            const snapped = snapValue(next, range, steps.small);
            if (snapped !== value) onChange(snapped);
          }}
        >
          <span className="prop-inline-slider-value" aria-hidden="true">
            {text}
          </span>
        </div>
      ) : (
        <input
          className="prop-inline-slider-input"
          aria-label={t("property.valueFor", { name })}
          value={draft}
          // biome-ignore lint/a11y/noAutofocus: the box replaces the focused slider that opened it.
          autoFocus
          onFocus={(event) => {
            if (draft === text) event.currentTarget.select();
          }}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finish(true, true);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finish(false, true);
            }
          }}
          onBlur={() => finish(true, false)}
        />
      )}
    </div>
  );
}

export type SliderRowProps = Omit<ScalarSliderProps, "valueText" | "disabled"> & {
  readonly decimals: number;
  /** Shows the value as a percentage of 1, so 0.75 reads "75%". */
  readonly percent?: boolean;
  readonly disabled: boolean;
};

/** A slider paired with its numeric box (SET-DLG and EXT-06C: slider plus up-down field). */
export function SliderRow({ decimals, percent = false, disabled, ...slider }: SliderRowProps) {
  const { locale } = useLocale();
  const valueText = percent
    ? formatNumber(slider.value, decimals, true, locale)
    : slider.value.toFixed(decimals);
  return (
    <div className="prop-slider-row">
      <ScalarSlider {...slider} valueText={valueText} disabled={disabled} />
      <NumberBox
        name={slider.name}
        value={slider.value}
        range={slider.range}
        step={slider.steps.increment}
        decimals={decimals}
        formatOptions={numberFormatOptions(decimals, percent)}
        disabled={disabled}
        onChange={slider.onChange}
      />
    </div>
  );
}
