import { Surface } from "@openpaint/document";
import {
  GLOW_WGSL,
  type GlowParams,
  planDistortionOffsets,
  planGlow,
  planRotateZoom,
  planSoftenPortrait,
  planStraighten,
  planVignette,
  ROTATE_ZOOM_PARAMS_BYTES,
  ROTATE_ZOOM_PLAN_OFFSET,
  ROTATE_ZOOM_WGSL,
  type RotateZoomParams,
  rotateZoomSamplingCode,
  rotateZoomTilingCode,
  SHARPEN_WGSL,
  type SharpenParams,
  SOFTEN_PORTRAIT_WGSL,
  type SoftenPortraitParams,
  STRAIGHTEN_PARAMS_BYTES,
  STRAIGHTEN_WGSL,
  type StraightenParams,
  VIGNETTE_PARAMS_BYTES,
  VIGNETTE_WGSL,
  type VignetteParams,
} from "@openpaint/effects";
import { GpuGaussianBlur } from "./gpu-gaussian-blur";
import {
  entryPipelines,
  runPackedStage,
  runStage,
  StageChain,
  type StageFields,
} from "./gpu-stage";

/**
 * The clamped Gaussian of `input`, then one stage over the source and the blurred copy with the
 * plan's `shift, mul, div` and `fields`, recorded together with one readback (Glow, Soften
 * Portrait).
 */
async function blurThenStage(
  device: GPUDevice,
  gaussian: GpuGaussianBlur,
  pipeline: GPUComputePipeline,
  input: Surface,
  plan: {
    readonly blurRadius: number;
    readonly blurQuality: number;
    readonly plan: readonly number[] | Float32Array;
  },
  fields: StageFields,
): Promise<Surface> {
  const chain = new StageChain(device, input.width, input.height);
  try {
    const source = chain.upload(input.data);
    const blurred = gaussian.encode(
      chain,
      source,
      { radius: plan.blurRadius, gammaBoost: 0, quality: plan.blurQuality },
      "clamp",
    );
    const [shift = 0, mul = 0, div = 0] = plan.plan;
    return await chain.read(
      chain.stage(pipeline, { ...fields, f0: shift, f1: mul, f2: div }, [source, blurred]),
    );
  } finally {
    chain.destroy();
  }
}

/**
 * Glow (FX-PHOTO-GLOW) on WebGPU: the clamped Gaussian, then the Brightness / Contrast and screen of
 * the blurred copy over the source. The stages mirror `glow_rgba8`.
 */
export class GpuGlow {
  readonly #device: GPUDevice;
  readonly #gaussian: GpuGaussianBlur;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#gaussian = new GpuGaussianBlur(device);
    this.#pipeline = entryPipelines(device, "glow", GLOW_WGSL, [
      "glow_screen",
    ] as const).glow_screen;
  }

  /** Returns the glowed `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: GlowParams): Promise<Surface> {
    const plan = planGlow(params);
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    return blurThenStage(this.#device, this.#gaussian, this.#pipeline, input, plan, {});
  }
}

/**
 * Soften Portrait (FX-PHOTO-SOFTEN) on WebGPU: the clamped Gaussian of the source, then one pass of
 * the warm monochrome, the lifted copy and the Overlay. The stages mirror `soften_portrait_rgba8`.
 */
export class GpuSoftenPortrait {
  readonly #device: GPUDevice;
  readonly #gaussian: GpuGaussianBlur;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#gaussian = new GpuGaussianBlur(device);
    this.#pipeline = entryPipelines(device, "soften portrait", SOFTEN_PORTRAIT_WGSL, [
      "soften_portrait",
    ] as const).soften_portrait;
  }

  /** Returns the softened `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: SoftenPortraitParams): Promise<Surface> {
    const plan = planSoftenPortrait(params);
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    return blurThenStage(this.#device, this.#gaussian, this.#pipeline, input, plan, {
      i0: plan.warmth,
    });
  }
}

/**
 * Straighten (FX-PHOTO-STRAIGHTEN) on WebGPU: one pass that maps each pixel through the Rust inverse
 * matrix and samples the linear-light source. The stage mirrors `straighten_rgba8`. Requires the
 * WASM kernels to be initialized.
 */
export class GpuStraighten {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "straighten", STRAIGHTEN_WGSL, [
      "straighten",
    ] as const).straighten;
  }

  /** Returns the straightened `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: StraightenParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const plan = planStraighten(params, width, height);
    const uniform = new ArrayBuffer(STRAIGHTEN_PARAMS_BYTES);
    const view = new DataView(uniform);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    view.setUint32(8, plan.sampling, true);
    // The matrix fills `m` (a, b, c, d) and `t` (e, f), which are contiguous from byte 16.
    new Float32Array(uniform, 16, 6).set(plan.matrix);
    return runPackedStage(this.#device, this.#pipeline, width, height, uniform, input.data);
  }
}

/**
 * Rotate / Zoom (FX-NOSUB-ROTZOOM-01) on WebGPU: one pass that casts each pixel's rays through the Rust
 * plan and averages the Quality offsets. The stage mirrors `rotate_zoom_rgba8`. Requires the WASM
 * kernels to be initialized.
 */
export class GpuRotateZoom {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "rotate zoom", ROTATE_ZOOM_WGSL, [
      "rotate_zoom",
    ] as const).rotate_zoom;
  }

  /** Returns the rolled `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: RotateZoomParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const plan = planRotateZoom(params, width, height);
    const offsets = planDistortionOffsets(params.quality);
    const uniform = new ArrayBuffer(ROTATE_ZOOM_PARAMS_BYTES);
    const view = new DataView(uniform);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    view.setUint32(8, rotateZoomSamplingCode(params.sampling), true);
    view.setUint32(12, rotateZoomTilingCode(params.tiling), true);
    view.setUint32(16, offsets.length / 2, true);
    new Float32Array(uniform, ROTATE_ZOOM_PLAN_OFFSET, plan.length).set(plan);
    return runPackedStage(this.#device, this.#pipeline, width, height, uniform, input.data, [
      offsets,
    ]);
  }
}

/**
 * Vignette (FX-PHOTO-VIGNETTE) on WebGPU: one pass that darkens each pixel in linear light. The
 * center and the falloff come from the Rust plan, and the stage mirrors `vignette_rgba8`. Requires
 * the WASM kernels to be initialized.
 */
export class GpuVignette {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "vignette", VIGNETTE_WGSL, [
      "vignette",
    ] as const).vignette;
  }

  /** Returns the vignetted `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: VignetteParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const plan = planVignette(params, width, height);
    const uniform = new ArrayBuffer(VIGNETTE_PARAMS_BYTES);
    const view = new DataView(uniform);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    // The plan fills `cx`, `cy` and `k`, which are contiguous from byte 8.
    new Float32Array(uniform, 8, 3).set(plan);
    view.setFloat32(20, params.strength, true);
    return runPackedStage(this.#device, this.#pipeline, width, height, uniform, input.data);
  }
}

/**
 * Sharpen (FX-PHOTO-SHARPEN) on WebGPU: one pass over the whole image, since each pixel reads its
 * 3x3 neighbourhood. The stage mirrors `sharpen_rgba8`.
 */
export class GpuSharpen {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "sharpen", SHARPEN_WGSL, ["sharpen"] as const).sharpen;
  }

  /** Returns the sharpened `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: SharpenParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    return runStage(
      this.#device,
      this.#pipeline,
      width,
      height,
      { f0: params.amount, f1: params.threshold },
      [input.data],
    );
  }
}
