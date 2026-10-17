import {
  convertResolution,
  pixelAreaToPhysical,
  pixelsToPhysical,
  type Resolution,
  type ResolutionUnit,
  type Selection,
} from "@openpaint/document";
import { MAX_ZOOM, MIN_ZOOM, type ViewLayout } from "@openpaint/engine";
import type { MessageId, Translate } from "@openpaint/i18n";

/** A point in device pixels, relative to the canvas (WEB-GPU-07). */
export interface DevicePoint {
  readonly x: number;
  readonly y: number;
}

/** The display unit the setting stores (SET-STO-03 `workspace.measurementUnit`, UI-VIEW-05). */
export type MeasureUnit = "Pixel" | "Inch" | "Centimeter";

export const MEASURE_UNITS: readonly MeasureUnit[] = ["Pixel", "Inch", "Centimeter"];

/** The number of steps the zoom slider moves through, from the lowest zoom to the highest. */
export const ZOOM_SLIDER_STEPS = 1000;

const RESOLUTION_UNIT: Record<MeasureUnit, ResolutionUnit> = {
  Pixel: "pixel",
  Inch: "inch",
  Centimeter: "centimeter",
};

const ABBREVIATION: Record<MeasureUnit, MessageId> = {
  Pixel: "status.unit.px",
  Inch: "status.unit.in",
  Centimeter: "status.unit.cm",
};

const UNIT_NAME: Record<MeasureUnit, MessageId> = {
  Pixel: "status.unitName.pixel",
  Inch: "status.unitName.inch",
  Centimeter: "status.unitName.centimeter",
};

const MENU_UNIT: Record<MeasureUnit, "pixels" | "inches" | "centimeters"> = {
  Pixel: "pixels",
  Inch: "inches",
  Centimeter: "centimeters",
};

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, useGrouping: false });
const PHYSICAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, useGrouping: false });
const ANGLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, useGrouping: false });

/** The unit from a stored setting. Anything unknown means Pixel (the setting's default). */
export function measureUnit(value: unknown): MeasureUnit {
  return MEASURE_UNITS.find((unit) => unit === value) ?? "Pixel";
}

/** The unit name the View menu's checkmarks use. */
export function menuUnitOf(unit: MeasureUnit): "pixels" | "inches" | "centimeters" {
  return MENU_UNIT[unit];
}

/** The unit's abbreviation, as the units button and the readouts show it. */
export function unitAbbreviation(unit: MeasureUnit, t: Translate): string {
  return t(ABBREVIATION[unit]);
}

/** The unit's name for a menu, in the catalog's wording. */
export const UNIT_LABEL: Record<MeasureUnit, MessageId> = {
  Pixel: "status.unit.pixels",
  Inch: "status.unit.inches",
  Centimeter: "status.unit.centimeters",
};

/** The resolution expressed in `unit`, so that its `x` and `y` are dots per that unit. */
function dotsIn(resolution: Resolution, unit: MeasureUnit): Resolution {
  return convertResolution(resolution, RESOLUTION_UNIT[unit]);
}

/** The length of one image pixel in `unit`, per axis (UI-VIEW-05, the rulers' scale). */
export function unitsPerPixel(resolution: Resolution, unit: MeasureUnit): { x: number; y: number } {
  const dots = dotsIn(resolution, unit);
  return { x: 1 / dots.x, y: 1 / dots.y };
}

/** A length in `unit`, rounded for display: whole pixels, and two decimals for physical units. */
export function formatMeasure(value: number, unit: MeasureUnit): string {
  return (unit === "Pixel" ? WHOLE : PHYSICAL).format(value || 0);
}

/** The zoom ratio as the whole percent the zoom button shows (UI-SB-03). */
export function zoomPercent(zoom: number): number {
  return Math.round(zoom * 100);
}

/**
 * Parses the zoom box (UI-SB-03): "%" and spaces are removed, the rest must be a finite number
 * above zero, and the result is the ratio (the number divided by 100). Anything else is undefined.
 */
export function parseZoomEntry(text: string): number | undefined {
  const cleaned = text.replace(/[%\s]/g, "");
  if (cleaned === "") return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value / 100 : undefined;
}

/** The zoom slider position (0 to ZOOM_SLIDER_STEPS) for a zoom ratio, on a logarithmic scale. */
export function zoomSliderValue(zoom: number): number {
  const position = Math.log(zoom / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM);
  return Math.round(Math.min(1, Math.max(0, position)) * ZOOM_SLIDER_STEPS);
}

/** The zoom ratio at a slider position, the inverse of `zoomSliderValue`. */
export function zoomFromSliderValue(value: number): number {
  return MIN_ZOOM * (MAX_ZOOM / MIN_ZOOM) ** (value / ZOOM_SLIDER_STEPS);
}

/**
 * The image pixel under a canvas point, or undefined when the point is outside the image. The
 * layout gives the image origin and zoom in device pixels.
 */
export function imagePixelAt(
  layout: ViewLayout,
  point: DevicePoint,
): { x: number; y: number } | undefined {
  const x = Math.floor((point.x - layout.originX) / layout.zoom);
  const y = Math.floor((point.y - layout.originY) / layout.zoom);
  if (x < 0 || y < 0 || x >= layout.documentWidth || y >= layout.documentHeight) return undefined;
  return { x, y };
}

/** The image size in `unit` (UI-SB-01 item 3). */
export function imageSizeText(
  width: number,
  height: number,
  resolution: Resolution,
  unit: MeasureUnit,
  t: Translate,
): string {
  const dots = dotsIn(resolution, unit);
  return t("status.imageSize", {
    width: formatMeasure(pixelsToPhysical(width, dots.x), unit),
    height: formatMeasure(pixelsToPhysical(height, dots.y), unit),
  });
}

/** The cursor's pixel position in `unit` (UI-SB-01 item 5). */
export function cursorText(
  pixel: { x: number; y: number },
  resolution: Resolution,
  unit: MeasureUnit,
  t: Translate,
): string {
  const dots = dotsIn(resolution, unit);
  return t("status.cursor", {
    x: formatMeasure(pixelsToPhysical(pixel.x, dots.x), unit),
    y: formatMeasure(pixelsToPhysical(pixel.y, dots.y), unit),
  });
}

/**
 * The rotation of a pending selection transform in degrees, or undefined when it does not rotate
 * (UI-SB-02 "Angle").
 */
export function selectionAngle(selection: Selection): number | undefined {
  const m = selection.pendingTransform;
  if (m === undefined) return undefined;
  const degrees = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  return Math.abs(degrees) < 1e-9 ? undefined : degrees;
}

/**
 * The selection readout of UI-SB-02: the top left, the bounding rectangle, the true area and, for a
 * rotated selection, the angle. Lengths use the chosen unit and the document's resolution.
 */
export function selectionText(
  selection: Selection,
  resolution: Resolution,
  unit: MeasureUnit,
  t: Translate,
): string {
  const dots = dotsIn(resolution, unit);
  const bounds = selection.bounds();
  const area = pixelAreaToPhysical(selection.area(), dots);
  const text = t("status.selection", {
    x: formatMeasure(pixelsToPhysical(bounds.x, dots.x), unit),
    y: formatMeasure(pixelsToPhysical(bounds.y, dots.y), unit),
    u: unitAbbreviation(unit, t),
    width: formatMeasure(pixelsToPhysical(bounds.width, dots.x), unit),
    height: formatMeasure(pixelsToPhysical(bounds.height, dots.y), unit),
    area: formatMeasure(area, unit),
    unit: t(UNIT_NAME[unit], { count: area }),
  });
  const angle = selectionAngle(selection);
  return angle === undefined
    ? text
    : `${text}${t("status.selectionAngle", { angle: ANGLE.format(angle) })}`;
}
