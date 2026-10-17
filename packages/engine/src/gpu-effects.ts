import { Surface } from "@openpaint/document";
import {
  ADD_NOISE_ID,
  ADJUSTMENT_IDS,
  type AddNoiseParams,
  type AdjustmentPlan,
  ALIGN_OBJECT_ID,
  type AlignObjectParams,
  AUTO_LEVEL_ID,
  autoLevelPlan,
  BOKEH_BLUR_ID,
  type BokehBlurParams,
  BULGE_ID,
  BULGE_SAMPLE_MAP_WGSL,
  type BulgeParams,
  bulgePlan,
  CLOUDS_ID,
  type CloudsParams,
  CRYSTALIZE_ID,
  type CrystalizeParams,
  crystalizePlan,
  crystalizeSampleMapWgsl,
  DENTS_ID,
  type DentsParams,
  DROP_SHADOW_ID,
  type DropShadowParams,
  dentsPlan,
  dentsSampleMapWgsl,
  EDGE_DETECT_ID,
  type EdgeBehavior,
  type EdgeDetectParams,
  EMBOSS_ID,
  type EmbossParams,
  FLIP_HORIZONTAL_ID,
  FLIP_VERTICAL_ID,
  type FlipObjectParams,
  FRAGMENT_BLUR_ID,
  FROSTED_GLASS_ID,
  type FragmentBlurParams,
  type FrostedGlassParams,
  GAUSSIAN_BLUR_ID,
  type GaussianBlurParams,
  GLOW_ID,
  type GlowParams,
  HIGHLIGHTS_SHADOWS_ID,
  type HighlightsShadowsParams,
  highlightsShadowsPlan,
  INK_SKETCH_ID,
  type InkSketchParams,
  JULIA_ID,
  type JuliaParams,
  MANDELBROT_ID,
  type MandelbrotParams,
  MEDIAN_BLUR_ID,
  type MedianBlurParams,
  MORPHOLOGY_ID,
  MOTION_BLUR_ID,
  type MorphologyParams,
  type MotionBlurParams,
  OIL_PAINTING_ID,
  type OilPaintingParams,
  OUTLINE_ID,
  type OutlineParams,
  PENCIL_SKETCH_ID,
  type PencilSketchParams,
  PIXELATE_ID,
  type PixelateParams,
  POLAR_INVERSION_ID,
  POLAR_SAMPLE_MAP_WGSL,
  type PolarInversionParams,
  pixelAdjustment,
  planAdjustment,
  polarInversionPlan,
  RADIAL_BLUR_ID,
  type RadialBlurParams,
  RED_EYE_ID,
  REDUCE_NOISE_ID,
  RELIEF_ID,
  type RedEyeParams,
  type ReduceNoiseParams,
  type ReliefParams,
  ROTATE_ZOOM_ID,
  type RotateZoomParams,
  SEPIA_DEFAULT_INTENSITY,
  type SepiaParams,
  SHARPEN_ID,
  type SharpenParams,
  SKETCH_BLUR_ID,
  type SketchBlurParams,
  SOFTEN_PORTRAIT_ID,
  type SoftenPortraitParams,
  SQUARE_BLUR_ID,
  type SquareBlurParams,
  STRAIGHTEN_ID,
  type StraightenParams,
  SURFACE_BLUR_ID,
  type SurfaceBlurParams,
  TILE_REFLECTION_ID,
  TILE_SAMPLE_MAP_WGSL,
  type TileReflectionParams,
  TURBULENCE_ID,
  type TurbulenceParams,
  TWIST_ID,
  TWIST_SAMPLE_MAP_WGSL,
  type TwistParams,
  tileReflectionPlan,
  twistPlan,
  VIGNETTE_ID,
  type VignetteParams,
  ZOOM_BLUR_ID,
  type ZoomBlurParams,
} from "@openpaint/effects";
import { GpuAdjustment } from "./gpu-adjustment";
import { GpuInkSketch, GpuOilPainting, GpuPencilSketch } from "./gpu-artistic";
import { GpuBokehBlur } from "./gpu-bokeh-blur";
import { BufferUsage } from "./gpu-device";
import { GpuFragmentBlur, GpuMotionBlur } from "./gpu-directional-blur";
import { GpuDistortion } from "./gpu-distortion";
import {
  GPU_SOURCE_MISSING,
  type GpuEffectJob,
  type GpuEffectOutput,
  TRANSFORM_JOB,
} from "./gpu-effect-protocol";
import { GpuJulia, GpuMandelbrot } from "./gpu-fractal";
import { GpuFrostedGlass } from "./gpu-frosted-glass";
import { GpuGaussianBlur } from "./gpu-gaussian-blur";
import { GpuMorphology } from "./gpu-morphology";
import { GpuMedianBlur, GpuSketchBlur, GpuSurfaceBlur } from "./gpu-neighborhood-blur";
import { GpuAddNoise, GpuReduceNoise } from "./gpu-noise";
import { GpuAlignObject, GpuDropShadow, GpuFlipObject } from "./gpu-object";
import {
  GpuGlow,
  GpuRotateZoom,
  GpuSharpen,
  GpuSoftenPortrait,
  GpuStraighten,
  GpuVignette,
} from "./gpu-photo";
import { GpuPixelate } from "./gpu-pixelate";
import { GpuRadialBlur, GpuZoomBlur } from "./gpu-radial-zoom-blur";
import { GpuRedEye } from "./gpu-red-eye";
import { GpuClouds, GpuTurbulence } from "./gpu-render";
import { GpuSquareBlur } from "./gpu-square-blur";
import { GpuEdgeDetect, GpuEmboss, GpuOutline, GpuRelief } from "./gpu-stylize";
import { GpuTransform, type GpuTransformSpec } from "./gpu-transform";

/** One effect's WGSL twin over a whole region, as its binding's CPU reference takes it. */
export type GpuEffectRun = (
  input: Surface,
  params: unknown,
  coverage: Uint8Array | undefined,
) => Promise<Surface>;

type Factory = (device: GPUDevice) => GpuEffectRun;

/** A runner whose `run` takes the binding's parameters as they are. */
function direct<P>(
  create: (device: GPUDevice) => { run(input: Surface, params: P): Promise<Surface> },
): Factory {
  return (device) => {
    const runner = create(device);
    return (input, params) => runner.run(input, params as P);
  };
}

/** A distortion effect: its sample map, its plan over the region, and its edge behavior. */
function distortion<P extends { readonly quality: number }>(
  sampleMap: () => string,
  plan: (params: P, width: number, height: number) => Float32Array,
  edge: (params: P) => EdgeBehavior,
): Factory {
  return (device) => {
    const runner = new GpuDistortion(device, sampleMap());
    return (input, raw) => {
      const params = raw as P;
      return runner.run(input, {
        quality: params.quality,
        edge: edge(params),
        mapParams: Array.from(plan(params, input.width, input.height)),
      });
    };
  };
}

/** An adjustment run by the shared adjustment shader from its plan. */
function adjustment(
  plan: (input: Surface, params: unknown, coverage?: Uint8Array) => AdjustmentPlan,
): Factory {
  return (device) => {
    const runner = new GpuAdjustment(device);
    return (input, params, coverage) => runner.run(input, plan(input, params, coverage));
  };
}

/** Flip Horizontal and Flip Vertical share one shader; the axis is in the parameters. */
const flipRunner: Factory = (device) => {
  const runner = new GpuFlipObject(device);
  return (input, params, coverage) => runner.run(input, params as FlipObjectParams, coverage);
};

/** The per-pixel adjustments whose dialogs preview as a live filter, by their own plans. */
const LIVE_ADJUSTMENTS = [
  "sepia",
  "brightnessContrast",
  "hueSaturation",
  "posterize",
  "levels",
  "curves",
  "exposure",
  "temperatureTint",
] as const;

const FACTORIES: ReadonlyMap<string, Factory> = new Map<string, Factory>([
  [GAUSSIAN_BLUR_ID, direct<GaussianBlurParams>((device) => new GpuGaussianBlur(device))],
  [SQUARE_BLUR_ID, direct<SquareBlurParams>((device) => new GpuSquareBlur(device))],
  ...ADJUSTMENT_IDS.filter((id) => id !== "sepia").map((id): [string, Factory] => [
    id,
    adjustment(() => planAdjustment(id, SEPIA_DEFAULT_INTENSITY)),
  ]),
  ...LIVE_ADJUSTMENTS.map((id): [string, Factory] => [
    id,
    adjustment((_input, params) =>
      id === "sepia"
        ? planAdjustment("sepia", (params as SepiaParams).intensity)
        : (pixelAdjustment(id)?.plan(params) ?? planAdjustment("invertColors", 0)),
    ),
  ]),
  [AUTO_LEVEL_ID, adjustment((input, _params, coverage) => autoLevelPlan(input, coverage))],
  [
    HIGHLIGHTS_SHADOWS_ID,
    adjustment((_input, params) => highlightsShadowsPlan(params as HighlightsShadowsParams)),
  ],
  [
    BULGE_ID,
    distortion<BulgeParams>(
      () => BULGE_SAMPLE_MAP_WGSL,
      bulgePlan,
      (params) => params.edge,
    ),
  ],
  [
    TWIST_ID,
    distortion<TwistParams>(
      () => TWIST_SAMPLE_MAP_WGSL,
      twistPlan,
      () => "clamp",
    ),
  ],
  [
    POLAR_INVERSION_ID,
    distortion<PolarInversionParams>(
      () => POLAR_SAMPLE_MAP_WGSL,
      polarInversionPlan,
      (params) => params.edge,
    ),
  ],
  [
    CRYSTALIZE_ID,
    distortion<CrystalizeParams>(
      crystalizeSampleMapWgsl,
      (params) => crystalizePlan(params),
      () => "clamp",
    ),
  ],
  [
    TILE_REFLECTION_ID,
    distortion<TileReflectionParams>(
      () => TILE_SAMPLE_MAP_WGSL,
      tileReflectionPlan,
      (params) => params.edge,
    ),
  ],
  [DENTS_ID, distortion<DentsParams>(dentsSampleMapWgsl, dentsPlan, () => "reflect")],
  [FROSTED_GLASS_ID, direct<FrostedGlassParams>((device) => new GpuFrostedGlass(device))],
  [PIXELATE_ID, direct<PixelateParams>((device) => new GpuPixelate(device))],
  [MORPHOLOGY_ID, direct<MorphologyParams>((device) => new GpuMorphology(device))],
  [FRAGMENT_BLUR_ID, direct<FragmentBlurParams>((device) => new GpuFragmentBlur(device))],
  [MOTION_BLUR_ID, direct<MotionBlurParams>((device) => new GpuMotionBlur(device))],
  [RADIAL_BLUR_ID, direct<RadialBlurParams>((device) => new GpuRadialBlur(device))],
  [ZOOM_BLUR_ID, direct<ZoomBlurParams>((device) => new GpuZoomBlur(device))],
  [MEDIAN_BLUR_ID, direct<MedianBlurParams>((device) => new GpuMedianBlur(device))],
  [SURFACE_BLUR_ID, direct<SurfaceBlurParams>((device) => new GpuSurfaceBlur(device))],
  [SKETCH_BLUR_ID, direct<SketchBlurParams>((device) => new GpuSketchBlur(device))],
  [BOKEH_BLUR_ID, direct<BokehBlurParams>((device) => new GpuBokehBlur(device))],
  [ADD_NOISE_ID, direct<AddNoiseParams>((device) => new GpuAddNoise(device))],
  [REDUCE_NOISE_ID, direct<ReduceNoiseParams>((device) => new GpuReduceNoise(device))],
  [INK_SKETCH_ID, direct<InkSketchParams>((device) => new GpuInkSketch(device))],
  [OIL_PAINTING_ID, direct<OilPaintingParams>((device) => new GpuOilPainting(device))],
  [PENCIL_SKETCH_ID, direct<PencilSketchParams>((device) => new GpuPencilSketch(device))],
  [GLOW_ID, direct<GlowParams>((device) => new GpuGlow(device))],
  [SOFTEN_PORTRAIT_ID, direct<SoftenPortraitParams>((device) => new GpuSoftenPortrait(device))],
  [SHARPEN_ID, direct<SharpenParams>((device) => new GpuSharpen(device))],
  [STRAIGHTEN_ID, direct<StraightenParams>((device) => new GpuStraighten(device))],
  [VIGNETTE_ID, direct<VignetteParams>((device) => new GpuVignette(device))],
  [ROTATE_ZOOM_ID, direct<RotateZoomParams>((device) => new GpuRotateZoom(device))],
  [CLOUDS_ID, direct<CloudsParams>((device) => new GpuClouds(device))],
  [TURBULENCE_ID, direct<TurbulenceParams>((device) => new GpuTurbulence(device))],
  [JULIA_ID, direct<JuliaParams>((device) => new GpuJulia(device))],
  [MANDELBROT_ID, direct<MandelbrotParams>((device) => new GpuMandelbrot(device))],
  [EDGE_DETECT_ID, direct<EdgeDetectParams>((device) => new GpuEdgeDetect(device))],
  [EMBOSS_ID, direct<EmbossParams>((device) => new GpuEmboss(device))],
  [RELIEF_ID, direct<ReliefParams>((device) => new GpuRelief(device))],
  [OUTLINE_ID, direct<OutlineParams>((device) => new GpuOutline(device))],
  [DROP_SHADOW_ID, direct<DropShadowParams>((device) => new GpuDropShadow(device))],
  [
    RED_EYE_ID,
    (device) => {
      const runner = new GpuRedEye(device);
      return (input, params, coverage) => runner.run(input, params as RedEyeParams, coverage);
    },
  ],
  [
    ALIGN_OBJECT_ID,
    (device) => {
      const runner = new GpuAlignObject(device);
      return (input, params, coverage) => runner.run(input, params as AlignObjectParams, coverage);
    },
  ],
  [FLIP_HORIZONTAL_ID, flipRunner],
  [FLIP_VERTICAL_ID, flipRunner],
]);

/** The effect ids of the runner table, which `GPU_EFFECT_IDS` must list exactly. */
export const GPU_RUNNER_IDS: readonly string[] = [...FACTORIES.keys()];

/**
 * Jobs that are not effects but run the same way, on a session source kept on the GPU. Their
 * output has its own size. Move Selected Pixels resamples its content here (`GpuTransformSpec`).
 */
const TOOL_JOBS: ReadonlyMap<string, Factory> = new Map<string, Factory>([
  [TRANSFORM_JOB, direct<GpuTransformSpec>((device) => new GpuTransform(device))],
]);

/**
 * The most bytes per pixel any effect keeps in one buffer: the `vec4<f32>` planes of the blurs.
 * Larger regions than the device's binding limit allows go to the CPU without trying.
 */
const PLANE_BYTES_PER_PIXEL = 16;

/** An effect run on the GPU failed; the caller falls back to the CPU (WEB-GPU-04). */
export class GpuEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuEffectError";
  }
}

/**
 * Runs the built-in effects' WGSL twins on one device. Each effect's pipelines are built on its
 * first run and kept. A run is wrapped in validation and out-of-memory error scopes, so a failure
 * that WebGPU only reports asynchronously still rejects (and drops the effect's runner) instead of
 * returning blank pixels. Runs must not overlap, since error scopes are a stack per device:
 * `GpuEffectQueue` serializes them.
 *
 * The source a session previews is uploaded once and kept on the GPU: the runners see a device
 * whose `queue.writeBuffer` of exactly that source's pixels becomes a GPU-side buffer copy, so a
 * later preview does not upload the region again (L9). Uploading 4000 × 3000 took 34 ms of a 55 ms
 * Gaussian Blur preview; the blur itself takes about 11 ms.
 */
export class GpuEffects {
  readonly #runners = new Map<string, GpuEffectRun>();
  /** The device the runners get, with the source copy in place of its upload. */
  readonly #runnerDevice: GPUDevice;
  #resident: { readonly data: Uint8ClampedArray; readonly buffer: GPUBuffer } | undefined;

  constructor(readonly device: GPUDevice) {
    this.#runnerDevice = this.#withResidentSource(device);
  }

  /** Drops the GPU copy of `source`, when it is the one kept. */
  forget(source: Surface): void {
    if (this.#resident?.data !== source.data) return;
    this.#resident.buffer.destroy();
    this.#resident = undefined;
  }

  /** Keeps `input` on the GPU, replacing the source kept before. */
  #keep(input: Surface): void {
    if (this.#resident?.data === input.data) return;
    this.#resident?.buffer.destroy();
    const buffer = this.device.createBuffer({
      label: "effect source",
      size: input.data.byteLength,
      usage: BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, input.data);
    this.#resident = { data: input.data, buffer };
  }

  #withResidentSource(device: GPUDevice): GPUDevice {
    const queue = device.queue;
    const writeBuffer: GPUQueue["writeBuffer"] = (buffer, offset, data, dataOffset, size) => {
      const held = this.#resident;
      if (held !== undefined && data === held.data && offset === 0 && dataOffset === undefined) {
        const encoder = device.createCommandEncoder({ label: "effect source copy" });
        encoder.copyBufferToBuffer(held.buffer, 0, buffer, 0, held.buffer.size);
        queue.submit([encoder.finish()]);
        return;
      }
      queue.writeBuffer(buffer, offset, data, dataOffset, size);
    };
    const bound = <T extends object>(target: T, overrides: Record<string | symbol, unknown>) =>
      new Proxy(target, {
        get(object, property) {
          if (property in overrides) return overrides[property];
          const value: unknown = Reflect.get(object, property, object);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    return bound(device, { queue: bound(queue, { writeBuffer }) });
  }

  supports(effectId: string): boolean {
    return FACTORIES.has(effectId);
  }

  /** Whether a `width` × `height` region fits the device's buffer limits. */
  fits(width: number, height: number): boolean {
    const bytes = width * height * PLANE_BYTES_PER_PIXEL;
    const { limits } = this.device;
    return bytes <= limits.maxStorageBufferBindingSize && bytes <= limits.maxBufferSize;
  }

  async run(
    effectId: string,
    input: Surface,
    params: unknown,
    coverage: Uint8Array | undefined,
  ): Promise<Surface> {
    const effect = FACTORIES.get(effectId);
    const factory = effect ?? TOOL_JOBS.get(effectId);
    if (factory === undefined) throw new GpuEffectError(`"${effectId}" has no GPU implementation.`);
    if (!this.fits(input.width, input.height)) {
      throw new GpuEffectError(
        `A ${input.width}x${input.height} region is larger than the GPU's buffer limits.`,
      );
    }
    const device = this.device;
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    let result: Surface | undefined;
    let failure: unknown;
    try {
      this.#keep(input);
      let runner = this.#runners.get(effectId);
      if (runner === undefined) {
        runner = factory(this.#runnerDevice);
        this.#runners.set(effectId, runner);
      }
      result = await runner(input, params, coverage);
    } catch (cause) {
      failure = cause;
    }
    const validation = await device.popErrorScope();
    const memory = await device.popErrorScope();
    const error = validation ?? memory;
    if (failure !== undefined || error !== null || result === undefined) {
      this.#runners.delete(effectId);
      this.forget(input);
      if (failure !== undefined) throw failure;
      throw new GpuEffectError(error?.message ?? "The GPU returned no result.");
    }
    if (effect !== undefined && (result.width !== input.width || result.height !== input.height)) {
      throw new GpuEffectError(`"${effectId}" returned ${result.width}x${result.height}.`);
    }
    return result;
  }
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

interface HeldSource {
  readonly surface: Surface;
  readonly coverage: Uint8Array | undefined;
}

/**
 * The engine worker's side of GPU effects: it keeps the sources of the open sessions (the newest
 * few), runs one job at a time on the engine's current device (error scopes are a stack per
 * device), and drops canceled jobs. A job canceled while it waits never starts; one canceled while
 * it runs finishes on the GPU, and its output is dropped.
 */
export class GpuEffectQueue {
  readonly #sources = new Map<number, HeldSource>();
  readonly #pending = new Set<number>();
  readonly #canceled = new Set<number>();
  #tail: Promise<unknown> = Promise.resolve();
  #effects: GpuEffects | undefined;

  constructor(
    readonly device: () => GPUDevice | undefined,
    readonly maxSources = 2,
  ) {}

  get busy(): boolean {
    return this.#pending.size > 0;
  }

  run(job: GpuEffectJob): Promise<GpuEffectOutput> {
    if (job.pixels !== undefined) {
      this.release(job.source);
      this.#sources.set(job.source, {
        surface: new Surface(job.width, job.height, job.pixels),
        coverage: job.coverage,
      });
      for (const id of this.#sources.keys()) {
        if (this.#sources.size <= this.maxSources) break;
        this.release(id);
      }
    }
    this.#pending.add(job.id);
    const task = this.#tail.then(() => this.#execute(job));
    this.#tail = task.catch(() => undefined);
    return task.finally(() => {
      this.#pending.delete(job.id);
      this.#canceled.delete(job.id);
    });
  }

  cancel(id: number): void {
    if (this.#pending.has(id)) this.#canceled.add(id);
  }

  /** Forgets a source, and its copy on the GPU. */
  release(source: number): void {
    const held = this.#sources.get(source);
    if (held === undefined) return;
    this.#sources.delete(source);
    this.#effects?.forget(held.surface);
  }

  async #execute(job: GpuEffectJob): Promise<GpuEffectOutput> {
    const abort = () => namedError("AbortError", "The GPU render was canceled.");
    if (this.#canceled.has(job.id)) throw abort();
    const source = this.#sources.get(job.source);
    if (source === undefined) {
      throw namedError(GPU_SOURCE_MISSING, "The engine no longer holds the effect's source.");
    }
    const device = this.device();
    if (device === undefined) throw new GpuEffectError("The engine has no GPU device.");
    if (this.#effects?.device !== device) this.#effects = new GpuEffects(device);
    const out = await this.#effects.run(job.effectId, source.surface, job.params, source.coverage);
    if (this.#canceled.has(job.id)) throw abort();
    // The source stays here for the next preview, so its buffer must not move.
    const pixels =
      out.data.buffer === source.surface.data.buffer
        ? new Uint8ClampedArray(out.data)
        : (out.data as Uint8ClampedArray<ArrayBuffer>);
    return { width: out.width, height: out.height, pixels };
  }
}
