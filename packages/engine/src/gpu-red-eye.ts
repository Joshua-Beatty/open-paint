import { Surface } from "@openpaint/document";
import { RED_EYE_PARAMS_BYTES, RED_EYE_WGSL, type RedEyeParams } from "@openpaint/effects";
import { entryPipelines, runPackedStage } from "./gpu-stage";

/** `i / 255` for every byte, rounded to f32 as the Rust reference divides. */
const UNIT = Float32Array.from({ length: 256 }, (_, i) => i / 255);

/**
 * The host-side numbers of Red Eye Removal (FX-PHOTO-REDEYE-01), rounded to f32 at each step as
 * `red_eye_rgba8` computes them: the threshold `1.9 - 0.1 · strength` and the correction
 * `strength / 5`.
 */
export function redEyeFactors(strength: number): { ratio: number; correction: number } {
  const f = Math.fround;
  return {
    ratio: f(f(1.9) - f(f(0.1) * strength)),
    correction: f(strength / 5),
  };
}

/**
 * Red Eye Removal on WebGPU: one per-pixel pass, the WGSL twin of `red_eye_rgba8`. `coverage` is
 * the selection, one byte per pixel; undefined selects every pixel.
 */
export class GpuRedEye {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "red eye", RED_EYE_WGSL, ["main"] as const).main;
  }

  async run(input: Surface, params: RedEyeParams, coverage?: Uint8Array): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const { ratio, correction } = redEyeFactors(params.strength);
    const uniform = new ArrayBuffer(RED_EYE_PARAMS_BYTES);
    const view = new DataView(uniform);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    view.setFloat32(8, ratio, true);
    view.setFloat32(12, correction, true);
    // A whole word per four pixels, so the buffer size is a multiple of 4.
    const mask = new Uint8Array(Math.ceil((width * height) / 4) * 4);
    if (coverage) mask.set(coverage.subarray(0, width * height));
    else mask.fill(255, 0, width * height);
    return runPackedStage(this.#device, this.#pipeline, width, height, uniform, input.data, [
      mask,
      UNIT,
    ]);
  }
}
