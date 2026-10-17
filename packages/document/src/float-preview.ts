import type { Rect } from "./geometry";
import type { TransformOptions } from "./pixel-transform";
import type { AffineMatrix, SelectionPolygon, SelectionQuality } from "./selection-polygons";
import type { Surface } from "./surface";

/** The floating pixels of a Move Selected Pixels session. The same object for the whole session. */
export interface FloatContent {
  /** Straight RGBA8. Its pixel (0, 0) is mapped by the transform from its own top-left corner. */
  readonly pixels: Surface;
  /** The selection's coverage of the content, in its pixels, or undefined for all of it. */
  readonly coverage: Uint8Array | undefined;
}

/** What the content is drawn onto: a new object whenever its pixels change. */
export interface FloatBase {
  /** The canvas region the content is drawn in, in canvas pixels. */
  readonly region: Rect;
  /** The layer in `region` with the content taken out. */
  readonly pixels: Surface;
}

/** The content placed at one transform: where it lands, how it is resampled and what covers it. */
export interface FloatPlacement {
  readonly transform: AffineMatrix;
  readonly options: TransformOptions;
  /**
   * The moved selection shape that covers resampled content: normalized rings in canvas pixels,
   * exactly the polygons `Selection.mask` rasterizes for the reference result.
   */
  readonly shape: readonly SelectionPolygon[];
  readonly quality: SelectionQuality;
}

/**
 * Floating content the canvas draws over a layer while Move Selected Pixels previews it, so a
 * preview frame sends only a transform (L2, L9): inside the base's region the layer shows the base
 * with the content placed on it as `placeByCoverage` would, outside it the layer's own pixels.
 * Whole-pixel moves place the content by its own coverage, other transforms resample it and cover
 * it with the moved shape. Earlier placements in `stamps` (Ctrl-drag copies) are drawn into the
 * base first, oldest first. The layer's pixels stay as they are.
 */
export interface LayerFloatPreview extends FloatPlacement {
  readonly content: FloatContent;
  readonly base: FloatBase;
  readonly stamps: readonly FloatPlacement[];
}
