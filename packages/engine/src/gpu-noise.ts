import { Surface } from "@openpaint/document";
import {
  ADD_NOISE_PARAMS_BYTES,
  ADD_NOISE_WGSL,
  type AddNoiseParams,
  addNoiseSeed,
  addNoiseTable,
  REDUCE_NOISE_PARAMS_BYTES,
  REDUCE_NOISE_WGSL,
  type ReduceNoiseParams,
} from "@openpaint/effects";
import { runTiledBlur } from "./gpu-neighborhood-blur";

/**
 * Add Noise (FX-NOISE-ADD) on WebGPU. The shader is the WGSL twin of `add_noise_rgba8`, and it reads the
 * deviate table that Rust builds, so both backends draw the same noise. It runs in the same tiles as the
 * neighborhood blurs, and each tile's origin keeps the per-pixel draws at their image positions.
 */
export class GpuAddNoise {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "add noise", code: ADD_NOISE_WGSL });
    this.#pipeline = device.createComputePipeline({
      label: "add noise",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the noisy `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: AddNoiseParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const seed = addNoiseSeed(params.userSeed, params.instanceSeed);
    return runTiledBlur(
      this.#device,
      this.#pipeline,
      input,
      ADD_NOISE_PARAMS_BYTES,
      (origin) => addNoiseParamsBytes(width, height, origin, seed, params),
      addNoiseTable(),
    );
  }
}

/**
 * Reduce Noise (FX-NOISE-REDUCE) on WebGPU. The shader is the WGSL twin of `reduce_noise_rgba8`, and it runs
 * once per tile, awaiting each submission, as the other neighborhood blurs do (WEB-GPU-05).
 */
export class GpuReduceNoise {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "reduce noise", code: REDUCE_NOISE_WGSL });
    this.#pipeline = device.createComputePipeline({
      label: "reduce noise",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the filtered `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: ReduceNoiseParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    return runTiledBlur(this.#device, this.#pipeline, input, REDUCE_NOISE_PARAMS_BYTES, (origin) =>
      reduceNoiseParamsBytes(width, height, origin, params),
    );
  }
}

/**
 * Encodes the Add Noise `Params`: the image size, tile origin and effective seed as u32, the intensity,
 * saturation and an f32 coverage, matching the WGSL struct layout.
 */
function addNoiseParamsBytes(
  width: number,
  height: number,
  origin: { x: number; y: number },
  seed: number,
  params: AddNoiseParams,
): ArrayBuffer {
  const bytes = new ArrayBuffer(ADD_NOISE_PARAMS_BYTES);
  const view = new DataView(bytes);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, origin.x, true);
  view.setUint32(12, origin.y, true);
  view.setUint32(16, seed >>> 0, true);
  view.setUint32(20, params.intensity, true);
  view.setUint32(24, params.colorSaturation, true);
  view.setFloat32(28, params.coverage, true);
  return bytes;
}

/**
 * Encodes the Reduce Noise `Params`: the image size, tile origin and radius as u32, then the strength as
 * f32 at byte 20, matching the WGSL struct layout.
 */
function reduceNoiseParamsBytes(
  width: number,
  height: number,
  origin: { x: number; y: number },
  params: ReduceNoiseParams,
): ArrayBuffer {
  const bytes = new ArrayBuffer(REDUCE_NOISE_PARAMS_BYTES);
  const view = new DataView(bytes);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, origin.x, true);
  view.setUint32(12, origin.y, true);
  view.setUint32(16, params.radius, true);
  view.setFloat32(20, params.strength, true);
  return bytes;
}
