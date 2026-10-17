import {
  BLACK,
  CANVAS_ANCHORS,
  type CanvasAnchor,
  type ColorRgba8,
  convertDotsPerUnit,
  DEFAULT_DPI,
  isValidResolution,
  MAX_IMAGE_SIZE,
  MIN_IMAGE_SIZE,
  type PhysicalUnit,
  type ResampleFilter,
  type Resolution,
  rgba8,
  type Size,
  TRANSPARENT,
  WHITE,
} from "@openpaint/document";
import type { MessageId, Translate } from "@openpaint/i18n";
import type { Rgba } from "../colors/color-math";

/** The largest value the spinners accept while typing (validated on OK, DOC-DOC-01). */
export const MAX_SPINNER_VALUE = 2_147_483_647;
/** The percentage spinner range of Resize and Canvas Size (DOC-IMG-02 proposal). */
export const PERCENT_MIN = 0.01;
export const PERCENT_MAX = 2000;

/** The Resize resampling choices in dialog order. Super Sampling is not offered here (DOC-IMG-02). */
export const RESIZE_RESAMPLING_CHOICES = [
  "adaptive",
  "bicubic",
  "bicubicSmooth",
  "bilinear",
  "bilinearLowQuality",
  "lanczos3",
  "fant",
  "nearest",
] as const satisfies readonly ResampleFilter[];

export type ResizeResampling = (typeof RESIZE_RESAMPLING_CHOICES)[number];

/** The resampling from `workspace.lastResampling`, with Bicubic for anything not offered here. */
export function resamplingFromSetting(value: unknown): ResizeResampling {
  return RESIZE_RESAMPLING_CHOICES.find((choice) => choice === value) ?? "bicubic";
}

/** "Use gamma correction" is the Linear setting (resample in linear light), as DOC-IMG-02 says. */
export function linearLightFromSetting(value: unknown): boolean {
  return value !== "Companded";
}

export function gammaSetting(linearLight: boolean): "Linear" | "Companded" {
  return linearLight ? "Linear" : "Companded";
}

export const RESIZE_RESAMPLING_MESSAGES: Readonly<Record<ResizeResampling, MessageId>> = {
  adaptive: "image.resampling.adaptive",
  bicubic: "image.resampling.bicubic",
  bicubicSmooth: "image.resampling.bicubicSmooth",
  bilinear: "image.resampling.bilinear",
  bilinearLowQuality: "image.resampling.bilinearLowQuality",
  lanczos3: "image.resampling.lanczos3",
  fant: "image.resampling.fant",
  nearest: "image.resampling.nearest",
};

/** The settings values of `workspace.lastCanvasSizeAnchor`, one per anchor (DOC-IMG-03). */
const ANCHOR_SETTINGS: Readonly<Record<CanvasAnchor, string>> = {
  topLeft: "TopLeft",
  top: "Top",
  topRight: "TopRight",
  left: "Left",
  center: "Middle",
  right: "Right",
  bottomLeft: "BottomLeft",
  bottom: "Bottom",
  bottomRight: "BottomRight",
};

export const CANVAS_ANCHOR_MESSAGES: Readonly<Record<CanvasAnchor, MessageId>> = {
  topLeft: "image.anchor.topLeft",
  top: "image.anchor.top",
  topRight: "image.anchor.topRight",
  left: "image.anchor.left",
  center: "image.anchor.center",
  right: "image.anchor.right",
  bottomLeft: "image.anchor.bottomLeft",
  bottom: "image.anchor.bottom",
  bottomRight: "image.anchor.bottomRight",
};

/** The anchor from its setting, with Top Left for an unknown value. */
export function anchorFromSetting(value: unknown): CanvasAnchor {
  return CANVAS_ANCHORS.find((anchor) => ANCHOR_SETTINGS[anchor] === value) ?? "topLeft";
}

export function anchorSetting(anchor: CanvasAnchor): string {
  return ANCHOR_SETTINGS[anchor];
}

/** The Canvas Size fill choices, in dialog order (DOC-IMG-03). */
export const FILL_CHOICES = [
  "Transparent",
  "PrimaryColor",
  "SecondaryColor",
  "White",
  "Black",
] as const;

export type FillChoice = (typeof FILL_CHOICES)[number];

export const FILL_MESSAGES: Readonly<Record<FillChoice, MessageId>> = {
  Transparent: "image.fill.transparent",
  PrimaryColor: "image.fill.primary",
  SecondaryColor: "image.fill.secondary",
  White: "image.fill.white",
  Black: "image.fill.black",
};

/** The fill from its setting, with Transparent for an unknown value. */
export function fillFromSetting(value: unknown): FillChoice {
  return FILL_CHOICES.find((choice) => choice === value) ?? "Transparent";
}

/** The fill color for a choice, from the document's primary and secondary colors (DOC-COL-01). */
export function fillColor(choice: FillChoice, primary: Rgba, secondary: Rgba): ColorRgba8 {
  switch (choice) {
    case "Transparent":
      return TRANSPARENT;
    case "PrimaryColor":
      return rgba8(primary.r, primary.g, primary.b, primary.a);
    case "SecondaryColor":
      return rgba8(secondary.r, secondary.g, secondary.b, secondary.a);
    case "White":
      return WHITE;
    case "Black":
      return BLACK;
  }
}

/** The print unit from `workspace.lastNonPixelUnits`, with Inch for anything else. */
export function printUnitFromSetting(value: unknown): PhysicalUnit {
  return value === "Centimeter" ? "centimeter" : "inch";
}

export function printUnitSetting(unit: PhysicalUnit): "Inch" | "Centimeter" {
  return unit === "centimeter" ? "Centimeter" : "Inch";
}

/**
 * The size fields of New, Resize and Canvas Size. The pixel size is either typed directly
 * ("pixels") or given as a percentage of the current size ("percent"). The print size and the
 * resolution share one value: `dotsPerUnit` dots per print unit, applied to both axes (DOC-DOC-03).
 * Values may be NaN while the user types. They are checked when OK is pressed.
 */
export interface SizeDraft {
  readonly mode: "pixels" | "percent";
  readonly percent: number;
  readonly width: number;
  readonly height: number;
  readonly keepAspect: boolean;
  readonly dotsPerUnit: number;
  readonly unit: PhysicalUnit;
}

/** A draft that starts at `size`, with the resolution in `unit`. */
export function sizeDraft(
  size: Size,
  options: { keepAspect: boolean; unit: PhysicalUnit; dotsPerUnit: number },
): SizeDraft {
  return {
    mode: "pixels",
    percent: 100,
    width: size.width,
    height: size.height,
    keepAspect: options.keepAspect,
    dotsPerUnit: options.dotsPerUnit,
    unit: options.unit,
  };
}

/** The resolution of a document, expressed in `unit`, as the dots per unit the draft edits. */
export function dotsPerUnitOf(resolution: Resolution, unit: PhysicalUnit): number {
  return convertDotsPerUnit(resolution.x, resolution.unit, unit);
}

/** The default resolution, 96 px per inch expressed in `unit` (DOC-NEW-01). */
export function defaultDotsPerUnit(unit: PhysicalUnit): number {
  return convertDotsPerUnit(DEFAULT_DPI, "inch", unit);
}

/** The pixel size the draft shows. A percentage scales the current size without clamping. */
export function displayedSize(draft: SizeDraft, current: Size): Size {
  if (draft.mode === "pixels") return { width: draft.width, height: draft.height };
  return {
    width: Math.round((current.width * draft.percent) / 100),
    height: Math.round((current.height * draft.percent) / 100),
  };
}

function isImageDimension(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_IMAGE_SIZE && value <= MAX_IMAGE_SIZE;
}

function isPercent(value: number): boolean {
  return Number.isFinite(value) && value >= PERCENT_MIN && value <= PERCENT_MAX;
}

/**
 * The pixel size to apply, or undefined when it is not valid: each side is an integer in
 * [1, 262,144], and a percentage is within its spinner range and gives such a size (DOC-DOC-01).
 */
export function targetSize(draft: SizeDraft, current: Size): Size | undefined {
  if (draft.mode === "percent" && !isPercent(draft.percent)) return undefined;
  const size = displayedSize(draft, current);
  return isImageDimension(size.width) && isImageDimension(size.height) ? size : undefined;
}

/** The resolution to apply, or undefined when it is outside the document range (DOC-DOC-03). */
export function draftResolution(draft: SizeDraft): Resolution | undefined {
  const resolution = { unit: draft.unit, x: draft.dotsPerUnit, y: draft.dotsPerUnit };
  return isValidResolution(resolution) ? resolution : undefined;
}

/** True when the draft can be applied (the OK button is enabled). */
export function isDraftValid(draft: SizeDraft, current: Size): boolean {
  return targetSize(draft, current) !== undefined && draftResolution(draft) !== undefined;
}

/** A new typed width. With Maintain aspect ratio, the height follows the width (DOC-IMG-02). */
export function withWidth(draft: SizeDraft, current: Size, width: number): SizeDraft {
  const height =
    draft.keepAspect && Number.isFinite(width)
      ? Math.round((current.height * width) / current.width)
      : draft.height;
  return { ...draft, width, height };
}

/** A new typed height. With Maintain aspect ratio, the width follows the height. */
export function withHeight(draft: SizeDraft, current: Size, height: number): SizeDraft {
  const width =
    draft.keepAspect && Number.isFinite(height)
      ? Math.round((current.width * height) / current.height)
      : draft.width;
  return { ...draft, width, height };
}

/** Switches between typed pixels and a percentage. Typed pixels start from the shown size. */
export function withMode(draft: SizeDraft, current: Size, mode: SizeDraft["mode"]): SizeDraft {
  if (mode === draft.mode) return draft;
  if (mode === "percent") return { ...draft, mode };
  const size = displayedSize(draft, current);
  return { ...draft, mode, width: size.width, height: size.height };
}

export function withPercent(draft: SizeDraft, percent: number): SizeDraft {
  return { ...draft, percent };
}

/** A new resolution in dots per print unit. Both axes take the same value (DOC-DOC-03). */
export function withDotsPerUnit(draft: SizeDraft, dotsPerUnit: number): SizeDraft {
  return { ...draft, dotsPerUnit };
}

/** A new print width. The resolution changes so the pixels fit that length (DPI math). */
export function withPrintWidth(draft: SizeDraft, current: Size, length: number): SizeDraft {
  return { ...draft, dotsPerUnit: displayedSize(draft, current).width / length };
}

/** A new print height. The resolution changes so the pixels fit that length (DPI math). */
export function withPrintHeight(draft: SizeDraft, current: Size, length: number): SizeDraft {
  return { ...draft, dotsPerUnit: displayedSize(draft, current).height / length };
}

/** A new print unit. The resolution is converted so the printed size stays the same (DOC-DOC-03). */
export function withUnit(draft: SizeDraft, unit: PhysicalUnit): SizeDraft {
  return {
    ...draft,
    unit,
    dotsPerUnit: convertDotsPerUnit(draft.dotsPerUnit, draft.unit, unit),
  };
}

/** The printed width and height in the draft's unit (DOC-DOC-03: pixels divided by dots per unit). */
export function printSize(draft: SizeDraft, current: Size): Size {
  const size = displayedSize(draft, current);
  return { width: size.width / draft.dotsPerUnit, height: size.height / draft.dotsPerUnit };
}

/** The bytes of pixel data for a size, at 4 bytes per pixel for each layer (DOC-IMG-02). */
export function memoryBytes(size: Size, layerCount: number): number {
  return size.width * size.height * 4 * layerCount;
}

/** The memory estimate in B, KB, MB or GB with one decimal (DOC-IMG-02). */
export function memoryText(bytes: number, t: Translate): string {
  const scales: ReadonlyArray<readonly [MessageId, number]> = [
    ["image.memory.gigabytes", 1024 ** 3],
    ["image.memory.megabytes", 1024 ** 2],
    ["image.memory.kilobytes", 1024],
  ];
  for (const [id, scale] of scales) {
    if (bytes >= scale) return t(id, { value: (bytes / scale).toFixed(1) });
  }
  return t("image.memory.bytes", { value: Math.round(bytes) });
}

/**
 * The size of a new image (DOC-NEW-01): the clipboard's size when it holds an image or a
 * selection outline with area, otherwise 800 x 600 (600 x 800 on a portrait screen), times the
 * device pixel ratio.
 */
export function defaultNewImageSize(options: {
  readonly screen: Size;
  readonly devicePixelRatio: number;
  readonly clipboard?: Size;
}): Size {
  if (options.clipboard !== undefined) return options.clipboard;
  const portrait = options.screen.width / options.screen.height < 1;
  const base = portrait ? { width: 600, height: 800 } : { width: 800, height: 600 };
  return {
    width: Math.round(base.width * options.devicePixelRatio),
    height: Math.round(base.height * options.devicePixelRatio),
  };
}
