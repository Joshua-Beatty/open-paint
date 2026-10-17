import type { PixelFormat, Rect, Surface } from "@openpaint/document";
import type { PropertyValues } from "@openpaint/properties";
import type { CancellationState } from "./common";

/** The configuration token of an effect (EXT-03-02). Schema tokens are property values. */
export type EffectToken = PropertyValues;

/** Whether an output format is gamma-encoded (integer) or linear (float) (EXT-03-09). */
export type OutputColorSpace = "gamma" | "linear";

/**
 * CPU region effect (EXT-01-01). It writes destination pixels inside the given rectangles and may
 * read any source pixel (EXT-03-05).
 */
export interface CpuRegionEffect {
  render(
    token: EffectToken,
    destination: Surface,
    source: Surface,
    rects: readonly Rect[],
    startIndex: number,
    length: number,
    state: CancellationState,
  ): void;
}

/** The output of one tile of a CPU tile effect (EXT-03-04). */
export interface CpuTileOutput {
  /** The area to render. */
  readonly bounds: Rect;
  /** A writable buffer whose origin is the top-left corner of `bounds`. */
  lock(format: PixelFormat): Uint8ClampedArray;
}

/**
 * CPU tile effect (EXT-01-02). The host calls `render` once per tile. The effect must write the
 * whole buffer, including pixels outside the selection (EXT-03-04).
 */
export interface CpuTileEffect {
  render(token: EffectToken, output: CpuTileOutput, state: CancellationState): void;
  outputColorSpace(format: PixelFormat): OutputColorSpace;
}

/** How a GPU image effect reacts to a token change (EXT-03-06). */
export type TokenChange = "none" | "recreateOutput" | "updateOutput";

/**
 * GPU image effect (EXT-01-03). `TOutput` is the effect graph or image that the engine's effect
 * host builds from its node catalog and WGSL registration.
 */
export interface GpuImageEffect<TOutput = unknown> {
  createOutput(token: EffectToken): TOutput;
  inspectTokenChanges(previous: EffectToken, next: EffectToken): TokenChange;
  updateOutput(output: TOutput, token: EffectToken): void;
  /** Called after GPU device loss, so the effect describes its resources again (WEB-GPU-05). */
  invalidateResources(): void;
}

/**
 * GPU drawing effect (EXT-01-04) and low-level GPU effect (EXT-01-05). They render each tile with
 * `beforeDraw`, one or more `draw` calls and `afterDraw` (EXT-03-07).
 */
export interface GpuDrawingEffect<TContext = unknown> {
  setToken(token: EffectToken): void;
  beforeDraw(context: TContext, renderRect: Rect): void;
  draw(context: TContext, clipRect: Rect): void;
  afterDraw(context: TContext, renderRect: Rect): void;
  invalidateResources(): void;
}

/** A renderer for one effect instance. `kind` matches the descriptor's `kind`. */
export type EffectRenderer =
  | { readonly kind: "cpuRegion"; readonly effect: CpuRegionEffect }
  | { readonly kind: "cpuTile"; readonly effect: CpuTileEffect }
  | { readonly kind: "gpuImage"; readonly effect: GpuImageEffect }
  | { readonly kind: "gpuDrawing" | "gpuLowLevel"; readonly effect: GpuDrawingEffect };
