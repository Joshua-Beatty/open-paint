import { Surface } from "@openpaint/document";
import {
  documentCenter,
  RADIAL_BLUR_PARAMS_BYTES,
  RADIAL_BLUR_WGSL,
  type RadialBlurParams,
  radialBlurPlan,
  ZOOM_BLUR_PARAMS_BYTES,
  ZOOM_BLUR_WGSL,
  type ZoomBlurParams,
  zoomBlurPlan,
} from "@openpaint/effects";
import { runDirectionalBlur } from "./gpu-directional-blur";

/**
 * Radial Blur (FX-BLUR-RADIAL) on WebGPU: one compute pass. The shader is the WGSL twin of
 * `radial_blur_rgba8`, and it reads the rotations from `radial_plan`. One pipeline serves every
 * parameter set (FX-A-00-02c).
 */
export class GpuRadialBlur {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "radial blur", code: RADIAL_BLUR_WGSL });
    this.#pipeline = device.createComputePipeline({
      label: "radial blur",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the blurred `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: RadialBlurParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const plan = radialBlurPlan(params);
    const center = documentCenter(
      params.center,
      width,
      height,
      params.document,
      params.regionOrigin,
    );
    return runDirectionalBlur(
      this.#device,
      this.#pipeline,
      input,
      plan,
      centeredParams(RADIAL_BLUR_PARAMS_BYTES, width, height, plan.length / 2, center),
    );
  }
}

/**
 * Zoom Blur (FX-BLUR-ZOOM) on WebGPU: one compute pass over the scales from `zoom_plan`. The shader
 * is the WGSL twin of `zoom_blur_rgba8`. A distance of 1 passes the image through.
 */
export class GpuZoomBlur {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "zoom blur", code: ZOOM_BLUR_WGSL });
    this.#pipeline = device.createComputePipeline({
      label: "zoom blur",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the blurred `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: ZoomBlurParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const plan = zoomBlurPlan(params);
    if (plan.length === 0) return new Surface(width, height, new Uint8ClampedArray(input.data));
    const center = documentCenter(
      params.center,
      width,
      height,
      params.document,
      params.regionOrigin,
    );
    return runDirectionalBlur(
      this.#device,
      this.#pipeline,
      input,
      plan,
      centeredParams(ZOOM_BLUR_PARAMS_BYTES, width, height, plan.length / 2, center),
    );
  }
}

/**
 * Encodes the `Params` uniform of the centered blur shaders: the image size and plan count as u32,
 * then the center as f32 at byte 16, matching the WGSL struct layout.
 */
function centeredParams(
  size: number,
  width: number,
  height: number,
  count: number,
  center: Float32Array,
): ArrayBuffer {
  const bytes = new ArrayBuffer(size);
  const view = new DataView(bytes);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, count, true);
  view.setFloat32(16, center[0] ?? 0, true);
  view.setFloat32(20, center[1] ?? 0, true);
  return bytes;
}
