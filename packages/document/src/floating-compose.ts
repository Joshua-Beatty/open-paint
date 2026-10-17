import { transform_rows_rgba8 } from "@openpaint/cpu";
import { isIntegerTranslation } from "./affine";
import { type CoverageRuns, coverageRuns, placeByCoverage } from "./coverage-place";
import { type Rect, rect, rectsEqual } from "./geometry";
import {
  renderTransformed,
  TRANSFORM_SAMPLINGS,
  type TransformedPixels,
  type TransformOptions,
  transformPlan,
} from "./pixel-transform";
import { Selection } from "./selection";
import {
  type AffineMatrix,
  rectPolygon,
  type SelectionPolygon,
  type SelectionQuality,
} from "./selection-polygons";
import { bytesOf, Surface } from "./surface";

/**
 * The floating content of a Move Selected Pixels session and how it lands on the layer: the
 * reference `FloatingPixels` previews and records with, and the CPU worker commits with.
 */
export class FloatingSource {
  /** The content's coverage runs, for placing it moved by whole pixels. Made on first use. */
  #runs: CoverageRuns | undefined;
  /** The shape the content covers, in its own coordinates, for transforms that resample it. */
  #shape: Selection | undefined;

  constructor(
    /** Straight RGBA. Its pixel (0, 0) is mapped by the transform from its own top-left corner. */
    readonly pixels: Surface,
    /** The selection's coverage of the content, in its pixels. Undefined covers all of it. */
    readonly coverage: Uint8Array | undefined,
    /** The selection outline in the content's own coordinates. Empty covers the content's bounds. */
    readonly outline: readonly SelectionPolygon[],
    readonly quality: SelectionQuality,
  ) {}

  /** The selection outline, or the content's bounds when nothing was selected, as one shape. */
  get shape(): Selection {
    this.#shape ??= new Selection(
      this.outline.length > 0 ? this.outline : [rectPolygon(this.pixels.bounds)],
      this.quality,
    );
    return this.#shape;
  }

  /**
   * The part `region` of `area` (canvas pixels) with the content placed on `base` (the size of
   * `area`) at `m`, into `out` when given (the size of `region`). Inside the moved selection the
   * content replaces the base, transparent pixels included, and its antialiased edge blends by
   * coverage (`placeByCoverage`). The area must cover the content. A whole-pixel move places the
   * content straight from its own pixels by its coverage runs, since nothing needs resampling. Any
   * other transform resamples the content with `options` and covers it with the moved selection
   * shape. `resampled` is the content already resampled within the content bounds (null: none).
   */
  compose(
    base: Surface,
    area: Rect,
    region: Rect,
    m: AffineMatrix,
    options: TransformOptions,
    out?: Surface,
    resampled?: TransformedPixels | null,
  ): Surface {
    const result = out ?? new Surface(region.width, region.height);
    if (rectsEqual(region, area)) result.data.set(base.data);
    else
      result.copyFrom(
        base,
        rect(region.x - area.x, region.y - area.y, region.width, region.height),
        0,
        0,
      );
    if (isIntegerTranslation(m)) {
      const { width, height } = this.pixels;
      this.#runs ??= coverageRuns(width, height, this.coverage);
      placeByCoverage(
        result,
        this.pixels,
        m.e - region.x,
        m.f - region.y,
        this.coverage,
        this.#runs,
      );
      return result;
    }
    const drawn =
      resampled === undefined
        ? renderTransformed(this.pixels, m, options, region)
        : (resampled ?? undefined);
    if (drawn) {
      const { x, y } = drawn.origin;
      const covered = rect(x, y, drawn.pixels.width, drawn.pixels.height);
      const coverage = this.shape.transform(m).mask(covered);
      placeByCoverage(result, drawn.pixels, x - region.x, y - region.y, coverage);
    }
    return result;
  }
}

/** One placement of the content: where it lands and how it is resampled. */
export interface FloatingStep {
  readonly transform: AffineMatrix;
  readonly options: TransformOptions;
}

/**
 * Everything a commit of a floating session computes from, as it crosses to a worker: the content,
 * the base of the session's area, the copies left behind since the base was made (`stamps`, oldest
 * first) and the placement to record.
 */
export interface FloatingComposeJob {
  readonly pixels: Surface;
  readonly coverage: Uint8Array | undefined;
  readonly outline: readonly SelectionPolygon[];
  readonly quality: SelectionQuality;
  readonly area: Rect;
  readonly base: Surface;
  readonly stamps: readonly FloatingStep[];
  readonly placement: FloatingStep;
}

/** What a commit computed: the area as recorded, and the base with the stamps drawn into it. */
export interface FloatingComposeResult {
  readonly drawn: Surface;
  readonly base: Surface;
}

/** Computes a commit with the reference, in this realm. */
export function composeFloating(job: FloatingComposeJob): FloatingComposeResult {
  const source = new FloatingSource(job.pixels, job.coverage, job.outline, job.quality);
  let base = job.base;
  for (const stamp of job.stamps) {
    base = source.compose(base, job.area, job.area, stamp.transform, stamp.options);
  }
  const { transform, options } = job.placement;
  return { drawn: source.compose(base, job.area, job.area, transform, options), base };
}

/**
 * Rows `first .. first + count` of `composeFloating`'s result and base, byte for byte, from `base`
 * holding only those rows of the job's base: every step is per pixel (the resample through
 * `transform_rows_rgba8` with the whole result's inverse, the coverage sliced from the whole
 * mask), so bands computed apart join into the whole result.
 */
export function composeFloatingRows(
  job: FloatingComposeJob,
  first: number,
  count: number,
): FloatingComposeResult {
  const source = new FloatingSource(job.pixels, job.coverage, job.outline, job.quality);
  const { area } = job;
  const band = rect(area.x, area.y + first, area.width, count);
  if (job.base.width !== band.width || job.base.height !== band.height) {
    throw new RangeError("The base must hold the band's rows.");
  }
  const step = (base: Surface, { transform: m, options }: FloatingStep): Surface => {
    const result = base.clone();
    if (isIntegerTranslation(m)) {
      placeByCoverage(result, source.pixels, m.e - band.x, m.f - band.y, source.coverage);
      return result;
    }
    const plan = transformPlan(source.pixels, m, area);
    if (plan === undefined || plan.inverse === undefined) return result;
    const { bounds, inverse } = plan;
    const top = Math.max(bounds.y, band.y);
    const bottom = Math.min(bounds.y + bounds.height, band.y + band.height);
    if (top >= bottom) return result;
    const rows = bottom - top;
    const pixels = transform_rows_rgba8(
      bytesOf(source.pixels),
      source.pixels.width,
      source.pixels.height,
      bounds.width,
      bounds.height,
      new Float64Array(inverse),
      TRANSFORM_SAMPLINGS.indexOf(options.sampling),
      options.linearLight,
      top - bounds.y,
      rows,
    );
    const mask = source.shape.transform(m).mask(bounds);
    const from = (top - bounds.y) * bounds.width;
    placeByCoverage(
      result,
      new Surface(bounds.width, rows, new Uint8ClampedArray(pixels)),
      bounds.x - band.x,
      top - band.y,
      mask.subarray(from, from + rows * bounds.width),
    );
    return result;
  };
  let base = job.base;
  for (const stamp of job.stamps) base = step(base, stamp);
  return { drawn: step(base, job.placement), base };
}

/** Runs a commit elsewhere, such as in the CPU worker. It rejects when it fails. */
export type FloatingComposer = (job: FloatingComposeJob) => Promise<FloatingComposeResult>;
