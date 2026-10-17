import { Surface } from "@openpaint/document";
import { planSquareBlur, type SquareBlurParams } from "@openpaint/effects";
import { GpuGaussianBlur } from "./gpu-gaussian-blur";

/**
 * Square Blur (FX-BLUR-SQUARE) on WebGPU. Its box blur is the separable pass of the Gaussian shader with the
 * box weights, so both effects share one WGSL twin and one set of dispatches.
 */
export class GpuSquareBlur {
  readonly #blur: GpuGaussianBlur;

  constructor(device: GPUDevice) {
    this.#blur = new GpuGaussianBlur(device);
  }

  /** Returns the blurred `input` as a new surface. A radius of 0 returns a copy. */
  async run(input: Surface, params: SquareBlurParams): Promise<Surface> {
    const plan = planSquareBlur(params);
    if (!plan) return new Surface(input.width, input.height, new Uint8ClampedArray(input.data));
    return this.#blur.runPlan(input, plan);
  }
}
