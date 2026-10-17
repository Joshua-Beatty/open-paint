import {
  autoLevelParams,
  type EffectSource,
  LEVELS_GAMMA_MAX,
  LEVELS_GAMMA_MIN,
  LEVELS_IDENTITY,
  type LevelsParams,
  levelsHistogram,
  levelsLut,
  levelsParams,
  levelsValues,
} from "@openpaint/effects";
import { useTranslation } from "@openpaint/i18n/react";
import { useEffect, useState } from "react";
import { Button, Checkbox, Form, Input, NumberField } from "react-aria-components";
import { ColorPickerDialog } from "../../colors/ColorPickerDialog";
import type { Rgba } from "../../colors/color-math";
import { ModalDialog } from "../../shell/ModalDialog";
import type { CustomDialogProps } from "../custom-dialog-types";
import { GradientSlider } from "./GradientSlider";
import { LevelsHistogram } from "./LevelsHistogram";
import {
  ALL_CHANNELS,
  BINS,
  type ChannelMask,
  channelMean,
  constrainNub,
  gammaForMean,
  gammaFromMid,
  type LevelsField,
  lutValue,
  midNubPosition,
  outputHistogram,
  SHOWN_MAX,
  setShownValue,
  shownValue,
} from "./levels-model";
import "./levels-dialog.css";

type PointField = "inputBlack" | "inputWhite" | "outputBlack" | "outputWhite";

/** What a swatch's double-click picks: one point, or the mid swatch that sets the gamma. */
type PickTarget = PointField | "mid";

interface Picker {
  readonly target: PickTarget;
  readonly initial: Rgba;
}

/** Shown while the input histogram is computed: a flat distribution (ADJ-LEVELS-UI-06). */
const FLAT_HISTOGRAM = new Uint32Array(3 * BINS).fill(1);

/**
 * The Levels dialog (ADJ-LEVELS-UI): a custom editor for the Levels parameters, with the live
 * preview of every change. The input histogram comes from the pixels the effect reads, over the
 * selection. The output histogram is the input re-binned through the same Levels table that the
 * render uses.
 */
export function LevelsDialog({
  values,
  source,
  onValuesChange,
  onOk,
  onCancel,
}: CustomDialogProps) {
  const t = useTranslation();
  const [params, setParams] = useState<LevelsParams>(() => levelsParams(values));
  const [mask, setMask] = useState<ChannelMask>(ALL_CHANNELS);
  const [picker, setPicker] = useState<Picker | undefined>(undefined);
  const inputHistogram = useInputHistogram(source);
  const histogram = inputHistogram ?? FLAT_HISTOGRAM;
  const lut = levelsLut(params);
  const outputBins = outputHistogram(histogram, lut);
  const inputMeans = [0, 1, 2].map((channel) => channelMean(histogram, channel) / SHOWN_MAX);
  const outputMeans = [0, 1, 2].map((channel) =>
    channelMean(histogram, channel, (value) => lutValue(lut, channel, value)),
  );
  const anyChecked = mask.some((checked) => checked);

  const update = (next: LevelsParams) => {
    setParams(next);
    onValuesChange(levelsValues(next));
  };
  const shown = (field: LevelsField) => shownValue(params, field, mask) ?? 0;

  const inputNubs = [shown("inputBlack"), shown("inputWhite")];
  const outputLow = shown("outputBlack");
  const outputHigh = shown("outputWhite");
  const outputNubs = [outputLow, midNubPosition(outputLow, outputHigh, shown("gamma")), outputHigh];

  const changeInputNub = (index: number, raw: number) => {
    const value = Math.round(constrainNub(index, raw, inputNubs));
    update(setShownValue(params, index === 0 ? "inputBlack" : "inputWhite", mask, value));
  };

  const changeOutputNub = (index: number, raw: number) => {
    const value = constrainNub(index, raw, outputNubs);
    if (index === 1) {
      update(setShownValue(params, "gamma", mask, gammaFromMid(value, outputLow, outputHigh)));
      return;
    }
    const field = index === 0 ? "outputBlack" : "outputWhite";
    update(setShownValue(params, field, mask, Math.round(value)));
  };

  const finishPicker = (color: Rgba) => {
    const target = picker?.target;
    setPicker(undefined);
    if (target === undefined) return;
    if (target === "mid") {
      const gamma = [0, 1, 2].map((channel) =>
        gammaForMean(
          inputMeans[channel] ?? 0,
          params.inputBlack[channel] ?? 0,
          params.inputWhite[channel] ?? 0,
          params.outputBlack[channel] ?? 0,
          params.outputWhite[channel] ?? 0,
          (pickOf(color, channel) ?? 0) / SHOWN_MAX,
        ),
      );
      update({ ...params, gamma: toTriple(gamma) });
      return;
    }
    const point = [color.r / SHOWN_MAX, color.g / SHOWN_MAX, color.b / SHOWN_MAX];
    update({ ...params, [target]: toTriple(point) });
  };

  const openPoint = (field: PointField) => {
    setPicker({ target: field, initial: colorOf(params[field]) });
  };

  const openMid = () => {
    setPicker({
      target: "mid",
      initial: {
        r: round(outputMeans[0] ?? 0),
        g: round(outputMeans[1] ?? 0),
        b: round(outputMeans[2] ?? 0),
        a: SHOWN_MAX,
      },
    });
  };

  return (
    <>
      <ModalDialog
        isOpen
        title={t("levels.dialog.title")}
        onClose={onCancel}
        wide
        backdrop="clear"
        preview
      >
        <Form
          className="levels-form"
          onSubmit={(event) => {
            event.preventDefault();
            onOk(levelsValues(params));
          }}
        >
          <div className="levels-body">
            <div className="levels-column levels-histogram-column">
              <h3 className="levels-heading">{t("levels.group.inputHistogram")}</h3>
              <div className="levels-histogram-wrap" title={t("levels.tip.inputHistogram")}>
                <LevelsHistogram
                  histogram={histogram}
                  mirrored
                  mask={mask}
                  title={t("levels.group.inputHistogram")}
                />
              </div>
            </div>
            <div className="levels-column levels-input">
              <h3 className="levels-heading">{t("levels.group.input")}</h3>
              <LevelsSpin
                label={t("levels.label.inputWhite")}
                title={t("levels.tip.inputWhite")}
                value={shown("inputWhite")}
                min={0}
                max={SHOWN_MAX}
                decimals={0}
                disabled={!anyChecked}
                onChange={(value) =>
                  update(setShownValue(params, "inputWhite", mask, Math.round(value)))
                }
              />
              <Swatch
                title={t("levels.tip.inputWhite")}
                color={colorOf(params.inputWhite)}
                onOpen={() => openPoint("inputWhite")}
              />
              <GradientSlider
                label={t("levels.label.inputGradient")}
                nubs={inputNubs}
                maxColor={maxColor(mask)}
                disabled={!anyChecked}
                onNubChange={changeInputNub}
              />
              <Swatch
                title={t("levels.tip.inputBlack")}
                color={colorOf(params.inputBlack)}
                onOpen={() => openPoint("inputBlack")}
              />
              <LevelsSpin
                label={t("levels.label.inputBlack")}
                title={t("levels.tip.inputBlack")}
                value={shown("inputBlack")}
                min={0}
                max={SHOWN_MAX}
                decimals={0}
                disabled={!anyChecked}
                onChange={(value) =>
                  update(setShownValue(params, "inputBlack", mask, Math.round(value)))
                }
              />
            </div>
            <div className="levels-column levels-output">
              <h3 className="levels-heading">{t("levels.group.output")}</h3>
              <div className="levels-output-row">
                <GradientSlider
                  label={t("levels.label.outputGradient")}
                  nubs={outputNubs}
                  maxColor={maxColor(mask)}
                  disabled={!anyChecked}
                  onNubChange={changeOutputNub}
                />
                <div className="levels-output-stack">
                  <LevelsSpin
                    label={t("levels.label.outputWhite")}
                    title={t("levels.tip.outputWhite")}
                    value={shown("outputWhite")}
                    min={0}
                    max={SHOWN_MAX}
                    decimals={0}
                    disabled={!anyChecked}
                    onChange={(value) =>
                      update(setShownValue(params, "outputWhite", mask, Math.round(value)))
                    }
                  />
                  <Swatch
                    title={t("levels.tip.outputWhite")}
                    color={colorOf(params.outputWhite)}
                    onOpen={() => openPoint("outputWhite")}
                  />
                  <LevelsSpin
                    label={t("levels.label.gamma")}
                    title={t("levels.tip.gamma")}
                    value={shown("gamma")}
                    min={LEVELS_GAMMA_MIN}
                    max={LEVELS_GAMMA_MAX}
                    decimals={2}
                    step={0.1}
                    disabled={!anyChecked}
                    onChange={(value) => update(setShownValue(params, "gamma", mask, value))}
                  />
                  <Swatch
                    title={t("levels.tip.midPoint")}
                    color={{
                      r: round(outputMeans[0] ?? 0),
                      g: round(outputMeans[1] ?? 0),
                      b: round(outputMeans[2] ?? 0),
                      a: SHOWN_MAX,
                    }}
                    onOpen={openMid}
                  />
                  <Swatch
                    title={t("levels.tip.outputBlack")}
                    color={colorOf(params.outputBlack)}
                    onOpen={() => openPoint("outputBlack")}
                  />
                  <LevelsSpin
                    label={t("levels.label.outputBlack")}
                    title={t("levels.tip.outputBlack")}
                    value={shown("outputBlack")}
                    min={0}
                    max={SHOWN_MAX}
                    decimals={0}
                    disabled={!anyChecked}
                    onChange={(value) =>
                      update(setShownValue(params, "outputBlack", mask, Math.round(value)))
                    }
                  />
                </div>
              </div>
            </div>
            <div className="levels-column levels-histogram-column">
              <h3 className="levels-heading">{t("levels.group.outputHistogram")}</h3>
              <div className="levels-histogram-wrap" title={t("levels.tip.outputHistogram")}>
                <LevelsHistogram
                  histogram={outputBins}
                  mirrored={false}
                  mask={mask}
                  title={t("levels.group.outputHistogram")}
                />
              </div>
            </div>
          </div>
          <div className="levels-footer">
            <div className="levels-footer-left">
              <span title={t("levels.tip.auto")}>
                <Button
                  className="react-aria-Button levels-button"
                  onPress={() => {
                    if (source !== undefined) {
                      update(autoLevelParams(source.pixels, source.coverage));
                    }
                  }}
                >
                  {t("levels.button.auto")}
                </Button>
              </span>
              <Button
                className="react-aria-Button levels-button"
                onPress={() => update(LEVELS_IDENTITY)}
              >
                {t("levels.button.reset")}
              </Button>
            </div>
            <div className="levels-channels">
              <ChannelCheck
                channel={0}
                label={t("levels.channel.red")}
                title={t("levels.tip.red")}
                mask={mask}
                onChange={setMask}
              />
              <ChannelCheck
                channel={1}
                label={t("levels.channel.green")}
                title={t("levels.tip.green")}
                mask={mask}
                onChange={setMask}
              />
              <ChannelCheck
                channel={2}
                label={t("levels.channel.blue")}
                title={t("levels.tip.blue")}
                mask={mask}
                onChange={setMask}
              />
            </div>
            <div className="levels-footer-right">
              <Button className="react-aria-Button levels-button" onPress={onCancel}>
                {t("dialog.cancel")}
              </Button>
              <Button type="submit" className="react-aria-Button levels-button is-default">
                {t("dialog.ok")}
              </Button>
            </div>
          </div>
        </Form>
      </ModalDialog>
      {picker !== undefined && (
        <ColorPickerDialog
          initial={picker.initial}
          onOk={finishPicker}
          onCancel={() => setPicker(undefined)}
        />
      )}
    </>
  );
}

/** The input histogram of the source, computed after the first paint (ADJ-LEVELS-UI-06). */
function useInputHistogram(source: EffectSource | undefined): Uint32Array | undefined {
  const [histogram, setHistogram] = useState<Uint32Array | undefined>(undefined);
  useEffect(() => {
    if (source === undefined) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      if (live) setHistogram(levelsHistogram(source.pixels, source.coverage));
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source]);
  return histogram;
}

interface LevelsSpinProps {
  readonly label: string;
  readonly title: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly decimals: number;
  readonly disabled: boolean;
  readonly onChange: (value: number) => void;
}

/** A numeric spinner (ADJ-LEVELS-UI-02) with its tooltip. Only a finite value reaches `onChange`. */
function LevelsSpin({
  label,
  title,
  value,
  min,
  max,
  step = 1,
  decimals,
  disabled,
  onChange,
}: LevelsSpinProps) {
  return (
    <div className="levels-spin-wrap" title={title}>
      <NumberField
        className="levels-spin"
        value={value}
        minValue={min}
        maxValue={max}
        step={step}
        isDisabled={disabled}
        formatOptions={{ minimumFractionDigits: decimals, maximumFractionDigits: decimals }}
        onChange={(next) => {
          if (Number.isFinite(next)) onChange(next);
        }}
      >
        <Input aria-label={label} />
      </NumberField>
    </div>
  );
}

interface SwatchProps {
  readonly title: string;
  readonly color: Rgba;
  readonly onOpen: () => void;
}

/**
 * A color swatch (ADJ-LEVELS-UI-04). A double-click opens the color picker. Enter and Space
 * open it too: a keyboard-initiated click has detail 0, so it is told apart from a pointer click.
 */
function Swatch({ title, color, onOpen }: SwatchProps) {
  return (
    <button
      type="button"
      className="levels-swatch"
      title={title}
      aria-label={title}
      style={{ background: `rgb(${color.r}, ${color.g}, ${color.b})` }}
      onClick={(event) => {
        if (event.detail === 0) onOpen();
      }}
      onDoubleClick={onOpen}
    />
  );
}

interface ChannelCheckProps {
  readonly channel: number;
  readonly label: string;
  readonly title: string;
  readonly mask: ChannelMask;
  readonly onChange: (mask: ChannelMask) => void;
}

/** One of the R, G and B checkboxes (ADJ-LEVELS-UI-05). */
function ChannelCheck({ channel, label, title, mask, onChange }: ChannelCheckProps) {
  return (
    <span title={title}>
      <Checkbox
        isSelected={mask[channel] === true}
        onChange={(selected) => onChange(withChannel(mask, channel, selected))}
      >
        {label}
      </Checkbox>
    </span>
  );
}

function withChannel(mask: ChannelMask, channel: number, selected: boolean): ChannelMask {
  return [
    channel === 0 ? selected : mask[0],
    channel === 1 ? selected : mask[1],
    channel === 2 ? selected : mask[2],
  ];
}

/** The gradient's top color: the checked channels as a color (ADJ-LEVELS-UI-03). */
function maxColor(mask: ChannelMask): string {
  return `rgb(${mask[0] ? 255 : 0}, ${mask[1] ? 255 : 0}, ${mask[2] ? 255 : 0})`;
}

/** The swatch color of one point: its three channels as 0..255. */
function colorOf(triple: readonly [number, number, number]): Rgba {
  return {
    r: round((triple[0] ?? 0) * SHOWN_MAX),
    g: round((triple[1] ?? 0) * SHOWN_MAX),
    b: round((triple[2] ?? 0) * SHOWN_MAX),
    a: SHOWN_MAX,
  };
}

function pickOf(color: Rgba, channel: number): number | undefined {
  return [color.r, color.g, color.b][channel];
}

function toTriple(values: readonly number[]): [number, number, number] {
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}

function round(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), SHOWN_MAX));
}
