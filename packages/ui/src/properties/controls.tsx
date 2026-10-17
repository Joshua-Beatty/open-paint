import type { MessageId } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import {
  type BooleanChoice,
  type BooleanChoices,
  type ChoiceOption,
  type ColorValue,
  type ControlType,
  defaultValue,
  effectiveControlType,
  type PropertyDefinition,
  type PropertyValue,
  type Vector2,
  type Vector3,
} from "@openpaint/properties";
import { createContext, useContext } from "react";
import {
  Button,
  Checkbox,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
  Radio,
  RadioGroup,
  Select,
  SelectValue,
  TextArea,
  TextField,
  Tooltip,
} from "react-aria-components";
import { TooltipTrigger } from "../tooltip";
import { AngleDial } from "./AngleDial";
import { ChoiceGridBody } from "./ChoiceGrid";
import { ColorWheel } from "./ColorWheel";
import { ControlFrame } from "./ControlFrame";
import { hsvToRgb, packRgb, rgbToHsv, toByte, unpackRgb } from "./color-math";
import {
  type Axis,
  axesOf,
  decimalsOf,
  exponentOf,
  numberFormatOptions,
  type Range,
  rangeOf,
  sliderBackground,
  stepSettings,
  stepValue,
} from "./control-math";
import { DropdownChevron, OptionIcon } from "./icons";
import { ControlLayoutContext } from "./layout-context";
import { PresetComboBox } from "./PresetComboBox";
import { InlineSlider, NumberBox, SliderRow } from "./ScalarSlider";
import type { PropertyServices } from "./services";
import { TwoAxisPad } from "./TwoAxisPad";

const AXIS_LABEL: Record<Axis, MessageId> = {
  x: "property.axis.x",
  y: "property.axis.y",
  z: "property.axis.z",
};

/** Checkboxes and links use their caption as the text, so they have no separate description. */
const CAPTION_CONTROLS: readonly ControlType[] = ["checkbox", "link"];
/** Controls that show a value without editing it have no reset button. */
const READ_ONLY_CONTROLS: readonly ControlType[] = ["link", "label"];
/** Controls that are buttons show a heading only when the schema names one explicitly. */
const UNHEADED_CONTROLS: readonly ControlType[] = ["checkbox", "incrementButton"];
/**
 * Controls that keep a short visible label in the inline layout. A number alone does not say what
 * it is; a drop-down shows an icon and its value, and a checkbox or button carries its own caption.
 */
const INLINE_LABELLED_CONTROLS: readonly ControlType[] = [
  "slider",
  "anglePicker",
  "panAndSliders",
  "trackballAndSliders",
  "radioButtons",
  "textBox",
  "filePicker",
  "folderPicker",
];

/**
 * The name of the form's dialog. A control whose caption is blank (property.noCaption) is still
 * named by it, so its slider, reset button and checkbox are not unnamed to assistive technology.
 */
export const FormNameContext = createContext("");

export interface PropertyControlProps {
  readonly definition: PropertyDefinition;
  readonly value: PropertyValue;
  readonly readOnly: boolean;
  readonly services: PropertyServices;
  readonly onChange: (value: PropertyValue) => void;
}

/**
 * One property as a control (EXT-06C-01). The control type comes from the schema's override or the
 * kind's default. Every control shares the frame: heading, header line, description, reset and footnote.
 */
export function PropertyControl({
  definition,
  value,
  readOnly,
  services,
  onChange,
}: PropertyControlProps) {
  const t = useTranslation();
  const formName = useContext(FormNameContext);
  const control = definition.control;
  const type = effectiveControlType(definition);
  if (type === "hidden") return null;

  const caption = t(control?.displayName ?? definition.label);
  const name = caption === "" ? formName : caption;
  const explicitHeading = control?.displayName !== undefined;
  const heading = UNHEADED_CONTROLS.includes(type) && !explicitHeading ? undefined : caption;
  const description =
    CAPTION_CONTROLS.includes(type) || control?.description === undefined
      ? undefined
      : t(control.description);
  const footnote = control?.footnote === undefined ? undefined : t(control.footnote);
  const resetAllowed = control?.showResetButton !== false && !READ_ONLY_CONTROLS.includes(type);
  const inlineLabel = INLINE_LABELLED_CONTROLS.includes(type) ? caption : undefined;

  return (
    <ControlFrame
      name={name}
      heading={heading}
      showHeaderLine={control?.showHeaderLine ?? true}
      description={description}
      footnote={footnote}
      onReset={resetAllowed ? () => onChange(defaultValue(definition)) : undefined}
      resetDisabled={readOnly}
      inlineLabel={inlineLabel === "" ? undefined : inlineLabel}
    >
      <ControlBody
        type={type}
        definition={definition}
        value={value}
        readOnly={readOnly}
        name={name}
        services={services}
        onChange={onChange}
      />
    </ControlFrame>
  );
}

interface ControlBodyProps {
  readonly type: ControlType;
  readonly definition: PropertyDefinition;
  readonly value: PropertyValue;
  readonly readOnly: boolean;
  readonly name: string;
  readonly services: PropertyServices;
  readonly onChange: (value: PropertyValue) => void;
}

function ControlBody({
  type,
  definition,
  value,
  readOnly,
  name,
  services,
  onChange,
}: ControlBodyProps) {
  const t = useTranslation();
  const control = definition.control;
  switch (type) {
    case "checkbox":
      if (control?.booleanChoices !== undefined) {
        return (
          <BooleanDropdownBody
            choices={control.booleanChoices}
            value={value === true}
            readOnly={readOnly}
            name={name}
            onChange={onChange}
          />
        );
      }
      return (
        <Checkbox
          isSelected={value === true}
          isDisabled={readOnly}
          onChange={(selected) => onChange(selected)}
        >
          {control?.description === undefined ? name : t(control.description)}
        </Checkbox>
      );
    case "slider":
      if (definition.kind === "int32" || definition.kind === "double") {
        return (
          <ScalarBody
            definition={definition}
            value={value as number}
            readOnly={readOnly}
            name={name}
            onChange={onChange}
          />
        );
      }
      return (
        <AxisSliders
          definition={definition}
          value={value}
          readOnly={readOnly}
          name={name}
          onChange={onChange}
        />
      );
    case "anglePicker":
      return (
        <AngleBody
          definition={definition}
          value={value as number}
          readOnly={readOnly}
          name={name}
          onChange={onChange}
        />
      );
    case "panAndSliders":
    case "trackballAndSliders":
      return (
        <PadBody
          definition={definition}
          value={value as Vector2 | Vector3}
          readOnly={readOnly}
          name={name}
          services={services}
          circular={type === "trackballAndSliders"}
          onChange={onChange}
        />
      );
    case "incrementButton":
      return (
        <IncrementBody
          definition={definition}
          value={value as number}
          readOnly={readOnly}
          name={name}
          onChange={onChange}
        />
      );
    case "dropdown":
      return (
        <DropdownBody
          definition={definition}
          value={value}
          readOnly={readOnly}
          name={name}
          onChange={onChange}
        />
      );
    case "radioButtons":
      return (
        <RadioBody
          definition={definition}
          value={value}
          readOnly={readOnly}
          name={name}
          onChange={onChange}
        />
      );
    case "textBox":
      return (
        <TextBody
          definition={definition}
          value={value as string}
          readOnly={readOnly}
          name={name}
          onChange={onChange}
        />
      );
    case "filePicker":
    case "folderPicker":
      return (
        <PathBody
          definition={definition}
          value={value as string}
          readOnly={readOnly}
          name={name}
          services={services}
          kind={type === "filePicker" ? "file" : "folder"}
          onChange={onChange}
        />
      );
    case "colorWheel":
      return (
        <ColorBody
          definition={definition}
          value={value}
          readOnly={readOnly}
          name={name}
          onChange={onChange}
        />
      );
    case "link":
      return (
        <a
          className="prop-link"
          href={value as string}
          target="_blank"
          rel="noopener noreferrer"
          title={value as string}
        >
          {control?.description === undefined ? (value as string) : t(control.description)}
        </a>
      );
    case "label":
      return <p className="prop-value-text">{String(value)}</p>;
    default:
      return null;
  }
}

interface BodyProps {
  readonly definition: PropertyDefinition;
  readonly value: PropertyValue;
  readonly readOnly: boolean;
  readonly name: string;
  readonly onChange: (value: PropertyValue) => void;
}

function ScalarBody({
  definition,
  value,
  readOnly,
  name,
  onChange,
}: BodyProps & { value: number }) {
  const control = definition.control;
  const integer = definition.kind === "int32";
  const range = rangeOf(definition);
  const layout = useContext(ControlLayoutContext);
  if (control?.presets !== undefined) {
    return (
      <PresetComboBox
        name={name}
        value={value}
        range={range}
        presets={control.presets}
        step={stepSettings(control, range, integer).increment}
        magnitudeSteps={control.presets.every(Number.isInteger)}
        disabled={readOnly}
        onChange={onChange}
      />
    );
  }
  const percent = control?.percent ?? false;
  if (layout === "inline" && control?.openEnded === true) {
    return (
      <NumberBox
        name={name}
        value={value}
        range={range}
        step={stepSettings(control, range, integer).increment}
        decimals={decimalsOf(control, integer)}
        formatOptions={numberFormatOptions(decimalsOf(control, integer), percent)}
        magnitudeSteps={decimalsOf(control, integer) === 0 && !percent}
        disabled={readOnly}
        onChange={onChange}
      />
    );
  }
  if (layout === "inline") {
    return (
      <InlineSlider
        name={name}
        value={value}
        range={range}
        steps={stepSettings(control, range, integer)}
        exponent={exponentOf(control)}
        decimals={decimalsOf(control, integer)}
        percent={percent}
        disabled={readOnly}
        onChange={onChange}
      />
    );
  }
  return (
    <SliderRow
      name={name}
      value={value}
      range={range}
      steps={stepSettings(control, range, integer)}
      exponent={exponentOf(control)}
      wraps={control?.rangeWraps ?? false}
      background={sliderBackground(control)}
      decimals={decimalsOf(control, integer)}
      percent={percent}
      disabled={readOnly}
      onChange={onChange}
    />
  );
}

function AngleBody({ definition, value, readOnly, name, onChange }: BodyProps & { value: number }) {
  const control = definition.control;
  const range = rangeOf(definition);
  const steps = stepSettings(control, range, false);
  const decimals = decimalsOf(control, false);
  return (
    <div className="prop-angle-row">
      <AngleDial
        name={name}
        value={value}
        range={range}
        steps={steps}
        wraps={control?.rangeWraps ?? false}
        disabled={readOnly}
        onChange={onChange}
      />
      <NumberBox
        name={name}
        value={value}
        range={range}
        step={steps.increment}
        decimals={decimals}
        formatOptions={{
          style: "unit",
          unit: "degree",
          unitDisplay: "narrow",
          maximumFractionDigits: decimals,
        }}
        disabled={readOnly}
        onChange={onChange}
      />
    </div>
  );
}

interface PadBodyProps extends Omit<BodyProps, "value"> {
  readonly value: Vector2 | Vector3;
  readonly services: PropertyServices;
  readonly circular: boolean;
}

function PadBody({
  definition,
  value,
  readOnly,
  name,
  services,
  circular,
  onChange,
}: PadBodyProps) {
  const control = definition.control;
  const underlayKey = control?.staticImageUnderlay;
  const underlay = underlayKey === undefined ? undefined : services.resolveImage?.(underlayKey);
  return (
    <>
      <TwoAxisPad
        x={value.x}
        y={value.y}
        rangeX={rangeOf(definition, "x")}
        rangeY={rangeOf(definition, "y")}
        circular={circular}
        underlay={underlay}
        disabled={readOnly}
        onChange={(x, y) => onChange({ ...value, x, y })}
      />
      <AxisSliders
        definition={definition}
        value={value}
        readOnly={readOnly}
        name={name}
        onChange={onChange}
      />
    </>
  );
}

function AxisSliders({ definition, value, readOnly, name, onChange }: BodyProps) {
  const t = useTranslation();
  const control = definition.control;
  const components = value as Partial<Record<Axis, number>>;
  return (
    <>
      {axesOf(definition).map((axis) => {
        const range = rangeOf(definition, axis);
        const axisLabel = t(AXIS_LABEL[axis]);
        return (
          <div className="prop-axis-row" key={axis}>
            <span className="prop-axis-letter">{axisLabel}</span>
            <SliderRow
              name={t("property.axisLabel", { name, axis: axisLabel })}
              value={components[axis] ?? range.min}
              range={range}
              steps={stepSettings(control, range, false, axis)}
              exponent={exponentOf(control)}
              wraps={control?.rangeWraps ?? false}
              background={sliderBackground(control)}
              decimals={decimalsOf(control, false)}
              disabled={readOnly}
              onChange={(next) => onChange({ ...components, [axis]: next } as PropertyValue)}
            />
          </div>
        );
      })}
    </>
  );
}

function IncrementBody({
  definition,
  value,
  readOnly,
  name,
  onChange,
}: BodyProps & { value: number }) {
  const t = useTranslation();
  const control = definition.control;
  const range = rangeOf(definition);
  const steps = stepSettings(control, range, true);
  const wraps = control?.rangeWraps ?? false;
  return (
    <Button
      className="prop-button"
      isDisabled={readOnly}
      onPress={() => onChange(stepValue(value, steps.increment, range, wraps))}
    >
      {control?.buttonText === undefined ? name : t(control.buttonText)}
    </Button>
  );
}

function optionFor(options: readonly ChoiceOption[], key: string): ChoiceOption | undefined {
  return options.find((option) => String(option.value) === key);
}

/**
 * A drop-down button's text, as wide as the widest of the values it can show: the others sit in
 * the same grid cell, hidden, so choosing another value never moves the controls after it.
 */
function WidestText({ current, texts }: { readonly current: string; readonly texts: string[] }) {
  return (
    <span className="prop-select-text prop-select-sizer">
      <span className="prop-select-current">{current}</span>
      {[...new Set(texts)].map((text) => (
        <span key={text} className="prop-select-ghost" aria-hidden="true">
          {text}
        </span>
      ))}
    </span>
  );
}

type Translate = ReturnType<typeof useTranslation>;

/**
 * The text a compact toolbar's drop-down button shows for a value: a boolean drop-down's short
 * label, or a choice's short label after the field's inline caption ("Blend: Normal"). Undefined
 * for a value the property does not offer, or a property that is not a drop-down.
 */
export function inlineValueText(
  definition: PropertyDefinition,
  value: PropertyValue,
  t: Translate,
): string | undefined {
  const control = definition.control;
  if (definition.kind === "boolean") {
    const choices = control?.booleanChoices;
    if (choices === undefined) return undefined;
    const choice = value === true ? choices.on : choices.off;
    return t(choice.shortLabel ?? choice.label);
  }
  if (definition.kind !== "choice") return undefined;
  const option = optionFor(definition.options, String(value));
  if (option === undefined) return undefined;
  const short = t(option.shortLabel ?? option.label);
  const caption = control?.inlineCaption;
  return caption === undefined
    ? short
    : t("property.inlineTip", { name: t(caption), value: short });
}

/**
 * A toolbar drop-down's button: the chosen value's icon (or the field's own icon when values have
 * none), its short label and a chevron. The width fits the longest value, so choosing another one
 * never moves the controls after it.
 */
function InlineSelectButton({
  definition,
  options,
  selected,
}: {
  readonly definition: PropertyDefinition;
  readonly options: readonly ChoiceOption[];
  readonly selected: ChoiceOption | undefined;
}) {
  const t = useTranslation();
  const shortOf = (option: ChoiceOption) => inlineValueText(definition, option.value, t) ?? "";
  const icon = selected?.icon ?? definition.control?.icon;
  return (
    <Button className="prop-select-button is-inline">
      <SelectValue className="prop-select-value">
        {() => (
          <>
            {icon === undefined ? null : <OptionIcon path={icon} />}
            <WidestText
              current={selected === undefined ? "" : shortOf(selected)}
              texts={options.map(shortOf)}
            />
          </>
        )}
      </SelectValue>
      <DropdownChevron />
    </Button>
  );
}

/**
 * A boolean as a two-item drop-down (ControlOptions.booleanChoices): the button shows the value's
 * icon and short label ("Smoothing: On"), and the list offers both values as full phrases with
 * their icons. The keyboard and the accessible name are those of any drop-down, named by the
 * property.
 */
function BooleanDropdownBody({
  choices,
  value,
  readOnly,
  name,
  onChange,
}: {
  readonly choices: BooleanChoices;
  readonly value: boolean;
  readonly readOnly: boolean;
  readonly name: string;
  readonly onChange: (value: PropertyValue) => void;
}) {
  const t = useTranslation();
  const entries: ReadonlyArray<readonly [string, BooleanChoice]> = choices.onFirst
    ? [
        ["true", choices.on],
        ["false", choices.off],
      ]
    : [
        ["false", choices.off],
        ["true", choices.on],
      ];
  const current = value ? choices.on : choices.off;
  const text = (choice: BooleanChoice) => t(choice.shortLabel ?? choice.label);
  return (
    <Select
      aria-label={name}
      className="prop-select"
      selectedKey={String(value)}
      isDisabled={readOnly}
      onSelectionChange={(key) => {
        if (key === "true" || key === "false") onChange(key === "true");
      }}
    >
      <TooltipTrigger delay={500}>
        <Button className="prop-select-button is-inline">
          <SelectValue className="prop-select-value">
            {() => (
              <>
                <OptionIcon path={current.icon} />
                <WidestText
                  current={text(current)}
                  texts={entries.map(([, choice]) => text(choice))}
                />
              </>
            )}
          </SelectValue>
          <DropdownChevron />
        </Button>
        <Tooltip className="prop-tooltip">
          {current.tooltip === undefined ? text(current) : t(current.tooltip)}
        </Tooltip>
      </TooltipTrigger>
      <Popover className="prop-popover">
        <ListBox className="prop-listbox">
          {entries.map(([key, choice]) => (
            <ListBoxItem key={key} id={key} className="prop-option" textValue={t(choice.label)}>
              <OptionIcon path={choice.icon} />
              <span
                className="prop-option-label"
                title={choice.tooltip === undefined ? undefined : t(choice.tooltip)}
              >
                {t(choice.label)}
              </span>
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

function DropdownBody({ definition, value, readOnly, name, onChange }: BodyProps) {
  const t = useTranslation();
  const layout = useContext(ControlLayoutContext);
  if (definition.kind !== "choice") return null;
  const labels = definition.options.map((option) => t(option.label));
  const widest = Math.max(0, ...labels.map((label) => label.length));
  const multiline = definition.control?.multiline ?? false;
  const inline = layout === "inline";
  const selectedIndex = definition.options.findIndex(
    (option) => String(option.value) === String(value),
  );
  const selected = definition.options[selectedIndex];
  const button = inline ? (
    <InlineSelectButton options={definition.options} selected={selected} definition={definition} />
  ) : (
    <Button className="prop-select-button" style={{ minWidth: `${widest + 3}ch` }}>
      <SelectValue className="prop-select-value" />
      <DropdownChevron />
    </Button>
  );
  return (
    <Select
      aria-label={name}
      className="prop-select"
      selectedKey={String(value)}
      isDisabled={readOnly}
      onSelectionChange={(key) => {
        const option = optionFor(definition.options, String(key));
        if (option !== undefined) onChange(option.value);
      }}
    >
      {inline ? (
        <TooltipTrigger delay={500}>
          {button}
          <Tooltip className="prop-tooltip">
            {t("property.inlineTip", { name, value: labels[selectedIndex] ?? "" })}
          </Tooltip>
        </TooltipTrigger>
      ) : (
        button
      )}
      <Popover className="prop-popover">
        <ListBox className={multiline ? "prop-listbox is-multiline" : "prop-listbox"}>
          {definition.options.map((option, index) => (
            <ListBoxItem
              key={String(option.value)}
              id={String(option.value)}
              className="prop-option"
              isDisabled={option.disabled === true}
              textValue={labels[index]}
            >
              {option.icon === undefined ? null : <OptionIcon path={option.icon} />}
              <span
                className="prop-option-label"
                title={option.tooltip === undefined ? undefined : t(option.tooltip)}
              >
                {labels[index]}
              </span>
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

function RadioBody({ definition, value, readOnly, name, onChange }: BodyProps) {
  const t = useTranslation();
  if (definition.kind !== "choice") return null;
  const grid = definition.control?.choiceGrid;
  if (grid !== undefined) {
    return (
      <ChoiceGridBody
        definition={definition}
        grid={grid}
        value={value}
        readOnly={readOnly}
        name={name}
        onChange={onChange}
      />
    );
  }
  return (
    <RadioGroup
      aria-label={name}
      className="prop-radio-group"
      value={String(value)}
      isDisabled={readOnly}
      onChange={(key) => {
        const option = optionFor(definition.options, key);
        if (option !== undefined) onChange(option.value);
      }}
    >
      {definition.options.map((option) => (
        <Radio
          key={String(option.value)}
          value={String(option.value)}
          className="prop-radio"
          isDisabled={option.disabled === true}
        >
          {t(option.label)}
        </Radio>
      ))}
    </RadioGroup>
  );
}

function TextBody({ definition, value, readOnly, name, onChange }: BodyProps & { value: string }) {
  const multiline = definition.control?.multiline ?? false;
  return (
    <TextField
      aria-label={name}
      className="prop-text"
      value={value}
      isDisabled={readOnly}
      maxLength={definition.kind === "string" ? definition.maxLength : undefined}
      onChange={(next) => onChange(next)}
    >
      {multiline ? <TextArea className="prop-input" rows={4} /> : <Input className="prop-input" />}
    </TextField>
  );
}

function PathBody({
  definition,
  value,
  readOnly,
  name,
  services,
  kind,
  onChange,
}: BodyProps & { value: string; services: PropertyServices; kind: "file" | "folder" }) {
  const t = useTranslation();
  const control = definition.control;
  const pick = kind === "file" ? services.pickFile : services.pickFolder;
  return (
    <div className="prop-path-row">
      <TextField
        aria-label={name}
        className="prop-text"
        value={value}
        isDisabled={readOnly}
        onChange={(next) => onChange(next)}
      >
        <Input className="prop-input" />
      </TextField>
      {pick !== undefined && (
        <Button
          className="prop-browse"
          isDisabled={readOnly}
          onPress={() => {
            const chosen =
              kind === "file"
                ? services.pickFile?.({
                    fileTypes: control?.fileTypes ?? [],
                    allowAllFiles: control?.allowAllFiles ?? false,
                  })
                : services.pickFolder?.();
            chosen?.then((path) => {
              if (path !== undefined) onChange(path);
            });
          }}
        >
          {t("property.browse")}
        </Button>
      )}
    </div>
  );
}

function ColorBody({ definition, value, readOnly, onChange }: BodyProps) {
  const t = useTranslation();
  const packed = definition.kind === "int32";
  const alphaShown = definition.kind === "color" && definition.alphaMode === "supportsAlpha";
  const color: ColorValue = packed
    ? { ...unpackRgb(value as number), a: 1 }
    : (value as ColorValue);
  const hsv = rgbToHsv(color);
  const swatch = `rgba(${toByte(color.r)}, ${toByte(color.g)}, ${toByte(color.b)}, ${color.a})`;
  const commit = (next: ColorValue) => onChange(packed ? packRgb(next) : next);
  const withHsv = (h: number, s: number, v: number): ColorValue => ({
    ...hsvToRgb({ h, s, v }),
    a: color.a,
  });
  const percent: Range = { min: 0, max: 100 };
  const channel: Range = { min: 0, max: 255 };
  return (
    <div className="prop-color">
      <ColorWheel
        hue={hsv.h}
        saturation={hsv.s}
        color={swatch}
        disabled={readOnly}
        onPick={(h, s) => commit(withHsv(h, s, hsv.v))}
      />
      <div className="prop-color-fields">
        <span
          role="img"
          aria-label={t("property.swatch")}
          className="prop-swatch"
          style={{ background: swatch }}
        />
        <SliderRow
          name={t("colors.name.saturation")}
          value={hsv.s * 100}
          range={percent}
          steps={stepSettings(undefined, percent, true)}
          wraps={false}
          decimals={0}
          disabled={readOnly}
          onChange={(s) => commit(withHsv(hsv.h, s / 100, hsv.v))}
        />
        <SliderRow
          name={t("colors.name.value")}
          value={hsv.v * 100}
          range={percent}
          steps={stepSettings(undefined, percent, true)}
          wraps={false}
          decimals={0}
          disabled={readOnly}
          onChange={(v) => commit(withHsv(hsv.h, hsv.s, v / 100))}
        />
        {alphaShown && (
          <SliderRow
            name={t("colors.name.alpha")}
            value={color.a * 255}
            range={channel}
            steps={stepSettings(undefined, channel, true)}
            wraps={false}
            decimals={0}
            disabled={readOnly}
            onChange={(a) => commit({ ...color, a: a / 255 })}
          />
        )}
        <div className="prop-channels">
          <NumberBox
            name={t("colors.name.red")}
            value={toByte(color.r)}
            range={channel}
            step={1}
            decimals={0}
            disabled={readOnly}
            onChange={(r) => commit({ ...color, r: r / 255 })}
          />
          <NumberBox
            name={t("colors.name.green")}
            value={toByte(color.g)}
            range={channel}
            step={1}
            decimals={0}
            disabled={readOnly}
            onChange={(g) => commit({ ...color, g: g / 255 })}
          />
          <NumberBox
            name={t("colors.name.blue")}
            value={toByte(color.b)}
            range={channel}
            step={1}
            decimals={0}
            disabled={readOnly}
            onChange={(b) => commit({ ...color, b: b / 255 })}
          />
        </div>
      </div>
    </div>
  );
}
