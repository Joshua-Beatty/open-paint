import { bytesOf, type ColorRgba8, Surface } from "@openpaint/document";
import {
  BrushSettings,
  brushStrokeRgba8,
  bucketFillRgba8,
  cloneStrokeRgba8,
  pencilCellsRgba8,
  pencilStrokeRgba8,
  RecolorSettings,
  recolorCoverRgba8,
  recolorRgba8,
} from "./cpu";

/** The options of one brush stroke (TL-BRUSH-01, TL-OPT-BRUSH, TL-OPT-AA, TL-OPT-BLEND, TL-OPT-FILL). */
export interface BrushOptions {
  /** Tip diameter at full pressure, 1 to 2000 px. */
  readonly size: number;
  /** Hardness, 0 to 1. */
  readonly hardness: number;
  /** Spacing as a fraction of the tip diameter, 0.01 to 5. */
  readonly spacing: number;
  readonly square: boolean;
  /** Centripetal Catmull-Rom path smoothing. */
  readonly smooth: boolean;
  readonly antialias: boolean;
  /** Pressure changes the tip size. */
  readonly pressure: boolean;
  /** Erases alpha instead of painting. */
  readonly erase: boolean;
  /** A layer blend value 0 to 13, or 14 for Overwrite. */
  readonly blend: number;
  /** 0 for a solid color, or 1 to 8 for a hatch pattern in the order of TL-OPT-FILL. */
  readonly hatch: number;
  /** The paint color, and the color of the set hatch pixels. */
  readonly color: ColorRgba8;
  /** The color of the clear hatch pixels. Unused for a solid color. */
  readonly background: ColorRgba8;
}

/**
 * Renders one stroke on the CPU (the Rust reference of TL-BRUSH-01) and returns a new surface.
 * `path` is flat `x, y, pressure` triples in canvas pixels.
 */
export function strokeBrushCpu(input: Surface, path: Float32Array, brush: BrushSettings): Surface {
  const data = new Uint8ClampedArray(input.data);
  brushStrokeRgba8(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    input.width,
    input.height,
    path,
    brush,
  );
  return new Surface(input.width, input.height, data);
}

/** The WASM brush settings of plain options. The caller frees the result. */
export function brushSettingsOf(options: BrushOptions): BrushSettings {
  const brush = new BrushSettings();
  brush.size = options.size;
  brush.hardness = options.hardness;
  brush.spacing = options.spacing;
  brush.square = options.square;
  brush.smooth = options.smooth;
  brush.antialias = options.antialias;
  brush.pressure = options.pressure;
  brush.erase = options.erase;
  brush.blend = options.blend;
  brush.hatch = options.hatch;
  brush.r = options.color.r;
  brush.g = options.color.g;
  brush.b = options.color.b;
  brush.a = options.color.a;
  brush.back_r = options.background.r;
  brush.back_g = options.background.g;
  brush.back_b = options.background.b;
  brush.back_a = options.background.a;
  return brush;
}

/** Renders one stroke described by plain options. The WASM settings object is freed afterwards. */
export function strokeBrush(input: Surface, path: Float32Array, options: BrushOptions): Surface {
  const brush = brushSettingsOf(options);
  try {
    return strokeBrushCpu(input, path, brush);
  } finally {
    brush.free();
  }
}

/**
 * The colors and tolerance of a Recolor stroke (TL-BRUSH-RC-01). The basis color is matched within
 * the tolerance, and each match is shifted by `fill − basis`.
 */
export interface RecolorOptions {
  readonly basis: ColorRgba8;
  readonly fill: ColorRgba8;
  /** Tolerance from 0 to 1 (TL-ALG-TOL). */
  readonly tolerance: number;
  /** Compares straight channels instead of premultiplied ones (TL-ALG-TOL alpha mode). */
  readonly straight: boolean;
}

/**
 * Recolors one stroke on the CPU (the Rust reference of TL-BRUSH-RC-01) and returns a new surface.
 * The brush gives the stroke's tip, and `path` is flat `x, y, pressure` triples in canvas pixels.
 */
export function recolorStrokeCpu(
  input: Surface,
  path: Float32Array,
  brush: BrushOptions,
  options: RecolorOptions,
): Surface {
  const data = new Uint8ClampedArray(input.data);
  const tip = brushSettingsOf(brush);
  const recolor = recolorSettingsOf(options);
  try {
    recolorRgba8(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      input.width,
      input.height,
      path,
      tip,
      recolor,
    );
  } finally {
    tip.free();
    recolor.free();
  }
  return new Surface(input.width, input.height, data);
}

/** The WASM recolor settings of plain options. The caller frees the result. */
function recolorSettingsOf(options: RecolorOptions): RecolorSettings {
  const recolor = new RecolorSettings();
  recolor.basis_r = options.basis.r;
  recolor.basis_g = options.basis.g;
  recolor.basis_b = options.basis.b;
  recolor.basis_a = options.basis.a;
  recolor.fill_r = options.fill.r;
  recolor.fill_g = options.fill.g;
  recolor.fill_b = options.fill.b;
  recolor.fill_a = options.fill.a;
  recolor.tolerance = options.tolerance;
  recolor.straight = options.straight;
  return recolor;
}

/**
 * Recolors `surface` in place under a stroke's coverage (one byte per pixel, the same size), as
 * `recolorStrokeCpu` does with the coverage of its whole stroke. Each pixel depends only on itself
 * and its coverage, so a live Recolor stroke recolors just the part whose coverage changed.
 */
export function recolorCover(surface: Surface, cover: Uint8Array, options: RecolorOptions): void {
  const recolor = recolorSettingsOf(options);
  try {
    recolorCoverRgba8(bytesOf(surface), cover, surface.width, surface.height, recolor);
  } finally {
    recolor.free();
  }
}

/**
 * Paints the pencil polyline through pixel `cells` (flat `x, y` pairs in image pixels) onto
 * `surface` in place, whose top-left pixel is image pixel (`originX`, `originY`). When `joined`,
 * the first cell ends the line already painted, so only the segments after it are painted: a live
 * Pencil stroke painted a few samples at a time this way matches `strokePencilCpu`.
 */
export function pencilCells(
  surface: Surface,
  originX: number,
  originY: number,
  cells: Int32Array,
  joined: boolean,
  color: ColorRgba8,
  blend: number,
): void {
  pencilCellsRgba8(
    bytesOf(surface),
    surface.width,
    surface.height,
    originX,
    originY,
    cells,
    joined,
    color.r,
    color.g,
    color.b,
    color.a,
    blend,
  );
}

/**
 * Clones one stroke on the CPU (the Rust reference of TL-BRUSH-CS-01) and returns a new surface.
 * `source` holds, for each pixel of `input`, the source pixel the stroke copies there, so it is the
 * same size as `input`. The brush gives the tip, the blend mode and the antialiasing, and `path` is
 * flat `x, y, pressure` triples in canvas pixels.
 */
export function cloneStrokeCpu(
  input: Surface,
  source: Surface,
  path: Float32Array,
  brush: BrushOptions,
): Surface {
  const data = new Uint8ClampedArray(input.data);
  const tip = brushSettingsOf(brush);
  try {
    cloneStrokeRgba8(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength),
      input.width,
      input.height,
      path,
      tip,
    );
  } finally {
    tip.free();
  }
  return new Surface(input.width, input.height, data);
}

/** The options of one Paint Bucket fill (TL-BUCKET-01, TL-OPT-FILL, TL-OPT-AA, TL-OPT-BLEND). */
export interface BucketOptions {
  /** Feathers the stencil edge by one pixel. */
  readonly antialias: boolean;
  /** A layer blend value 0 to 13, or 14 for Overwrite. */
  readonly blend: number;
  /** 0 for a solid color, or 1 to 8 for a hatch pattern in the order of TL-OPT-FILL. */
  readonly hatch: number;
  /** The fill color, and the color of the set hatch pixels. */
  readonly color: ColorRgba8;
  /** The color of the clear hatch pixels. Unused for a solid color. */
  readonly background: ColorRgba8;
}

/**
 * Fills the stencil `mask` (one byte per pixel, 255 inside the region) on the CPU and returns a new
 * surface. The fill is the Rust reference of TL-BUCKET-01.
 */
export function bucketFillCpu(input: Surface, mask: Uint8Array, options: BucketOptions): Surface {
  const data = new Uint8ClampedArray(input.data);
  const brush = new BrushSettings();
  try {
    brush.antialias = options.antialias;
    brush.blend = options.blend;
    brush.hatch = options.hatch;
    brush.r = options.color.r;
    brush.g = options.color.g;
    brush.b = options.color.b;
    brush.a = options.color.a;
    brush.back_r = options.background.r;
    brush.back_g = options.background.g;
    brush.back_b = options.background.b;
    brush.back_a = options.background.a;
    bucketFillRgba8(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      input.width,
      input.height,
      mask,
      brush,
    );
  } finally {
    brush.free();
  }
  return new Surface(input.width, input.height, data);
}

/**
 * Paints one pencil stroke (TL-PENCIL-01) on the CPU and returns a new surface. `path` is flat
 * `x, y` pairs in canvas pixels, and `blend` is a layer blend value or 14 for Overwrite.
 */
export function strokePencilCpu(
  input: Surface,
  path: Float32Array,
  color: ColorRgba8,
  blend: number,
): Surface {
  const data = new Uint8ClampedArray(input.data);
  pencilStrokeRgba8(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    input.width,
    input.height,
    path,
    color.r,
    color.g,
    color.b,
    color.a,
    blend,
  );
  return new Surface(input.width, input.height, data);
}
