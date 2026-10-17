import {
  type ColorRgba8,
  HATCH_PATTERNS,
  intersectRects,
  LayerBlendMode,
  type Rect,
  rectFromEdges,
} from "@openpaint/document";
import type { BrushOptions, RecolorOptions } from "@openpaint/engine";

/** One pointer sample of a stroke, in image pixels (WEB-PTR-01). */
export interface StrokePoint {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
}

/**
 * What a stroke paints: a brush (Paintbrush or Eraser), a recolor of the pixels under a brush
 * (TL-BRUSH-RC-01), a clone of the source pixels under a brush (TL-BRUSH-CS-01) or a pencil line
 * (TL-PENCIL-01).
 */
export type StrokeSpec =
  | { readonly kind: "brush"; readonly options: BrushOptions }
  | { readonly kind: "recolor"; readonly options: BrushOptions; readonly recolor: RecolorOptions }
  | { readonly kind: "clone"; readonly options: BrushOptions }
  | { readonly kind: "pencil"; readonly color: ColorRgba8; readonly blend: number };

/** The blend value of Overwrite (TL-OPT-BLEND), one past the layer blend modes. */
export const OVERWRITE_BLEND = 14;

/** Extra pixels a stroke's region keeps around its path, so the region grows only now and then. */
export const STROKE_MARGIN = 32;

/** Reads one `tools.*` setting by its name under the tree, such as `brush.size`. */
export type ToolRead = (name: string) => unknown;

/** The blend value of a stored blend mode name (TL-OPT-BLEND). Unknown names blend Normal. */
export function blendValue(name: unknown): number {
  if (name === "overwrite") return OVERWRITE_BLEND;
  if (typeof name === "string" && Object.hasOwn(LayerBlendMode, name)) {
    return LayerBlendMode[name as keyof typeof LayerBlendMode];
  }
  return LayerBlendMode.normal;
}

/** The hatch pattern of a stored fill (TL-OPT-FILL): 0 for a solid color, else 1 to 8. */
export function hatchValue(fillType: unknown, hatchStyle: unknown): number {
  if (fillType !== "Hatch") return 0;
  return HATCH_PATTERNS.rank(hatchStyle);
}

/**
 * The options of a brush stroke. The Paintbrush paints with `color` and, for a hatch, the other
 * color on the clear pixels. The Eraser erases alpha and has no blend mode or fill.
 */
export function brushOptionsFor(
  read: ToolRead,
  mode: "paint" | "erase",
  color: ColorRgba8,
  background: ColorRgba8,
): BrushOptions {
  const number = (name: string, fallback: number) => {
    const value = read(name);
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const flag = (name: string, fallback: boolean) => {
    const value = read(name);
    return typeof value === "boolean" ? value : fallback;
  };
  const erase = mode === "erase";
  return {
    size: number("brush.size", 2),
    hardness: number("brush.hardness", 0.75),
    spacing: number("brush.spacing", 0.15),
    square: read("brush.type") === "Square",
    smooth: read("inputSmoothing") !== "Disabled",
    antialias: flag("antialiasing", true),
    pressure: flag("brush.pressure", true),
    erase,
    blend: erase ? LayerBlendMode.normal : blendValue(read("blendMode")),
    hatch: erase ? 0 : hatchValue(read("brush.fillType"), read("brush.hatchStyle")),
    color,
    background,
  };
}

/**
 * The distance, in pixels, that a stroke's pixels reach from its path. A brush reaches half its
 * diameter, rounded up, plus one pixel of antialiasing. A pencil line is one pixel wide.
 */
export function strokeReach(spec: StrokeSpec): number {
  return spec.kind === "pencil" ? 1 : Math.ceil(spec.options.size / 2) + 1;
}

/**
 * The part of the layer a stroke can change: the bounds of its samples, grown by the reach and the
 * margin, clipped to the image. It is empty when the stroke lies wholly off the image.
 */
export function strokeRegion(points: readonly StrokePoint[], reach: number, bounds: Rect): Rect {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  const pad = reach + STROKE_MARGIN;
  const area = rectFromEdges(
    Math.floor(left - pad),
    Math.floor(top - pad),
    Math.ceil(right + pad),
    Math.ceil(bottom + pad),
  );
  return intersectRects(area, bounds);
}

/**
 * The per-pixel selection coverage over a region (TL-FRAME-04), or undefined when nothing is
 * selected. A pixelated selection quality (TL-OPT-SELQ) keeps only fully covered or uncovered pixels.
 */
export function selectionCoverage(
  selection: { readonly isEmpty: boolean; mask(area: Rect): Uint8Array },
  region: Rect,
  pixelated: boolean,
): Uint8Array | undefined {
  if (selection.isEmpty) return undefined;
  const mask = selection.mask(region);
  return pixelated ? mask.map((value) => (value >= 128 ? 255 : 0)) : mask;
}
