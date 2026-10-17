import { useTranslation } from "@openpaint/i18n/react";
import { useEffect, useState } from "react";
import {
  Button,
  ButtonContext,
  ComboBox,
  Group,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
} from "react-aria-components";
import { magnitudeStepValue, type Range, roundTo, stepValue } from "./control-math";
import { DropdownChevron, StepperIcon } from "./icons";
import { useWheelStep } from "./use-wheel-step";

export interface PresetComboBoxProps {
  /** The accessible name of the box. */
  readonly name: string;
  readonly value: number;
  readonly range: Range;
  /** The values the drop-down offers. The box also takes any number in range. */
  readonly presets: readonly number[];
  /** The −/+ buttons step by this amount. Ctrl steps by five times it. */
  readonly step: number;
  /**
   * The value is a whole number: the −/+ buttons and the wheel step by an amount that grows with
   * the value (`magnitudeStepValue`) instead of `step`.
   */
  readonly magnitudeSteps?: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}

/**
 * An editable combo box of preset values with −/+ buttons (TL-OPT-BRUSH). Text that is not a
 * number, or is outside the range, is refused with a message and leaves the value unchanged.
 */
export function PresetComboBox({
  name,
  value,
  range,
  presets,
  step,
  magnitudeSteps = false,
  disabled,
  onChange,
}: PresetComboBoxProps) {
  const t = useTranslation();
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setText(String(value));
    setError(undefined);
  }, [value]);

  const commit = (raw: string) => {
    const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed)) {
      setError(t("property.invalidNumber"));
      return;
    }
    if (parsed < range.min) {
      setError(t("property.smallerThan", { min: range.min }));
      return;
    }
    if (parsed > range.max) {
      setError(t("property.largerThan", { max: range.max }));
      return;
    }
    setError(undefined);
    if (parsed !== value) onChange(parsed);
  };

  const stepBy = (steps: number, large: boolean) => {
    const next = magnitudeSteps
      ? magnitudeStepValue(value, steps, range, large)
      : roundTo(stepValue(value, steps * (large ? step * 5 : step), range, false), 10);
    if (next !== value) onChange(next);
  };
  // The wheel steps like the buttons while the pointer is over the box (TL-OPT-BRUSH).
  const wheelRef = useWheelStep<HTMLDivElement>(stepBy, disabled);

  return (
    <div className="prop-preset">
      <ComboBox
        aria-label={name}
        className="prop-preset-combo"
        allowsCustomValue
        inputValue={text}
        onInputChange={setText}
        isDisabled={disabled}
        onSelectionChange={(key) => {
          if (key !== null) commit(String(key));
        }}
      >
        <Group ref={wheelRef} className="prop-field">
          <Input
            aria-label={name}
            className="prop-field-input"
            onBlur={() => commit(text)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit(text);
            }}
          />
          <Button className="prop-field-dropdown" aria-label={t("property.presets")}>
            <DropdownChevron />
          </Button>
          <ButtonContext.Provider value={null}>
            <span className="prop-steppers">
              <Button
                className="prop-stepper"
                isDisabled={disabled}
                excludeFromTabOrder
                aria-label={t("property.increase")}
                onPress={(event) => stepBy(1, event.ctrlKey)}
              >
                <StepperIcon up />
              </Button>
              <Button
                className="prop-stepper"
                isDisabled={disabled}
                excludeFromTabOrder
                aria-label={t("property.decrease")}
                onPress={(event) => stepBy(-1, event.ctrlKey)}
              >
                <StepperIcon up={false} />
              </Button>
            </span>
          </ButtonContext.Provider>
        </Group>
        <Popover className="prop-popover">
          <ListBox className="prop-listbox">
            {presets.map((preset) => (
              <ListBoxItem
                key={preset}
                id={String(preset)}
                className="prop-option"
                textValue={String(preset)}
              >
                {String(preset)}
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </ComboBox>
      {error === undefined ? null : (
        <span className="prop-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
