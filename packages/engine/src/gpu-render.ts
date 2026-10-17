import { Surface } from "@openpaint/document";
import {
  CLOUDS_PARAMS_BYTES,
  CLOUDS_WGSL,
  type CloudsParams,
  cloudsFrame,
  cloudsPermutation,
  TURBULENCE_PARAMS_BYTES,
  TURBULENCE_WGSL,
  type TurbulenceParams,
  turbulenceStitch,
  turbulenceTables,
} from "@openpaint/effects";
import { entryPipelines, runPackedStage } from "./gpu-stage";

/**
 * Clouds (FX-RENDER-CLOUDS-01) on WebGPU: one pass that evaluates the noise, maps it between the two
 * colors and composites it with the blend mode. The stage mirrors `clouds_rgba8`. Requires the WASM
 * kernels to be initialized, for the permutation table.
 */
export class GpuClouds {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;
  readonly #permutation: Uint32Array;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "clouds", CLOUDS_WGSL, ["clouds"] as const).clouds;
    this.#permutation = cloudsPermutation();
  }

  /** Returns the clouds composited onto `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: CloudsParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const { document, origin } = cloudsFrame(params, input);
    const uniform = new ArrayBuffer(CLOUDS_PARAMS_BYTES);
    const view = new DataView(uniform);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    view.setUint32(8, origin.x, true);
    view.setUint32(12, origin.y, true);
    view.setInt32(16, document.width, true);
    view.setInt32(20, document.height, true);
    view.setInt32(24, params.scale, true);
    view.setInt32(28, params.seed, true);
    view.setFloat32(32, params.roughness, true);
    view.setUint32(36, params.mode, true);
    // The two colors are vec4 values at byte 48 and 64, each four floats.
    new Float32Array(uniform, 48, 4).set([
      params.color1.r,
      params.color1.g,
      params.color1.b,
      params.color1.a,
    ]);
    new Float32Array(uniform, 64, 4).set([
      params.color2.r,
      params.color2.g,
      params.color2.b,
      params.color2.a,
    ]);
    return runPackedStage(this.#device, this.#pipeline, width, height, uniform, input.data, [
      this.#permutation,
    ]);
  }
}

/**
 * Turbulence (FX-RENDER-TURB-01) on WebGPU: one pass over the image, with the lattice and gradient
 * tables and the base frequencies from the Rust kernels. The stage mirrors `turbulence_rgba8`.
 * Requires the WASM kernels to be initialized.
 */
export class GpuTurbulence {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "turbulence", TURBULENCE_WGSL, [
      "turbulence",
    ] as const).turbulence;
  }

  /** Returns the turbulence composited onto `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: TurbulenceParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const [freqX = 0, freqY = 0, stitchWidth = 0, wrapX = 0, stitchHeight = 0, wrapY = 0] =
      turbulenceStitch(params.period, params.tile);
    const { lattice, gradients } = turbulenceTables(params.seed);
    const uniform = new ArrayBuffer(TURBULENCE_PARAMS_BYTES);
    const view = new DataView(uniform);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    view.setUint32(8, params.origin?.x ?? 0, true);
    view.setUint32(12, params.origin?.y ?? 0, true);
    view.setUint32(16, params.tile, true);
    view.setUint32(20, params.octaves, true);
    view.setUint32(24, params.fractal ? 1 : 0, true);
    view.setUint32(28, params.mode, true);
    view.setFloat32(32, freqX, true);
    view.setFloat32(36, freqY, true);
    view.setInt32(40, stitchWidth, true);
    view.setInt32(44, wrapX, true);
    view.setInt32(48, stitchHeight, true);
    view.setInt32(52, wrapY, true);
    return runPackedStage(this.#device, this.#pipeline, width, height, uniform, input.data, [
      lattice,
      gradients,
    ]);
  }
}
