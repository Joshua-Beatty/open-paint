import { Surface } from "@openpaint/document";
import {
  BOKEH_BLUR_PARAMS_BYTES,
  BOKEH_BLUR_WGSL,
  type BokehBlurParams,
  type BokehBlurPlan,
  planBokehBlur,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";

const ENTRY_POINTS = ["prepare", "blur_vertical", "blur_horizontal", "finish"] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

/** Binding index of each storage resource in the WGSL twin (`@binding(n)`). */
const SLOT = {
  src_u32: 1,
  plane_in: 2,
  plane_out: 3,
  v_re: 4,
  v_im: 5,
  acc: 6,
  dst_u32: 7,
  vertical: 8,
  horizontal: 9,
} as const;
type Slot = keyof typeof SLOT;

/** Bytes per pixel of the `vec4<f32>` planes. */
const PLANE_BYTES_PER_PIXEL = 16;
/** Bytes per pixel of packed RGBA8 input and output. */
const RGBA8_BYTES_PER_PIXEL = 4;
const WORKGROUP_SIZE = 8;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;

/** The `Params` uniform of one dispatch (see `BOKEH_BLUR_WGSL`). */
interface Stage {
  readonly width: number;
  readonly height: number;
  readonly radius?: number;
  readonly firstTap?: number;
  readonly exponent?: number;
}

/**
 * Bokeh Blur (FX-BLUR-BOKEH) on WebGPU. Runs the WGSL twin of the Rust reference: one prepare pass, then a
 * vertical and a horizontal pass per complex term, then the output. The terms accumulate into one buffer. Each
 * call owns its buffers, so parameter changes only rebind uniforms and never rebuild a pipeline (FX-A-00-02c).
 */
export class GpuBokehBlur {
  readonly #device: GPUDevice;
  readonly #pipelines: Readonly<Record<EntryPoint, GPUComputePipeline>>;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "bokeh blur", code: BOKEH_BLUR_WGSL });
    const pipeline = (entryPoint: EntryPoint) =>
      device.createComputePipeline({
        label: `bokeh blur ${entryPoint}`,
        layout: "auto",
        compute: { module, entryPoint },
      });
    this.#pipelines = {
      prepare: pipeline("prepare"),
      blur_vertical: pipeline("blur_vertical"),
      blur_horizontal: pipeline("blur_horizontal"),
      finish: pipeline("finish"),
    };
  }

  /**
   * Returns the blurred `input` as a new surface. A radius below 1 returns a copy. Requires the Rust/WASM
   * kernels to be initialized, since the weights come from them.
   */
  async run(input: Surface, params: BokehBlurParams): Promise<Surface> {
    const plan = planBokehBlur(params);
    if (!plan) return new Surface(input.width, input.height, new Uint8ClampedArray(input.data));
    return this.runPlan(input, plan);
  }

  /** Runs Bokeh Blur from its plan (FX-BLUR-BOKEH-03). */
  async runPlan(input: Surface, plan: BokehBlurPlan): Promise<Surface> {
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
    const plane = storage("plane", pixels * PLANE_BYTES_PER_PIXEL, 0);
    const vRe = storage("vertical real", pixels * PLANE_BYTES_PER_PIXEL, 0);
    const vIm = storage("vertical imaginary", pixels * PLANE_BYTES_PER_PIXEL, 0);
    const acc = storage("accumulator", pixels * PLANE_BYTES_PER_PIXEL, 0);
    const inputBuffer = storage("input", pixels * RGBA8_BYTES_PER_PIXEL, BufferUsage.COPY_DST);
    const vertical = storage("vertical weights", plan.vertical.byteLength, BufferUsage.COPY_DST);
    const horizontal = storage(
      "horizontal weights",
      plan.horizontal.byteLength,
      BufferUsage.COPY_DST,
    );
    const output = storage("output", pixels * RGBA8_BYTES_PER_PIXEL, BufferUsage.COPY_SRC);
    const readback = device.createBuffer({
      label: "readback",
      size: pixels * RGBA8_BYTES_PER_PIXEL,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
    buffers.push(readback);
    device.queue.writeBuffer(inputBuffer, 0, input.data);
    device.queue.writeBuffer(vertical, 0, plan.vertical);
    device.queue.writeBuffer(horizontal, 0, plan.horizontal);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const uniforms: GPUBuffer[] = [];
    const dispatch = (
      entryPoint: EntryPoint,
      stage: Stage,
      resources: Partial<Record<Slot, GPUBuffer>>,
    ) => {
      const uniform = device.createBuffer({
        label: `${entryPoint} params`,
        size: BOKEH_BLUR_PARAMS_BYTES,
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
      uniforms.push(uniform);
      device.queue.writeBuffer(uniform, 0, paramsBytes(stage));
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
        Math.ceil(width / WORKGROUP_SIZE),
        Math.ceil(height / WORKGROUP_SIZE),
      );
    };

    const { halfWidth, terms, exponent } = plan;
    const taps = 2 * halfWidth + 1;
    const stage = (firstTap: number): Stage => ({
      width,
      height,
      radius: halfWidth,
      firstTap,
      exponent,
    });
    dispatch("prepare", stage(0), { src_u32: inputBuffer, plane_out: plane });
    for (let term = 0; term < terms; term++) {
      const firstTap = term * taps;
      dispatch("blur_vertical", stage(firstTap), {
        plane_in: plane,
        v_re: vRe,
        v_im: vIm,
        vertical,
      });
      dispatch("blur_horizontal", stage(firstTap), {
        v_re: vRe,
        v_im: vIm,
        acc,
        horizontal,
      });
    }
    dispatch("finish", stage(0), { acc, dst_u32: output });
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
  const view = new DataView(new ArrayBuffer(BOKEH_BLUR_PARAMS_BYTES));
  view.setUint32(0, stage.width, true);
  view.setUint32(4, stage.height, true);
  view.setInt32(8, stage.radius ?? 0, true);
  view.setUint32(12, stage.firstTap ?? 0, true);
  view.setFloat32(16, stage.exponent ?? 0, true);
  return view.buffer;
}
