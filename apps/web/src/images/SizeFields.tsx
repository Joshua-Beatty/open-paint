import { MAX_RESOLUTION, MIN_RESOLUTION, type PhysicalUnit, type Size } from "@openpaint/document";
import { useTranslation } from "@openpaint/i18n/react";
import {
  Button,
  Checkbox,
  Input,
  ListBox,
  ListBoxItem,
  NumberField,
  Popover,
  Radio,
  RadioGroup,
  Select,
  SelectValue,
} from "react-aria-components";
import {
  displayedSize,
  MAX_SPINNER_VALUE,
  PERCENT_MAX,
  PERCENT_MIN,
  printSize,
  type SizeDraft,
  withDotsPerUnit,
  withHeight,
  withMode,
  withPercent,
  withPrintHeight,
  withPrintWidth,
  withUnit,
  withWidth,
} from "./size-draft";

const DECIMALS = { maximumFractionDigits: 2 };

export interface SizeFieldsProps {
  /** The document's size before the change. Aspect ratio and percentages refer to it. */
  readonly current: Size;
  readonly draft: SizeDraft;
  readonly onChange: (next: SizeDraft) => void;
  /** Resize and Canvas Size offer "By percentage" as well as typed pixels (DOC-IMG-02/03). */
  readonly percentage: boolean;
}

/**
 * The size, percentage, print-size and resolution controls shared by New, Resize and Canvas Size
 * (DOC-NEW-01, DOC-IMG-02, DOC-IMG-03). Values that are out of range stay in the draft and turn OK
 * off; they are not clamped while the user types (DOC-DOC-01).
 */
export function SizeFields({ current, draft, onChange, percentage }: SizeFieldsProps) {
  const t = useTranslation();
  const shown = displayedSize(draft, current);
  const print = printSize(draft, current);
  const typed = draft.mode === "pixels";
  return (
    <div className="image-size-fields">
      {percentage && (
        <RadioGroup
          aria-label={t("image.sizeFields.pixelSize")}
          className="image-size-mode"
          value={draft.mode}
          onChange={(mode) =>
            onChange(withMode(draft, current, mode === "percent" ? "percent" : "pixels"))
          }
        >
          <div className="image-size-row">
            <Radio value="percent">{t("image.sizeFields.byPercentage")}</Radio>
            <NumberField
              aria-label={t("image.sizeFields.percentage")}
              value={draft.percent}
              minValue={PERCENT_MIN}
              maxValue={PERCENT_MAX}
              isDisabled={typed}
              onChange={(percent) => onChange(withPercent(draft, percent))}
            >
              <Input />
            </NumberField>
          </div>
          <Radio value="pixels">{t("image.sizeFields.byAbsoluteSize")}</Radio>
        </RadioGroup>
      )}
      <h3 className="image-size-heading">{t("image.sizeFields.pixelSize")}</h3>
      <div className="image-size-row">
        <NumberField
          aria-label={t("image.sizeFields.width")}
          value={shown.width}
          maxValue={MAX_SPINNER_VALUE}
          step={1}
          isDisabled={!typed}
          onChange={(width) => onChange(withWidth(draft, current, width))}
        >
          <Input />
        </NumberField>
        <NumberField
          aria-label={t("image.sizeFields.height")}
          value={shown.height}
          maxValue={MAX_SPINNER_VALUE}
          step={1}
          isDisabled={!typed}
          onChange={(height) => onChange(withHeight(draft, current, height))}
        >
          <Input />
        </NumberField>
      </div>
      <Checkbox
        isSelected={draft.keepAspect}
        onChange={(keepAspect) => onChange({ ...draft, keepAspect })}
      >
        {t("image.sizeFields.keepAspect")}
      </Checkbox>
      <h3 className="image-size-heading">{t("image.sizeFields.printSize")}</h3>
      <div className="image-size-row">
        <NumberField
          aria-label={t("image.sizeFields.resolution")}
          value={draft.dotsPerUnit}
          minValue={MIN_RESOLUTION}
          maxValue={MAX_RESOLUTION}
          formatOptions={DECIMALS}
          onChange={(dots) => onChange(withDotsPerUnit(draft, dots))}
        >
          <Input />
        </NumberField>
        <UnitSelect
          label={t("image.sizeFields.resolutionUnit")}
          value={draft.unit}
          options={{
            inch: t("image.sizeFields.pixelsPerInch"),
            centimeter: t("image.sizeFields.pixelsPerCentimeter"),
          }}
          onChange={(unit) => onChange(withUnit(draft, unit))}
        />
      </div>
      <div className="image-size-row">
        <NumberField
          aria-label={t("image.sizeFields.printWidth")}
          value={print.width}
          minValue={0}
          formatOptions={DECIMALS}
          onChange={(length) => onChange(withPrintWidth(draft, current, length))}
        >
          <Input />
        </NumberField>
        <NumberField
          aria-label={t("image.sizeFields.printHeight")}
          value={print.height}
          minValue={0}
          formatOptions={DECIMALS}
          onChange={(length) => onChange(withPrintHeight(draft, current, length))}
        >
          <Input />
        </NumberField>
        <UnitSelect
          label={t("image.sizeFields.printUnit")}
          value={draft.unit}
          options={{
            inch: t("image.sizeFields.inches"),
            centimeter: t("image.sizeFields.centimeters"),
          }}
          onChange={(unit) => onChange(withUnit(draft, unit))}
        />
      </div>
    </div>
  );
}

interface UnitSelectProps {
  readonly label: string;
  readonly value: PhysicalUnit;
  readonly options: Readonly<Record<PhysicalUnit, string>>;
  readonly onChange: (unit: PhysicalUnit) => void;
}

function UnitSelect({ label, value, options, onChange }: UnitSelectProps) {
  return (
    <Select
      aria-label={label}
      selectedKey={value}
      onSelectionChange={(key) => {
        if (key === "inch" || key === "centimeter") onChange(key);
      }}
    >
      <Button>
        <SelectValue />
      </Button>
      <Popover>
        <ListBox>
          <ListBoxItem id="inch">{options.inch}</ListBoxItem>
          <ListBoxItem id="centimeter">{options.centimeter}</ListBoxItem>
        </ListBox>
      </Popover>
    </Select>
  );
}
