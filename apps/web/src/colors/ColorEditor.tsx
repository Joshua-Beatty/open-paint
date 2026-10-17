import { useTranslation } from "@openpaint/i18n/react";
import { useEffect, useState } from "react";
import {
  Input,
  Label,
  NumberField,
  Slider,
  SliderThumb,
  SliderTrack,
  TextField,
} from "react-aria-components";
import { ColorWheel } from "./ColorWheel";
import {
  type Hsv,
  hsvToRgb,
  parseRgbHex,
  type Rgba,
  rgbHex,
  rgbToHsv,
  type SliderChannel,
  sliderBackground,
} from "./color-math";

export interface ColorEditorProps {
  /** The color being edited. */
  readonly color: Rgba;
  /** The other color, shown as a second nub on the wheel while it is dragged. */
  readonly other?: Rgba;
  readonly onChange: (color: Rgba) => void;
}

interface SliderRowProps {
  readonly label: string;
  readonly name: string;
  readonly channel: SliderChannel;
  readonly color: Rgba;
  readonly value: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}

/** A slider with a spin box. Both edit the same value (UI-FTW-06). */
function SliderRow({ label, name, channel, color, value, max, onChange }: SliderRowProps) {
  return (
    <div className="color-slider-row">
      <Slider
        className="color-slider"
        aria-label={name}
        value={value}
        minValue={0}
        maxValue={max}
        step={1}
        onChange={onChange}
      >
        <Label>{label}</Label>
        <SliderTrack
          className="color-slider-track"
          style={{ background: sliderBackground(channel, color) }}
        >
          <SliderThumb />
        </SliderTrack>
      </Slider>
      <NumberField
        className="color-spin"
        value={value}
        minValue={0}
        maxValue={max}
        step={1}
        onChange={(next) => {
          if (Number.isFinite(next)) onChange(next);
        }}
      >
        <Input aria-label={name} />
      </NumberField>
    </div>
  );
}

interface HexFieldProps {
  readonly color: Rgba;
  readonly onChange: (color: Rgba) => void;
}

/** "Hex:" with six digits RRGGBB. A leading "#" is accepted and invalid text reverts on blur. */
function HexField({ color, onChange }: HexFieldProps) {
  const t = useTranslation();
  const hex = rgbHex(color);
  const [draft, setDraft] = useState(hex);
  useEffect(() => setDraft(hex), [hex]);
  const commit = () => {
    const parsed = parseRgbHex(draft);
    if (parsed === null) {
      setDraft(hex);
      return;
    }
    onChange({ ...parsed, a: color.a });
  };
  return (
    <TextField className="color-hex" value={draft} onChange={setDraft} maxLength={7}>
      <Label>{t("colors.label.hex")}</Label>
      <Input
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </TextField>
  );
}

/**
 * The expanded part of the Colors panel (UI-FTW-06): the HSV wheel and the hex box on the left,
 * and the RGB, HSV and alpha sliders with spin boxes on the right, side by side so the expanded
 * panel stays short. They all edit one color and stay in step with each other.
 */
export function ColorEditor({ color, other, onChange }: ColorEditorProps) {
  const t = useTranslation();
  const hsv: Hsv = rgbToHsv(color);
  const setHsv = (patch: Partial<Hsv>) => onChange(hsvToRgb({ ...hsv, ...patch }, color.a));
  const setRgb = (patch: Partial<Rgba>) => onChange({ ...color, ...patch });
  return (
    <div className="color-editor">
      <div className="color-editor-picker">
        <ColorWheel color={color} other={other} onChange={onChange} label={t("colors.wheel")} />
        <HexField color={color} onChange={onChange} />
      </div>
      <div className="color-editor-bars">
        <div className="color-group">
          <h3 className="color-group-heading">{t("colors.group.rgb")}</h3>
          <SliderRow
            label={t("colors.label.red")}
            name={t("colors.name.red")}
            channel="r"
            color={color}
            value={color.r}
            max={255}
            onChange={(r) => setRgb({ r })}
          />
          <SliderRow
            label={t("colors.label.green")}
            name={t("colors.name.green")}
            channel="g"
            color={color}
            value={color.g}
            max={255}
            onChange={(g) => setRgb({ g })}
          />
          <SliderRow
            label={t("colors.label.blue")}
            name={t("colors.name.blue")}
            channel="b"
            color={color}
            value={color.b}
            max={255}
            onChange={(b) => setRgb({ b })}
          />
        </div>
        <div className="color-group">
          <h3 className="color-group-heading">{t("colors.group.hsv")}</h3>
          <SliderRow
            label={t("colors.label.hue")}
            name={t("colors.name.hue")}
            channel="h"
            color={color}
            value={Math.round(hsv.h)}
            max={360}
            onChange={(h) => setHsv({ h })}
          />
          <SliderRow
            label={t("colors.label.saturation")}
            name={t("colors.name.saturation")}
            channel="s"
            color={color}
            value={Math.round(hsv.s)}
            max={100}
            onChange={(s) => setHsv({ s })}
          />
          <SliderRow
            label={t("colors.label.value")}
            name={t("colors.name.value")}
            channel="v"
            color={color}
            value={Math.round(hsv.v)}
            max={100}
            onChange={(v) => setHsv({ v })}
          />
        </div>
        <div className="color-group">
          <h3 className="color-group-heading">{t("colors.group.alpha")}</h3>
          <SliderRow
            label={t("colors.label.alpha")}
            name={t("colors.name.alpha")}
            channel="a"
            color={color}
            value={color.a}
            max={255}
            onChange={(a) => setRgb({ a })}
          />
        </div>
      </div>
    </div>
  );
}
