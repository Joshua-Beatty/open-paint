import { Surface } from "@openpaint/document";
import {
  GAUSSIAN_BLUR_WGSL,
  type GaussianBlurParams,
  type GaussianBlurPlan,
  type GaussianBorder,
  planGaussianBlur,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";

const ENTRY_POINTS = ["prepare", "resample", "blur_h", "blur_v", "finish"] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

/** Binding index of each storage resource in the WGSL twin (`@binding(n)`). */
const SLOT = { src_u32: 1, src_f: 2, dst_f: 3, dst_u32: 4, weights: 5 } as const;
type Slot = keyof typeof SLOT;

/** Bytes of the shader's `Params` uniform: eight 4-byte fields. */
const PARAMS_BYTES = 32;
/** Bytes per pixel of the `vec4<f32>` planes. */
const PLANE_BYTES_PER_PIXEL = 16;
/** Bytes per pixel of packed RGBA8 input and output. */
const RGBA8_BYTES_PER_PIXEL = 4;
const WORKGROUP_SIZE = 8;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;

/** The `Params` uniform of one dispatch (see `GAUSSIAN_BLUR_WGSL`). */
interface Stage {
  readonly width: number;
  readonly height: number;
  readonly outWidth: number;
  readonly outHeight: number;
  readonly radius?: number;
  readonly exponent?: number;
  readonly scale?: number;
  readonly clamp?: boolean;
}

/**
 * Gaussian Blur on WebGPU (FX-BLUR-GAUSS). Runs the WGSL twin of the Rust reference in a fixed
 * sequence of compute passes over storage buffers, then reads the result back. Each call owns its
 * buffers, so parameter changes only rebind uniforms and never rebuild a pipeline (FX-A-00-02c).
 */
export class GpuGaussianBlur {
  readonly #device: GPUDevice;
  readonly #pipelines: Readonly<Record<EntryPoint, GPUComputePipeline>>;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "gaussian blur", code: GAUSSIAN_BLUR_WGSL });
    const pipeline = (entryPoint: EntryPoint) =>
      device.createComputePipeline({
        label: `gaussian blur ${entryPoint}`,
        layout: "auto",
        compute: { module, entryPoint },
      });
    this.#pipelines = {
      prepare: pipeline("prepare"),
      resample: pipeline("resample"),
      blur_h: pipeline("blur_h"),
      blur_v: pipeline("blur_v"),
      finish: pipeline("finish"),
    };
  }

  /**
   * Returns the blurred `input` as a new surface. A radius of 0 returns a copy. Requires the
   * Rust/WASM kernels to be initialized, since the kernel weights come from them.
   */
  async run(
    input: Surface,
    params: GaussianBlurParams,
    border: GaussianBorder = "mirror",
  ): Promise<Surface> {
    const plan = planGaussianBlur(params, border);
    if (!plan) return new Surface(input.width, input.height, new Uint8ClampedArray(input.data));
    return this.runPlan(input, plan);
  }

  /**
   * Runs a gamma-separable blur from its plan: the Gaussian kernel, or the box weights of Square Blur
   * (FX-BLUR-SQUARE-03). A plan with factor 1 blurs at full resolution.
   */
  async runPlan(input: Surface, plan: GaussianBlurPlan): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const device = this.#device;
    const pixels = width * height;
    const buffers: GPUBuffer[] = [];
    const storage = (label: string, size: number, usage: number) => {
      const buffer = device.createBuffer({ label, size, usage: BufferUsage.STORAGE | usage });
      buffers.push(buffer);
      return buffer;
    };
    const planeA = storage("plane A", pixels * PLANE_BYTES_PER_PIXEL, 0);
    const planeB = storage("plane B", pixels * PLANE_BYTES_PER_PIXEL, 0);
    const inputBuffer = storage("input", pixels * RGBA8_BYTES_PER_PIXEL, BufferUsage.COPY_DST);
    const weights = storage("weights", plan.kernel.byteLength, BufferUsage.COPY_DST);
    const output = storage("output", pixels * RGBA8_BYTES_PER_PIXEL, BufferUsage.COPY_SRC);
    const readback = device.createBuffer({
      label: "readback",
      size: pixels * RGBA8_BYTES_PER_PIXEL,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
    buffers.push(readback);
    device.queue.writeBuffer(inputBuffer, 0, input.data);
    device.queue.writeBuffer(weights, 0, plan.kernel);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const uniforms: GPUBuffer[] = [];
    const dispatch = (
      entryPoint: EntryPoint,
      stage: Stage,
      resources: Partial<Record<Slot, GPUBuffer>>,
      extent: readonly [number, number],
    ) => {
      const uniform = device.createBuffer({
        label: `${entryPoint} params`,
        size: PARAMS_BYTES,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
      uniforms.push(uniform);
      device.queue.writeBuffer(uniform, 0, paramsBytes({ ...stage, clamp: plan.clamp }));
      const pipeline = this.#pipelines[entryPoint];
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniform } }];
      for (const [slot, buffer] of Object.entries(resources) as [Slot, GPUBuffer][]) {
        entries.push({ binding: SLOT[slot], resource: { buffer } });
      }
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
      );
      pass.dispatchWorkgroups(
        Math.ceil(extent[0] / WORKGROUP_SIZE),
        Math.ceil(extent[1] / WORKGROUP_SIZE),
      );
    };

    const { factor, kernel, exponent } = plan;
    const radius = (kernel.length - 1) / 2;
    dispatch(
      "prepare",
      { width, height, outWidth: width, outHeight: height, exponent },
      { src_u32: inputBuffer, dst_f: planeA },
      [width, height],
    );
    if (factor > 1) {
      const dw = Math.ceil(width / factor);
      const dh = Math.ceil(height / factor);
      dispatch(
        "resample",
        { width, height, outWidth: dw, outHeight: dh, scale: factor },
        { src_f: planeA, dst_f: planeB },
        [dw, dh],
      );
      dispatch(
        "blur_h",
        { width: dw, height: dh, outWidth: dw, outHeight: dh, radius },
        { src_f: planeB, dst_f: planeA, weights },
        [dw, dh],
      );
      dispatch(
        "blur_v",
        { width: dw, height: dh, outWidth: dw, outHeight: dh, radius },
        { src_f: planeA, dst_f: planeB, weights },
        [dw, dh],
      );
      dispatch(
        "resample",
        { width: dw, height: dh, outWidth: width, outHeight: height, scale: 1 / factor },
        { src_f: planeB, dst_f: planeA },
        [width, height],
      );
    } else {
      dispatch(
        "blur_h",
        { width, height, outWidth: width, outHeight: height, radius },
        { src_f: planeA, dst_f: planeB, weights },
        [width, height],
      );
      dispatch(
        "blur_v",
        { width, height, outWidth: width, outHeight: height, radius },
        { src_f: planeB, dst_f: planeA, weights },
        [width, height],
      );
    }
    dispatch(
      "finish",
      { width, height, outWidth: width, outHeight: height, exponent },
      { src_f: planeA, dst_u32: output },
      [width, height],
    );
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, pixels * RGBA8_BYTES_PER_PIXEL);
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(MAP_READ_MODE);
    const bytes = new Uint8ClampedArray(readback.getMappedRange().slice(0));
    readback.unmap();
    for (const buffer of [...buffers, ...uniforms]) buffer.destroy();
    return new Surface(width, height, bytes);
  }
}

/** Encodes a `Params` uniform (little-endian, matching the WGSL struct layout). */
function paramsBytes(stage: Stage): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(PARAMS_BYTES));
  view.setUint32(0, stage.width, true);
  view.setUint32(4, stage.height, true);
  view.setUint32(8, stage.outWidth, true);
  view.setUint32(12, stage.outHeight, true);
  view.setInt32(16, stage.radius ?? 0, true);
  view.setFloat32(20, stage.exponent ?? 0, true);
  view.setFloat32(24, stage.scale ?? 0, true);
  view.setUint32(28, stage.clamp ? 1 : 0, true);
  return view.buffer;
}
