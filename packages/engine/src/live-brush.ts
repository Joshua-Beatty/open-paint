import { bytesOf, EMPTY_RECT, type Rect, rectFromEdges, type Surface } from "@openpaint/document";
import { type BrushOptions, brushSettingsOf } from "./brush";
import { partRadius } from "./brush-segments";
import {
  type BrushSettings,
  brushCoverDabs,
  brushStampDabsRgba8,
  brushValuesCoverage,
  cloneStampDabsRgba8,
  DabPlanner,
} from "./cpu";

/**
 * A brush stroke drawn while its samples arrive (TL-BRUSH-01), on the CPU. Each call adds only
 * the dabs that are new, so a frame costs the new part of the stroke rather than all of it. Over
 * the whole stroke the dabs, their order and the pixels are those of `strokeBrush`, except that
 * hatch patterns are anchored to the image origin. Points and dabs are in image pixels.
 *
 * The stroke keeps two words per pixel (`values`, see `brush_cover_dabs`). When the brush joins
 * its dabs (spacing below 100 %), each batch after the first starts with the last dab before it,
 * and `starts` / `ends` say whether a batch holds the stroke's start and end: batches from `push`
 * never end it, the tail and the final batch do. Call `free` when done.
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

  /** Whether the last batch from `push` or `finish` begins at the stroke's first dab. */
  get starts(): boolean {
    return this.#planner.starts();
  }

  /**
   * The dabs that smoothing still holds back for the newest samples, through the stroke's end.
   * They belong in a preview but may move as more samples come, so they are not final.
   */
  tail(): Float32Array {
    return new Float32Array(this.#planner.tail());
  }

  /** Whether the batch from `tail` begins at the stroke's first dab. */
  get tailStarts(): boolean {
    return this.#planner.tail_starts();
  }

  /** Ends the stroke and returns its remaining dabs, which end it. */
  finish(): Float32Array {
    return new Float32Array(this.#planner.finish());
  }

  /**
   * Adds `dabs` to the stroke on `surface`, whose top-left pixel is image pixel (`originX`,
   * `originY`). `original` holds the pixels before the stroke and `values` the stroke's two words
   * per pixel so far, both the size of `surface`. Each pixel whose coverage changes is painted
   * again from its original (TL-BRUSH-01).
   */
  stamp(
    surface: Surface,
    original: Surface,
    values: Uint32Array,
    originX: number,
    originY: number,
    dabs: Float32Array,
    starts: boolean,
    ends: boolean,
  ): void {
    if (dabs.length === 0) return;
    brushStampDabsRgba8(
      bytesOf(surface),
      bytesOf(original),
      values,
      surface.width,
      surface.height,
      originX,
      originY,
      dabs,
      starts,
      ends,
      this.#settings,
    );
  }

  /**
   * Clones `dabs` from `source` onto `surface` (TL-BRUSH-CS-01), with `original` and `values` as
   * for `stamp`, all the same size with their top-left pixel at image pixel (`originX`,
   * `originY`). Over a whole stroke this matches `cloneStrokeCpu`.
   */
  stampClone(
    surface: Surface,
    original: Surface,
    source: Surface,
    values: Uint32Array,
    originX: number,
    originY: number,
    dabs: Float32Array,
    starts: boolean,
    ends: boolean,
  ): void {
    if (dabs.length === 0) return;
    cloneStampDabsRgba8(
      bytesOf(surface),
      bytesOf(original),
      bytesOf(source),
      values,
      surface.width,
      surface.height,
      originX,
      originY,
      dabs,
      starts,
      ends,
      this.#settings,
    );
  }

  /**
   * Adds `dabs` to a `width` × `height` buffer of the stroke's two words per pixel, whose top-left
   * pixel is image pixel (`originX`, `originY`). `coverage` turns them into the stroke coverage
   * that the Recolor brush masks with (TL-BRUSH-RC-01).
   */
  cover(
    values: Uint32Array,
    width: number,
    height: number,
    originX: number,
    originY: number,
    dabs: Float32Array,
    starts: boolean,
    ends: boolean,
  ): void {
    if (dabs.length === 0) return;
    brushCoverDabs(values, width, height, originX, originY, dabs, starts, ends, this.#settings);
  }

  /** The 8-bit coverage of the stroke's two words per pixel. */
  coverage(values: Uint32Array): Uint8Array {
    return brushValuesCoverage(values, this.#settings);
  }

  free(): void {
    this.#planner.free();
    this.#settings.free();
  }
}

/**
 * The integer image rectangle that dabs (`x, y, diameter` triples) can change, with everything a
 * stroke's parts between and around them reach. Empty for none.
 */
export function dabBounds(dabs: Float32Array): Rect {
  if (dabs.length === 0) return EMPTY_RECT;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + 2 < dabs.length; i += 3) {
    const r = partRadius(dabs[i + 2] ?? 0, true, false);
    const x = dabs[i] ?? 0;
    const y = dabs[i + 1] ?? 0;
    left = Math.min(left, x - r);
    top = Math.min(top, y - r);
    right = Math.max(right, x + r);
    bottom = Math.max(bottom, y + r);
  }
  return rectFromEdges(Math.floor(left), Math.floor(top), Math.ceil(right), Math.ceil(bottom));
}
