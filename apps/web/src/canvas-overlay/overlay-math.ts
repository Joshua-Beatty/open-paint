import type { Rect, Size } from "@openpaint/document";
import type { ViewLayout } from "@openpaint/engine";
import { canvasScale } from "../canvas-scale";
import type { MeasureUnit } from "../status/status-model";

/** The ruler strip's thickness in CSS pixels (UI-VIEW-04). */
export const RULER_CSS_PIXELS = 20;

/**
 * The pixel grid (UI-VIEW-03, owner override) depends on how wide one image pixel is on screen, in
 * CSS pixels, not on the zoom percentage: it fades in from `GRID_FADE_START_CSS` and is at full
 * opacity from `GRID_FADE_END_CSS`. At 3 CSS px or less the 1-device-pixel lines take a third or more
 * of every cell and the grid hides the pixels it should outline.
 */
export const GRID_FADE_START_CSS = 3;
export const GRID_FADE_END_CSS = 5;
const GRID_MAX_OPACITY = 0.5;

/** Ruler ticks are at least this far apart on screen, in CSS pixels. */
const MAJOR_SPACING_CSS = 64;
const MINOR_SPACING_CSS = 5;

/**
 * The pixel boundaries inside the visible part of the image, in device pixels. `area` is that
 * visible part, so the grid lines stop at the image edge and at the viewport edge.
 */
export interface GridLines {
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly area: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

/** The smallest brush outline radius in device pixels, so a 1 px tip still shows. */
const MIN_BRUSH_RADIUS = 1;

/** The path calls a tip outline uses, which both `CanvasRenderingContext2D` and `Path2D` have. */
export interface TipPath {
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  rect(x: number, y: number, width: number, height: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
}

/**
 * How a brush tip's outline is drawn at the pointer: `trace` adds the tip's shape, centred on
 * (x, y) and fitting a box of half side `radius`, to `path`. A new tip registers one entry here, keyed
 * by its value of the tip setting (`tools.brush.type`), and every brush tool's cursor follows it.
 */
export interface BrushTipOutline {
  trace(path: TipPath, x: number, y: number, radius: number): void;
}

/** The outline of each brush tip, keyed by the tip setting's value. */
export const BRUSH_TIP_OUTLINES: Readonly<Record<string, BrushTipOutline>> = {
  Circle: {
    trace: (path, x, y, radius) => {
      path.moveTo(x + radius, y);
      path.arc(x, y, radius, 0, Math.PI * 2);
    },
  },
  Square: {
    trace: (path, x, y, radius) => path.rect(x - radius, y - radius, radius * 2, radius * 2),
  },
};

/** The tip a brush outline draws when the setting names no registered tip. */
export const DEFAULT_BRUSH_TIP = "Circle";

/** The tip a stored `tools.brush.type` value names, or the default for an unknown value. */
export function brushOutlineShape(tipType: unknown): string {
  return typeof tipType === "string" && tipType in BRUSH_TIP_OUTLINES ? tipType : DEFAULT_BRUSH_TIP;
}

/** The brush outline in device pixels: the tip's shape fitting a box of half side `radius`. */
export interface BrushOutline {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** A key of `BRUSH_TIP_OUTLINES`. */
  readonly shape: string;
}

/**
 * The brush outline (TL-BRUSH-01): the tip's diameter at the view's zoom, centred on the pointer, in
 * the tip's shape. `diameter` is in image pixels, and `zoom` is device pixels per image pixel.
 * Undefined when there is no tip to draw.
 */
export function brushOutline(
  diameter: number,
  zoom: number,
  pointer: { readonly x: number; readonly y: number },
  shape: string = DEFAULT_BRUSH_TIP,
): BrushOutline | undefined {
  if (!(diameter > 0) || !(zoom > 0)) return undefined;
  return {
    x: pointer.x,
    y: pointer.y,
    radius: Math.max(MIN_BRUSH_RADIUS, (diameter * zoom) / 2),
    shape,
  };
}

/**
 * An image point in device pixels of the view, given the layout's image origin and zoom. Undefined
 * without a layout, so the overlay draws nothing until the engine reports one.
 */
export function viewPoint(
  layout: { readonly originX: number; readonly originY: number; readonly zoom: number } | undefined,
  point: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } | undefined {
  if (layout === undefined) return undefined;
  return {
    x: layout.originX + point.x * layout.zoom,
    y: layout.originY + point.y * layout.zoom,
  };
}

/**
 * The part of the image on screen, in whole image pixels, for a view of `viewport` device pixels.
 * Undefined without a layout or when no part of the image is visible.
 */
export function visibleImageRect(layout: ViewLayout | undefined, viewport: Size): Rect | undefined {
  if (layout === undefined || layout.zoom <= 0) return undefined;
  const left = Math.max(0, Math.floor(-layout.originX / layout.zoom));
  const top = Math.max(0, Math.floor(-layout.originY / layout.zoom));
  const right = Math.min(
    layout.documentWidth,
    Math.ceil((viewport.width - layout.originX) / layout.zoom),
  );
  const bottom = Math.min(
    layout.documentHeight,
    Math.ceil((viewport.height - layout.originY) / layout.zoom),
  );
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `visibleImageRect` for the view element's current size. */
export function visibleImageArea(
  layout: ViewLayout | undefined,
  element: HTMLElement | null,
): Rect | undefined {
  if (element === null) return undefined;
  return visibleImageRect(layout, {
    width: element.clientWidth * canvasScale.value,
    height: element.clientHeight * canvasScale.value,
  });
}

/**
 * Pixel grid opacity (UI-VIEW-03): 0 until one image pixel is `GRID_FADE_START_CSS` CSS pixels wide,
 * rising linearly to 1/2 at `GRID_FADE_END_CSS`. `zoom` is device pixels per image pixel and `dpr`
 * the device pixel ratio, so the result is the same for any image size and display density.
 */
export function gridOpacity(zoom: number, dpr: number): number {
  const scale = dpr > 0 ? dpr : 1;
  const cssPixels = zoom / scale;
  const ramp = (cssPixels - GRID_FADE_START_CSS) / (GRID_FADE_END_CSS - GRID_FADE_START_CSS);
  return Math.min(1, Math.max(0, ramp)) * GRID_MAX_OPACITY;
}

function boundaries(origin: number, zoom: number, count: number, extent: number): number[] {
  const first = Math.max(0, Math.ceil(-origin / zoom));
  const last = Math.min(count, Math.floor((extent - origin) / zoom));
  const lines: number[] = [];
  for (let index = first; index <= last; index++) {
    const position = Math.round(origin + index * zoom);
    if (position >= 0 && position < extent) lines.push(position);
  }
  return lines;
}

/** The pixel boundaries of the image that are on screen (UI-VIEW-03). */
export function gridLines(layout: ViewLayout, viewport: Size): GridLines {
  const { zoom, originX, originY, documentWidth, documentHeight } = layout;
  return {
    x: boundaries(originX, zoom, documentWidth, viewport.width),
    y: boundaries(originY, zoom, documentHeight, viewport.height),
    area: {
      left: Math.max(0, Math.round(originX)),
      top: Math.max(0, Math.round(originY)),
      right: Math.min(viewport.width, Math.round(originX + documentWidth * zoom)),
      bottom: Math.min(viewport.height, Math.round(originY + documentHeight * zoom)),
    },
  };
}

export type RulerOrientation = "horizontal" | "vertical";

/** The major and minor tick steps in the display unit, and the decimals the labels show. */
export interface RulerScale {
  readonly major: number;
  readonly minor: number;
  readonly decimals: number;
}

/** One tick: its device-pixel position and, for a major tick, its label. */
export interface RulerTick {
  readonly position: number;
  readonly major: boolean;
  readonly label?: string;
}

/**
 * The steps a unit can show. Inches halve from a 256-inch step down (UI-VIEW-04). Centimeters and
 * pixels use 1, 2 and 5 times a power of ten, and pixels never go below one pixel.
 */
function majorCandidates(unit: MeasureUnit): number[] {
  if (unit === "Inch") return Array.from({ length: 17 }, (_, index) => 2 ** (index - 8));
  const steps: number[] = [];
  for (let exponent = unit === "Pixel" ? 0 : -3; exponent <= 6; exponent++) {
    for (const multiple of [1, 2, 5]) steps.push(multiple * 10 ** exponent);
  }
  return steps;
}

/** The number of decimals needed to show `step` exactly, up to six. */
function decimalPlaces(step: number): number {
  let places = 0;
  while (places < 6 && Math.abs(step * 10 ** places - Math.round(step * 10 ** places)) > 1e-9) {
    places++;
  }
  return places;
}

/**
 * The tick steps for a ruler (UI-VIEW-04). The major step is the smallest that keeps major ticks
 * apart on screen. Minor ticks divide it by 2 then 5 (inches only by 2), while they stay apart.
 * `unitsPerPixel` is the length of one image pixel in the unit, and `scale` is the device pixel
 * ratio, so the spacing limits are in CSS pixels.
 */
export function rulerScale(
  unit: MeasureUnit,
  unitsPerPixel: number,
  zoom: number,
  scale: number,
): RulerScale {
  const spacing = (units: number) => (units / unitsPerPixel) * zoom;
  const candidates = majorCandidates(unit);
  const major =
    candidates.find((step) => spacing(step) >= MAJOR_SPACING_CSS * scale) ?? candidates.at(-1) ?? 1;
  const minSpacing = MINOR_SPACING_CSS * scale;
  let minor = major;
  for (let step = 0; ; step++) {
    const next = unit === "Inch" || step % 2 === 0 ? minor / 2 : minor / 5;
    if (spacing(next) < minSpacing || (unit === "Pixel" && next < 1)) break;
    minor = next;
  }
  return { major, minor, decimals: decimalPlaces(major) };
}

/**
 * The ticks that fall inside a ruler of `extent` device pixels. `origin` is where the image starts
 * on that axis, in device pixels.
 */
export function rulerTicks(
  scale: RulerScale,
  unitsPerPixel: number,
  zoom: number,
  origin: number,
  extent: number,
): RulerTick[] {
  const valueAt = (device: number) => ((device - origin) / zoom) * unitsPerPixel;
  const first = Math.floor(valueAt(0) / scale.minor);
  const last = Math.ceil(valueAt(extent) / scale.minor);
  const ticks: RulerTick[] = [];
  for (let index = first; index <= last; index++) {
    const value = index * scale.minor;
    const position = origin + (value / unitsPerPixel) * zoom;
    if (position < 0 || position > extent) continue;
    const ratio = value / scale.major;
    const major = Math.abs(ratio - Math.round(ratio)) < 1e-9;
    ticks.push(
      major ? { position, major, label: value.toFixed(scale.decimals) } : { position, major },
    );
  }
  return ticks;
}
