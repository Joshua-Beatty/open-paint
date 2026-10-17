import { Surface } from "@openpaint/document";
import {
  FRACTAL_PARAMS_BYTES,
  FRACTAL_WGSL,
  fractalPlan,
  type JuliaParams,
  type MandelbrotParams,
  mandelbrotPlan,
  planDistortionOffsets,
} from "@openpaint/effects";
import { entryPipelines, runPackedStage } from "./gpu-stage";

/**
 * Julia (FX-RENDER-JULIA-01) on WebGPU: one pass that iterates each supersample, averages them in a
 * 16-bit premultiplied target and composites the result with the blend mode. The stage mirrors
 * `julia_rgba8`. Requires the WASM kernels to be initialized, for the sample offsets.
 */
export class GpuJulia {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "julia", FRACTAL_WGSL, ["julia"] as const).julia;
  }

  /** Returns the fractal composited onto `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: JuliaParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    return runFractal(
      this.#device,
      this.#pipeline,
      input,
      fractalPlan(params, input),
      params.quality,
      false,
    );
  }
}

/**
 * Mandelbrot (FX-RENDER-MANDEL-01) on WebGPU, with the same structure as `GpuJulia`. The stage mirrors
 * `mandelbrot_rgba8`, including Invert Colors. Requires the WASM kernels to be initialized.
 */
export class GpuMandelbrot {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "mandelbrot", FRACTAL_WGSL, [
      "mandelbrot",
    ] as const).mandelbrot;
  }

  /** Returns the fractal composited onto `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: MandelbrotParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    return runFractal(
      this.#device,
      this.#pipeline,
      input,
      mandelbrotPlan(params, input),
      params.quality,
      params.invert,
    );
  }
}

/**
 * Fills the `Params` uniform from a fractal plan (the same numbers the Rust reference reads) and runs
 * the stage. The sample offsets come from Rust, one pair per sample, and bind at 3.
 */
async function runFractal(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  input: Surface,
  plan: Float32Array,
  quality: number,
  invert: boolean,
): Promise<Surface> {
  const { width, height } = input;
  const offsets = planDistortionOffsets(quality);
  const [
    originX = 0,
    originY = 0,
    documentWidth = 0,
    documentHeight = 0,
    factor = 0,
    cosine = 1,
    sine = 0,
    inverseHeight = 0,
    aspect = 0,
    inverseZoom = 0,
    ,
    mode = 0,
  ] = plan;
  const uniform = new ArrayBuffer(FRACTAL_PARAMS_BYTES);
  const view = new DataView(uniform);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, originX, true);
  view.setUint32(12, originY, true);
  view.setFloat32(16, documentWidth, true);
  view.setFloat32(20, documentHeight, true);
  view.setFloat32(24, factor, true);
  view.setFloat32(28, cosine, true);
  view.setFloat32(32, sine, true);
  view.setFloat32(36, inverseHeight, true);
  view.setFloat32(40, aspect, true);
  view.setFloat32(44, inverseZoom, true);
  view.setUint32(48, offsets.length / 2, true);
  view.setUint32(52, mode, true);
  view.setUint32(56, invert ? 1 : 0, true);
  view.setUint32(60, 0, true);
  return runPackedStage(device, pipeline, width, height, uniform, input.data, [offsets]);
}
