import { isIntegerTranslation } from "./affine";
import { type CoverageRuns, coverageRuns, placeByCoverage } from "./coverage-place";
import { type Rect, rect, rectsEqual } from "./geometry";
import {
  renderTransformed,
  type TransformedPixels,
  type TransformOptions,
} from "./pixel-transform";
import { Selection } from "./selection";
import {
  type AffineMatrix,
  rectPolygon,
  type SelectionPolygon,
  type SelectionQuality,
} from "./selection-polygons";
import { Surface } from "./surface";

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

/** Runs a commit elsewhere, such as in the CPU worker. It rejects when it fails. */
export type FloatingComposer = (job: FloatingComposeJob) => Promise<FloatingComposeResult>;
