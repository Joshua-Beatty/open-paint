import { Surface } from "@openpaint/document";
import {
  edgeBehaviorCode,
  FRAGMENT_BLUR_PARAMS_BYTES,
  FRAGMENT_BLUR_WGSL,
  type FragmentBlurParams,
  fragmentBlurOffsets,
  MOTION_BLUR_PARAMS_BYTES,
  MOTION_BLUR_WGSL,
  type MotionBlurParams,
  motionBlurPlan,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";

const WORKGROUP_SIZE = 8;
const RGBA8_BYTES_PER_PIXEL = 4;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;

/**
 * Fragment Blur (FX-BLUR-FRAG) on WebGPU: one compute pass. The shader is the WGSL twin of
 * `fragment_blur_rgba8`, and it reads the offsets from `fragment_offsets`. One pipeline serves every
 * parameter set (FX-A-00-02c).
 */
export class GpuFragmentBlur {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "fragment blur", code: FRAGMENT_BLUR_WGSL });
    this.#pipeline = device.createComputePipeline({
      label: "fragment blur",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the blurred `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: FragmentBlurParams): Promise<Surface> {
    if (input.width === 0 || input.height === 0) return new Surface(input.width, input.height);
    const uniform = paramsBytes(FRAGMENT_BLUR_PARAMS_BYTES, [
      input.width,
      input.height,
      params.count,
    ]);
    return runDirectionalBlur(
      this.#device,
      this.#pipeline,
      input,
      fragmentBlurOffsets(params),
      uniform,
    );
  }
}

/**
 * Motion Blur (FX-BLUR-MOTION) on WebGPU: one compute pass over the kernel from `motion_plan`. The
 * shader is the WGSL twin of `motion_blur_rgba8`. A zero distance passes the image through.
 */
export class GpuMotionBlur {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "motion blur", code: MOTION_BLUR_WGSL });
    this.#pipeline = device.createComputePipeline({
      label: "motion blur",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the blurred `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: MotionBlurParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const plan = motionBlurPlan(params);
    if (plan.length === 0) return new Surface(width, height, new Uint8ClampedArray(input.data));
    const uniform = paramsBytes(MOTION_BLUR_PARAMS_BYTES, [
      width,
      height,
      plan.length / 3,
      edgeBehaviorCode(params.edge),
    ]);
    return runDirectionalBlur(this.#device, this.#pipeline, input, plan, uniform);
  }
}

/**
 * Runs one blur pipeline over a plan. The shaders bind the `Params` uniform at 0, the source at 1,
 * the plan (offsets, kernel or rotations) at 2 and the output at 3. Returns the output as straight
 * RGBA8.
 */
export async function runDirectionalBlur(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  input: Surface,
  plan: Float32Array,
  uniform: ArrayBuffer,
): Promise<Surface> {
  const { width, height } = input;
  const pixels = width * height;
  const buffers: GPUBuffer[] = [];
  const buffer = (label: string, size: number, usage: number) => {
    const created = device.createBuffer({ label, size, usage });
    buffers.push(created);
    return created;
  };
  const source = buffer(
    "source",
    pixels * RGBA8_BYTES_PER_PIXEL,
    BufferUsage.STORAGE | BufferUsage.COPY_DST,
  );
  const planBuffer = buffer("plan", plan.byteLength, BufferUsage.STORAGE | BufferUsage.COPY_DST);
  const output = buffer(
    "output",
    pixels * RGBA8_BYTES_PER_PIXEL,
    BufferUsage.STORAGE | BufferUsage.COPY_SRC,
  );
  const readback = buffer(
    "readback",
    pixels * RGBA8_BYTES_PER_PIXEL,
    BufferUsage.MAP_READ | BufferUsage.COPY_DST,
  );
  const params = buffer("params", uniform.byteLength, BufferUsage.UNIFORM | BufferUsage.COPY_DST);
  device.queue.writeBuffer(source, 0, input.data);
  device.queue.writeBuffer(planBuffer, 0, plan);
  device.queue.writeBuffer(params, 0, uniform);

  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: { buffer: source } },
      { binding: 2, resource: { buffer: planBuffer } },
      { binding: 3, resource: { buffer: output } },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
  pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, pixels * RGBA8_BYTES_PER_PIXEL);
  device.queue.submit([encoder.finish()]);

  await readback.mapAsync(MAP_READ_MODE);
  const bytes = new Uint8ClampedArray(readback.getMappedRange().slice(0));
  readback.unmap();
  for (const created of buffers) created.destroy();
  return new Surface(width, height, bytes);
}

/** Encodes a `Params` uniform of little-endian u32 words, matching the WGSL struct layout. */
function paramsBytes(size: number, words: readonly number[]): ArrayBuffer {
  const bytes = new ArrayBuffer(size);
  const view = new DataView(bytes);
  for (const [index, word] of words.entries()) view.setUint32(index * 4, word, true);
  return bytes;
}
