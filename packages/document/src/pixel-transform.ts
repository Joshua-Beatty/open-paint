import { transform_rgba8 } from "@openpaint/cpu";
import { affineBounds, invertAffine, isIntegerTranslation, translationAffine } from "./affine";
import { intersectRects, isEmptyRect, type Point, type Rect, rect } from "./geometry";
import type { AffineMatrix } from "./selection-polygons";
import { composeAffine } from "./selection-polygons";
import { bytesOf, Surface } from "./surface";

/**
 * The TL-OPT-RESAMP choices of Move Selected Pixels. The index of each name is its WASM sampling id
 * in `crates/opaint-cpu/src/transform.rs`, so keep the two lists in the same order.
 */
export const TRANSFORM_SAMPLINGS = [
  "nearest",
  "linear",
  "multisample",
  "anisotropic",
  "cubic",
] as const;

export type TransformSampling = (typeof TRANSFORM_SAMPLINGS)[number];

export interface TransformOptions {
  readonly sampling: TransformSampling;
  /** Resample in linear light (TL-OPT-GAMMA "Gamma Corrected"). */
  readonly linearLight: boolean;
}

export interface TransformedPixels {
  readonly pixels: Surface;
  /** Where the pixels' top-left corner sits in the target's coordinates. */
  readonly origin: Point;
}

/**
 * Resamples `source` into a `width` x `height` surface through `inverse` (`a, b, c, d, e, f`, from
 * destination pixel centers to source coordinates) with the TL-OPT-RESAMP sampling id: what
 * `transform_rgba8` computes, done elsewhere, such as on the GPU for a preview. It rejects when it
 * fails or `signal` aborts. The same `source` object is passed for every frame of a session.
 */
export type TransformResampler = (
  source: Surface,
  spec: {
    readonly width: number;
    readonly height: number;
    readonly inverse: readonly number[];
    readonly sampling: number;
    readonly linearLight: boolean;
  },
  signal: AbortSignal,
) => Promise<Surface>;

/**
 * Where `source` lands after `m` within `clip`, and the inverse map that resamples it there, or
 * undefined when nothing lands in `clip`. A whole-pixel translation needs no resampling and has no
 * inverse.
 */
export function transformPlan(
  source: Surface,
  m: AffineMatrix,
  clip: Rect,
): { readonly bounds: Rect; readonly inverse: readonly number[] | undefined } | undefined {
  const bounds = intersectRects(affineBounds(source.bounds, m), clip);
  if (isEmptyRect(bounds)) return undefined;
  if (isIntegerTranslation(m)) return { bounds, inverse: undefined };
  const inverse = composeAffine(invertAffine(m), translationAffine(bounds.x, bounds.y));
  return { bounds, inverse: [inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f] };
}

/**
 * `renderTransformed` with the resampling done by `resample` (asynchronously, e.g. on the GPU)
 * when `m` needs it. Resolves undefined when nothing lands in `clip`.
 */
export async function renderTransformedWith(
  resample: TransformResampler,
  source: Surface,
  m: AffineMatrix,
  options: TransformOptions,
  clip: Rect,
  signal: AbortSignal,
): Promise<TransformedPixels | undefined> {
  const plan = transformPlan(source, m, clip);
  if (plan === undefined) return undefined;
  if (plan.inverse === undefined) return renderTransformed(source, m, options, clip);
  const { bounds, inverse } = plan;
  const pixels = await resample(
    source,
    {
      width: bounds.width,
      height: bounds.height,
      inverse,
      sampling: TRANSFORM_SAMPLINGS.indexOf(options.sampling),
      linearLight: options.linearLight,
    },
    signal,
  );
  if (pixels.width !== bounds.width || pixels.height !== bounds.height) {
    throw new RangeError("The resampler returned the wrong size.");
  }
  return { pixels, origin: { x: bounds.x, y: bounds.y } };
}

/**
 * The pixels of `source` after `m`, restricted to `clip`. Pixel (0, 0) of `source` is mapped by `m`
 * from its own top-left corner. A whole-pixel translation copies the pixels exactly, so nothing is
 * resampled. Any other transform resamples with `options`. Returns undefined when nothing lands in
 * `clip`.
 */
export function renderTransformed(
  source: Surface,
  m: AffineMatrix,
  options: TransformOptions,
  clip: Rect,
): TransformedPixels | undefined {
  const bounds = intersectRects(affineBounds(source.bounds, m), clip);
  if (isEmptyRect(bounds)) return undefined;
  if (isIntegerTranslation(m)) {
    const pixels = new Surface(bounds.width, bounds.height);
    const full = affineBounds(source.bounds, m);
    pixels.copyFrom(
      source,
      rect(bounds.x - full.x, bounds.y - full.y, bounds.width, bounds.height),
      0,
      0,
    );
    return { pixels, origin: { x: bounds.x, y: bounds.y } };
  }
  const inverse = composeAffine(invertAffine(m), translationAffine(bounds.x, bounds.y));
  const out = transform_rgba8(
    bytesOf(source),
    source.width,
    source.height,
    bounds.width,
    bounds.height,
    new Float64Array([inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f]),
    TRANSFORM_SAMPLINGS.indexOf(options.sampling),
    options.linearLight,
  );
  return {
    pixels: new Surface(bounds.width, bounds.height, new Uint8ClampedArray(out)),
    origin: { x: bounds.x, y: bounds.y },
  };
}
