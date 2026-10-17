import { Surface } from "@openpaint/document";
import {
  INK_SKETCH_WGSL,
  type InkSketchParams,
  OIL_PAINTING_WGSL,
  type OilPaintingParams,
  PENCIL_SKETCH_WGSL,
  type PencilSketchParams,
  planInkSketch,
  planOilPainting,
  planPencilSketch,
} from "@openpaint/effects";
import { GpuGaussianBlur } from "./gpu-gaussian-blur";
import { entryPipelines, runStage, StageChain } from "./gpu-stage";

/**
 * Ink Sketch (FX-ART-INK) on WebGPU: the ink lines, the Glow's clamped Gaussian and screen, and the
 * Darken of the ink over the glow. The stages mirror `ink_sketch_rgba8`, one after another.
 */
export class GpuInkSketch {
  readonly #device: GPUDevice;
  readonly #gaussian: GpuGaussianBlur;
  readonly #pipelines: Record<"ink_lines" | "glow_screen" | "ink_darken", GPUComputePipeline>;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#gaussian = new GpuGaussianBlur(device);
    this.#pipelines = entryPipelines(device, "ink sketch", INK_SKETCH_WGSL, [
      "ink_lines",
      "glow_screen",
      "ink_darken",
    ] as const);
  }

  /** Returns the sketched `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: InkSketchParams): Promise<Surface> {
    const plan = planInkSketch(params);
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    // Every stage stays on the GPU; only the last one is read back.
    const chain = new StageChain(this.#device, width, height);
    try {
      const source = chain.upload(input.data);
      const lines = chain.stage(this.#pipelines.ink_lines, { f0: plan.threshold }, [source]);
      const blurred = this.#gaussian.encode(
        chain,
        source,
        { radius: plan.glowRadius, gammaBoost: 0, quality: plan.glowQuality },
        "clamp",
      );
      const [shift, mul, div] = plan.glowPlan;
      const glow = chain.stage(this.#pipelines.glow_screen, { f0: shift, f1: mul, f2: div }, [
        source,
        blurred,
      ]);
      return await chain.read(chain.stage(this.#pipelines.ink_darken, {}, [glow, lines]));
    } finally {
      chain.destroy();
    }
  }
}

/**
 * Oil Painting (FX-ART-OIL) on WebGPU: one pass of the mode filter, one invocation per pixel. The
 * shader is the WGSL twin of `oil_painting_rgba8`.
 */
export class GpuOilPainting {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "oil painting", OIL_PAINTING_WGSL, [
      "oil_painting",
    ] as const).oil_painting;
  }

  /** Returns the painted `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: OilPaintingParams): Promise<Surface> {
    const plan = planOilPainting(params);
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    if (plan.radius === 0) return new Surface(width, height, new Uint8ClampedArray(input.data));

    return runStage(
      this.#device,
      this.#pipeline,
      width,
      height,
      { f0: plan.limit, i0: plan.radius, u0: plan.bins, u1: plan.square ? 1 : 0 },
      [input.data],
    );
  }
}

/**
 * Pencil Sketch (FX-ART-PENCIL) on WebGPU: the Gaussian blur of the source, then the color dodge
 * pass. The stages mirror `pencil_sketch_rgba8`.
 */
export class GpuPencilSketch {
  readonly #device: GPUDevice;
  readonly #gaussian: GpuGaussianBlur;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#gaussian = new GpuGaussianBlur(device);
    this.#pipeline = entryPipelines(device, "pencil sketch", PENCIL_SKETCH_WGSL, [
      "pencil_sketch",
    ] as const).pencil_sketch;
  }

  /** Returns the sketched `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: PencilSketchParams): Promise<Surface> {
    const plan = planPencilSketch(params);
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const chain = new StageChain(this.#device, width, height);
    try {
      const source = chain.upload(input.data);
      const blurred = this.#gaussian.encode(chain, source, {
        radius: plan.blurRadius,
        gammaBoost: 0,
        quality: plan.blurQuality,
      });
      const [shift, mul, div] = plan.plan;
      return await chain.read(
        chain.stage(this.#pipeline, { f0: shift, f1: mul, f2: div }, [source, blurred]),
      );
    } finally {
      chain.destroy();
    }
  }
}
