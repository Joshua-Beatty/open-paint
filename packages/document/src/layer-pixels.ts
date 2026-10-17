import { composite_rgba8 } from "@openpaint/cpu";
import type { LayerBlendMode } from "./blend-mode";
import type { ColorRgba8 } from "./color";
import { type Rect, rect } from "./geometry";
import type { ImageRotation } from "./image-transform";
import { type ResampleOptions, type ResampleRunner, resampleSurface } from "./resample";
import { bytesOf, Surface } from "./surface";
import { TiledPixelStore, type TiledPixelStoreOptions } from "./tiled-store";

/**
 * Whole-layer pixel operations. Each one builds a new store and leaves its source untouched, so
 * an out-of-memory failure (OutOfMemoryError) changes nothing. The caller swaps the result in.
 */

/** A layer's pixels with the blend mode and opacity used to composite it (DOC-BLD-02). */
export interface CompositeSource {
  readonly pixels: TiledPixelStore;
  readonly blendMode: LayerBlendMode;
  readonly opacity: number;
}

/** Flips applied to the source coordinates, then an optional swap of x and y. */
interface LayerOrientation {
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly swap: boolean;
}

const ROTATION_ORIENTATIONS: Record<ImageRotation, LayerOrientation> = {
  cw: { flipX: false, flipY: true, swap: true },
  ccw: { flipX: true, flipY: false, swap: true },
  half: { flipX: true, flipY: true, swap: false },
};

/** A copy of `source` with its own tiles, in the same budget. */
export function cloneLayerPixels(source: TiledPixelStore): TiledPixelStore {
  return orientLayerPixels(source, { flipX: false, flipY: false, swap: false });
}

/** `source` mirrored left-to-right and/or top-to-bottom (lossless, DOC-LYR-05f..h, DOC-IMG-04/05). */
export function mirrorLayerPixels(
  source: TiledPixelStore,
  flipX: boolean,
  flipY: boolean,
): TiledPixelStore {
  return orientLayerPixels(source, { flipX, flipY, swap: false });
}

/** `source` rotated losslessly (DOC-IMG-06/07/08). A 90° turn swaps the width and height. */
export function rotateLayerPixels(
  source: TiledPixelStore,
  rotation: ImageRotation,
): TiledPixelStore {
  return orientLayerPixels(source, ROTATION_ORIENTATIONS[rotation]);
}

/**
 * `source` resampled to `width` x `height` (DOC-IMG-02). Every layer of a document uses the same
 * target size, so each layer is resampled from its own full-size bitmap.
 */
export function resampleLayerPixels(
  source: TiledPixelStore,
  width: number,
  height: number,
  options: ResampleOptions,
): TiledPixelStore {
  return layerFromSurface(
    source,
    width,
    height,
    resampleSurface(source.readRegion(source.bounds), width, height, options),
  );
}

/**
 * The pixels written between two pauses when a resampled layer is stored (PRD-NF-02): a few
 * milliseconds of copying, so the pauses (at least 4 ms each once timers nest) do not dominate (L10).
 */
const STORE_SLICE_PIXELS = 1 << 21;

/**
 * `resampleLayerPixels`, with the resample run by `resample` (DOC-IMG-02 with progress). The result
 * is stored in row slices, with `pause` before each, so no slice holds the main thread for long.
 */
export async function resampleLayerPixelsWith(
  source: TiledPixelStore,
  width: number,
  height: number,
  options: ResampleOptions,
  resample: ResampleRunner,
  pause: () => Promise<void> = async () => {},
): Promise<TiledPixelStore> {
  const surface = await resample(source.readRegion(source.bounds), width, height, options);
  const out = new TiledPixelStore(width, height, storeOptions(source));
  const sliceRows = Math.max(1, Math.floor(STORE_SLICE_PIXELS / width));
  try {
    for (let top = 0; top < height; top += sliceRows) {
      await pause();
      const rows = Math.min(sliceRows, height - top);
      out.writeRegion(surface, 0, top, rect(0, top, width, rows));
    }
  } catch (error) {
    out.dispose();
    throw error;
  }
  return out;
}

/** A new store of the source's tile settings that holds `surface` at the origin. */
function layerFromSurface(
  source: TiledPixelStore,
  width: number,
  height: number,
  surface: Surface,
): TiledPixelStore {
  const out = new TiledPixelStore(width, height, storeOptions(source));
  try {
    out.writeRegion(surface, 0, 0);
  } catch (error) {
    out.dispose();
    throw error;
  }
  return out;
}

/**
 * `source` placed on a `width` x `height` canvas with its top-left pixel at (`x`, `y`) (DOC-IMG-03).
 * Every area the source does not cover is `fill`, including transparent.
 */
export function placeLayerPixels(
  source: TiledPixelStore,
  width: number,
  height: number,
  x: number,
  y: number,
  fill: ColorRgba8,
): TiledPixelStore {
  const out = new TiledPixelStore(width, height, storeOptions(source));
  try {
    out.fill(fill);
    for (const { tx, ty } of source.allocatedTiles()) {
      const area = source.tileBounds(tx, ty);
      out.writeRegion(source.readRegion(area), area.x + x, area.y + y);
    }
  } catch (error) {
    out.dispose();
    throw error;
  }
  return out;
}

/**
 * Composites `upper` onto a copy of `lower` with the upper layer's blend mode and opacity
 * (DOC-LYR-05d, DOC-BLD-02). Only tiles that `upper` allocates can change the result.
 */
export function compositeLayerPixels(
  lower: TiledPixelStore,
  upper: TiledPixelStore,
  mode: LayerBlendMode,
  opacity: number,
): TiledPixelStore {
  const out = cloneLayerPixels(lower);
  try {
    compositeInto(out, upper, mode, opacity);
  } catch (error) {
    out.dispose();
    throw error;
  }
  return out;
}

/**
 * A new store of the document size with `layers` composited bottom to top over transparent
 * (DOC-IMG-09). `layers` must already exclude hidden layers.
 */
export function flattenLayerPixels(
  layers: readonly CompositeSource[],
  width: number,
  height: number,
  options: TiledPixelStoreOptions,
): TiledPixelStore {
  const out = new TiledPixelStore(width, height, options);
  try {
    for (const layer of layers) compositeInto(out, layer.pixels, layer.blendMode, layer.opacity);
  } catch (error) {
    out.dispose();
    throw error;
  }
  return out;
}

/**
 * The layers composited bottom to top over transparency inside `area` (DOC-CLP-01c). The result
 * has the area's size. `layers` must already exclude hidden layers.
 */
export function flattenRegion(layers: readonly CompositeSource[], area: Rect): Surface {
  const out = new Surface(area.width, area.height);
  for (const layer of layers) {
    const upper = layer.pixels.readRegion(area);
    composite_rgba8(bytesOf(out), bytesOf(upper), layer.blendMode, layer.opacity);
  }
  return out;
}

/** Composites `upper` into `target` in place. Only tiles that `upper` allocates are touched. */
function compositeInto(
  target: TiledPixelStore,
  upper: TiledPixelStore,
  mode: LayerBlendMode,
  opacity: number,
): void {
  for (const { tx, ty } of upper.allocatedTiles()) {
    const area = upper.tileBounds(tx, ty);
    const dst = target.readRegion(area);
    composite_rgba8(bytesOf(dst), bytesOf(upper.readRegion(area)), mode, opacity);
    target.writeRegion(dst, area.x, area.y);
  }
}

function storeOptions(source: TiledPixelStore): TiledPixelStoreOptions {
  return { accountant: source.accountant, colorProfile: source.colorProfile };
}

/**
 * Remaps every allocated tile of `source` through the flips and the optional swap. A tile's
 * pixels stay a rectangle under these maps, so each tile is copied as one block.
 */
function orientLayerPixels(
  source: TiledPixelStore,
  orientation: LayerOrientation,
): TiledPixelStore {
  const { flipX, flipY, swap } = orientation;
  const out = new TiledPixelStore(
    swap ? source.height : source.width,
    swap ? source.width : source.height,
    storeOptions(source),
  );
  try {
    for (const { tx, ty } of source.allocatedTiles()) {
      const area = source.tileBounds(tx, ty);
      const x = flipX ? source.width - area.x - area.width : area.x;
      const y = flipY ? source.height - area.y - area.height : area.y;
      const from = u32View(source.readRegion(area));
      const block = swap
        ? new Surface(area.height, area.width)
        : new Surface(area.width, area.height);
      const to = u32View(block);
      for (let j = 0; j < area.height; j++) {
        const localY = flipY ? area.height - 1 - j : j;
        for (let i = 0; i < area.width; i++) {
          const localX = flipX ? area.width - 1 - i : i;
          const index = swap ? localX * area.height + localY : localY * area.width + localX;
          to[index] = from[j * area.width + i] ?? 0;
        }
      }
      out.writeRegion(block, swap ? y : x, swap ? x : y);
    }
  } catch (error) {
    out.dispose();
    throw error;
  }
  return out;
}

/** A `Uint32Array` view of a surface's pixels. Surfaces are created fresh, so the offset is 0. */
function u32View(surface: Surface): Uint32Array {
  return new Uint32Array(
    surface.data.buffer,
    surface.data.byteOffset,
    surface.width * surface.height,
  );
}
