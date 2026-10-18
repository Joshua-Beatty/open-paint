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
 * The stroke keeps four words per pixel (`values`, see `brush_cover_dabs`). When the brush joins
 * its dabs (spacing below 100 %), each batch after the first starts with the last dab before it,
 * `starts` / `ends` say whether a batch holds the stroke's start and end (batches from `push`
 * never end it, the tail and the final batch do) and `arc` where it begins along the stroke. The
 * planner keeps the stroke's earlier parts, which the kernels read where the stroke passes over
 * itself. Call `free` when done.
 */
export class LiveBrushStroke {
  readonly #settings: BrushSettings;
  readonly #planner: DabPlanner;

  constructor(options: BrushOptions) {
    this.#settings = brushSettingsOf(options);
    this.#planner = new DabPlanner(this.#settings);
  }

  /** Adds samples (`x, y, pressure` triples) and returns the batch of dabs that became final. */
  push(path: Float32Array): StrokeBatch {
    const dabs = new Float32Array(this.#planner.push(path));
    const starts = this.#planner.starts();
    return { dabs, starts, ends: false, arc: this.#planner.arc(), provisional: false };
  }

  /**
   * The dabs that smoothing still holds back for the newest samples, through the stroke's end.
   * They belong in a preview but may move as more samples come, so the batch is provisional.
   */
  tail(): StrokeBatch {
    const dabs = new Float32Array(this.#planner.tail());
    const starts = this.#planner.tail_starts();
    return { dabs, starts, ends: true, arc: this.#planner.tail_arc(), provisional: true };
  }

  /** Ends the stroke and returns its remaining dabs, which end it. */
  finish(): StrokeBatch {
    const dabs = new Float32Array(this.#planner.finish());
    const starts = this.#planner.starts();
    return { dabs, starts, ends: true, arc: this.#planner.arc(), provisional: false };
  }
  /**
   * Adds `dabs` to the stroke on `surface`, whose top-left pixel is image pixel (`originX`,
   * `originY`). `original` holds the pixels before the stroke and `values` the stroke's four words
   * per pixel so far, both the size of `surface`. `batch` places the dabs in the stroke; a
   * provisional batch (the tail) is drawn but not part of the stroke's history. Each pixel whose
   * values change is painted again from its original (TL-BRUSH-01).
   */
  stamp(
    surface: Surface,
    original: Surface,
    values: Uint32Array,
    originX: number,
    originY: number,
    batch: StrokeBatch,
  ): void {
    if (batch.dabs.length === 0) return;
    brushStampDabsRgba8(
      bytesOf(surface),
      bytesOf(original),
      values,
      surface.width,
      surface.height,
      originX,
      originY,
      batch.dabs,
      batch.starts,
      batch.ends,
      batch.arc,
      batch.provisional,
      this.#planner,
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
    batch: StrokeBatch,
  ): void {
    if (batch.dabs.length === 0) return;
    cloneStampDabsRgba8(
      bytesOf(surface),
      bytesOf(original),
      bytesOf(source),
      values,
      surface.width,
      surface.height,
      originX,
      originY,
      batch.dabs,
      batch.starts,
      batch.ends,
      batch.arc,
      batch.provisional,
      this.#planner,
      this.#settings,
    );
  }

  /**
   * Adds a batch to a `width` × `height` buffer of the stroke's four words per pixel, whose
   * top-left pixel is image pixel (`originX`, `originY`). `coverage` turns them into the stroke
   * coverage that the Recolor brush masks with (TL-BRUSH-RC-01).
   */
  cover(
    values: Uint32Array,
    width: number,
    height: number,
    originX: number,
    originY: number,
    batch: StrokeBatch,
  ): void {
    if (batch.dabs.length === 0) return;
    const { dabs, starts, ends, arc } = batch;
    brushCoverDabs(
      values,
      width,
      height,
      originX,
      originY,
      dabs,
      starts,
      ends,
      arc,
      this.#settings,
    );
  }

  /**
   * The 8-bit coverage of the stroke's four words per pixel over a `width` × `height` buffer whose
   * top-left pixel is image pixel (`originX`, `originY`). `tail` is the provisional batch the
   * values include, if any.
   */
  coverage(
    values: Uint32Array,
    width: number,
    height: number,
    originX: number,
    originY: number,
    tail?: StrokeBatch,
  ): Uint8Array {
    return brushValuesCoverage(
      values,
      width,
      height,
      originX,
      originY,
      tail?.dabs ?? new Float32Array(),
      tail?.starts ?? false,
      tail?.ends ?? false,
      tail?.arc ?? 0,
      this.#planner,
      this.#settings,
    );
  }

  free(): void {
    this.#planner.free();
    this.#settings.free();
  }
}

/** A batch of a live stroke's dabs and where it sits in the stroke (see `LiveBrushStroke`). */
export interface StrokeBatch {
  readonly dabs: Float32Array;
  readonly starts: boolean;
  readonly ends: boolean;
  readonly arc: number;
  /** The tail: drawn, but not part of the stroke's history yet. */
  readonly provisional: boolean;
}

/** The words per pixel of a live stroke's values (`VALUE_WORDS`). */
export const STROKE_VALUE_WORDS = 4;

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
