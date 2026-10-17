import { bytesOf, EMPTY_RECT, type Rect, rectFromEdges, type Surface } from "@openpaint/document";
import { type BrushOptions, brushSettingsOf } from "./brush";
import {
  type BrushSettings,
  brushCoverDabs,
  brushStampDabsRgba8,
  cloneStampDabsRgba8,
  DabPlanner,
} from "./cpu";

/**
 * A brush stroke drawn while its samples arrive (TL-BRUSH-01), on the CPU. Each call stamps only
 * the dabs that are new, so a frame costs the new part of the stroke rather than all of it. Over
 * the whole stroke the dabs, their order and the pixels are those of `strokeBrush`, except that
 * hatch patterns are anchored to the image origin. Points and dabs are in image pixels. Call
 * `free` when done.
 */
export class LiveBrushStroke {
  readonly #settings: BrushSettings;
  readonly #planner: DabPlanner;

  constructor(options: BrushOptions) {
    this.#settings = brushSettingsOf(options);
    this.#planner = new DabPlanner(this.#settings);
  }

  /** Adds samples (`x, y, pressure` triples) and returns the dabs that became final. */
  push(path: Float32Array): Float32Array {
    return new Float32Array(this.#planner.push(path));
  }

  /**
   * The dabs that smoothing still holds back for the newest samples. They belong in a preview but
   * may move as more samples come, so they are not final.
   */
  tail(): Float32Array {
    return new Float32Array(this.#planner.tail());
  }

  /** Ends the stroke and returns its remaining dabs. */
  finish(): Float32Array {
    return new Float32Array(this.#planner.finish());
  }

  /**
   * Adds `dabs` to the stroke on `surface`, whose top-left pixel is image pixel (`originX`,
   * `originY`). `original` holds the pixels before the stroke and `cover` the stroke's coverage so
   * far (one byte per pixel), both the size of `surface`. The coverage is the largest of any dab,
   * and a pixel is painted from its original once per coverage rise, so soft dabs keep their
   * falloff across the stroke instead of building up (TL-BRUSH-01).
   */
  stamp(
    surface: Surface,
    original: Surface,
    cover: Uint8Array,
    originX: number,
    originY: number,
    dabs: Float32Array,
  ): void {
    if (dabs.length === 0) return;
    brushStampDabsRgba8(
      bytesOf(surface),
      bytesOf(original),
      cover,
      surface.width,
      surface.height,
      originX,
      originY,
      dabs,
      this.#settings,
    );
  }

  /**
   * Clones `dabs` from `source` onto `surface` (TL-BRUSH-CS-01), with `original` and `cover` as
   * for `stamp`, all the same size with their top-left pixel at image pixel (`originX`,
   * `originY`). Over a whole stroke this matches `cloneStrokeCpu`.
   */
  stampClone(
    surface: Surface,
    original: Surface,
    source: Surface,
    cover: Uint8Array,
    originX: number,
    originY: number,
    dabs: Float32Array,
  ): void {
    if (dabs.length === 0) return;
    cloneStampDabsRgba8(
      bytesOf(surface),
      bytesOf(original),
      bytesOf(source),
      cover,
      surface.width,
      surface.height,
      originX,
      originY,
      dabs,
      this.#settings,
    );
  }

  /**
   * Raises each byte of a `width` × `height` coverage buffer, whose top-left pixel is image pixel
   * (`originX`, `originY`), to the tip coverage of `dabs` over it. Over a whole stroke this is the
   * stroke coverage that the Recolor brush masks with (TL-BRUSH-RC-01).
   */
  cover(
    cover: Uint8Array,
    width: number,
    height: number,
    originX: number,
    originY: number,
    dabs: Float32Array,
  ): void {
    if (dabs.length === 0) return;
    brushCoverDabs(cover, width, height, originX, originY, dabs, this.#settings);
  }

  free(): void {
    this.#planner.free();
    this.#settings.free();
  }
}

/** The integer image rectangle that dabs (`x, y, diameter` triples) can touch. Empty for none. */
export function dabBounds(dabs: Float32Array): Rect {
  if (dabs.length === 0) return EMPTY_RECT;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 2 < dabs.length; i += 3) {
    const r = (dabs[i + 2] ?? 0) / 2;
    const x = dabs[i] ?? 0;
    const y = dabs[i + 1] ?? 0;
    left = Math.min(left, x - r);
    top = Math.min(top, y - r);
    right = Math.max(right, x + r);
    bottom = Math.max(bottom, y + r);
  }
  return rectFromEdges(Math.floor(left), Math.floor(top), Math.ceil(right), Math.ceil(bottom));
}
