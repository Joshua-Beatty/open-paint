/**
 * What the main thread and the engine worker share about GPU effects. It imports no shaders, so the
 * main thread can name the GPU effects without loading their WGSL.
 */

/**
 * The built-in effects that run their WGSL twin on the engine's device (WEB-GPU-01). Quantize has
 * no WGSL implementation and always runs its Rust reference: its default dithering diffuses each
 * pixel's error into the next ones, a serial dependency over the whole image. The worker's runner
 * table has exactly these ids (tested).
 */
export const GPU_EFFECT_IDS: ReadonlySet<string> = new Set([
  "gaussian-blur",
  "square-blur",
  "invertColors",
  "invertAlpha",
  "blackAndWhite",
  "sepia",
  "brightnessContrast",
  "hueSaturation",
  "posterize",
  "levels",
  "curves",
  "exposure",
  "temperatureTint",
  "autoLevel",
  "highlightsShadows",
  "bulge",
  "twist",
  "polarInversion",
  "tileReflection",
  "crystalize",
  "dents",
  "frostedGlass",
  "pixelate",
  "morphology",
  "fragment-blur",
  "motion-blur",
  "radial-blur",
  "zoom-blur",
  "median-blur",
  "surface-blur",
  "sketch-blur",
  "bokeh-blur",
  "add-noise",
  "reduce-noise",
  "ink-sketch",
  "oil-painting",
  "pencil-sketch",
  "glow",
  "soften-portrait",
  "sharpen",
  "straighten",
  "vignette",
  "rotate-zoom",
  "clouds",
  "turbulence",
  "julia",
  "mandelbrot",
  "edge-detect",
  "emboss",
  "relief",
  "outline",
  "drop-shadow",
  "align-object",
  "flip-horizontal",
  "flip-vertical",
  "red-eye",
]);

/**
 * One effect run sent to the engine worker. The source pixels and the selection coverage are sent
 * with the first run of a session and kept in the worker under `source`, so later previews only
 * send their parameters (L9).
 */
export interface GpuEffectJob {
  readonly id: number;
  readonly effectId: string;
  /** The binding's parameters: plain, cloneable data. */
  readonly params: unknown;
  readonly source: number;
  /** The source pixels (straight RGBA8), when the worker does not hold `source` yet. */
  readonly pixels?: Uint8ClampedArray<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
  /** The selection over the source, sent with `pixels`. Absent means every pixel is selected. */
  readonly coverage?: Uint8Array<ArrayBuffer>;
}

/** The output of one run, transferred back to the main thread. */
export interface GpuEffectOutput {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * The job id of Move Selected Pixels' resampling (TL-MOVE-PIX-01): it runs like an effect on a
 * source kept on the GPU, with a `GpuTransformSpec` as its parameters.
 */
export const TRANSFORM_JOB = "tool:transform";

/** The name of the error a run rejects with when the worker no longer holds its source. */
export const GPU_SOURCE_MISSING = "GpuSourceMissing";
