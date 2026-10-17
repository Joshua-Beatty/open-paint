import { Surface } from "@openpaint/document";
import {
  ARTISTIC_PARAMS_BYTES,
  EDGE_DETECT_WGSL,
  type EdgeDetectParams,
  type EdgeDetectPlan,
  EMBOSS_PARAMS_BYTES,
  EMBOSS_WGSL,
  type EmbossParams,
  OUTLINE_PARAMS_BYTES,
  OUTLINE_WGSL,
  type OutlineParams,
  type OutlinePlan,
  planEdgeDetect,
  planEmboss,
  planOutline,
  planRelief,
  RELIEF_PARAMS_BYTES,
  RELIEF_WGSL,
  type ReliefParams,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";
import { runTiledBlur } from "./gpu-neighborhood-blur";
import { readBack } from "./gpu-pool";
import { entryPipelines, runPackedStage } from "./gpu-stage";

const EDGE_ENTRIES = ["premultiply", "blur_h", "blur_v", "edge"] as const;
type EdgeEntry = (typeof EDGE_ENTRIES)[number];

/** Binding index of each storage resource in `EDGE_DETECT_WGSL` (`@binding(n)`). */
const SLOT = { src: 1, plane_a: 2, plane_b: 3, weights: 4, dst: 5 } as const;
type Slot = keyof typeof SLOT;

const WORKGROUP_SIZE = 8;
/** Bytes per pixel of the packed RGBA8 input and output. */
const RGBA8_BYTES_PER_PIXEL = 4;
/** Bytes per pixel of the `vec4<f32>` planes. */
const PLANE_BYTES_PER_PIXEL = 16;

/**
 * Edge Detect (FX-STYL-EDGE) on WebGPU. Four stages run in one compute pass: the premultiply, the
 * clamped Gaussian pre-blur when Blurring is above 0, and the edge stage. The stages mirror
 * `edge_detect_rgba8`, and the Rust plan supplies the gain and the blur kernel.
 */
export class GpuEdgeDetect {
  readonly #device: GPUDevice;
  readonly #pipelines: Readonly<Record<EdgeEntry, GPUComputePipeline>>;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipelines = entryPipelines(device, "edge detect", EDGE_DETECT_WGSL, EDGE_ENTRIES);
  }

  /** Returns the edge map or overlay of `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: EdgeDetectParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const plan = planEdgeDetect(params);
    const device = this.#device;
    const pixels = width * height;
    const buffers: GPUBuffer[] = [];
    const storage = (label: string, size: number, usage: number) => {
      const buffer = device.createBuffer({ label, size, usage: BufferUsage.STORAGE | usage });
      buffers.push(buffer);
      return buffer;
    };
    const source = storage("input", pixels * RGBA8_BYTES_PER_PIXEL, BufferUsage.COPY_DST);
    const planeA = storage("plane A", pixels * PLANE_BYTES_PER_PIXEL, 0);
    const planeB = storage("plane B", pixels * PLANE_BYTES_PER_PIXEL, 0);
    const weights = storage("weights", plan.weights.byteLength, BufferUsage.COPY_DST);
    const output = storage("output", pixels * RGBA8_BYTES_PER_PIXEL, BufferUsage.COPY_SRC);
    const uniform = device.createBuffer({
      label: "params",
      size: ARTISTIC_PARAMS_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    buffers.push(uniform);
    device.queue.writeBuffer(source, 0, input.data);
    device.queue.writeBuffer(weights, 0, plan.weights);
    device.queue.writeBuffer(uniform, 0, edgeParamsBytes(width, height, plan));

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const dispatch = (entry: EdgeEntry, resources: Partial<Record<Slot, GPUBuffer>>) => {
      const pipeline = this.#pipelines[entry];
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

    dispatch("premultiply", { src: source, plane_a: planeA });
    if (plan.blurred) {
      dispatch("blur_h", { plane_a: planeA, plane_b: planeB, weights });
      dispatch("blur_v", { plane_b: planeB, plane_a: planeA, weights });
    }
    dispatch("edge", { src: source, plane_a: planeA, dst: output });
    pass.end();
    const bytes = await readBack(device, encoder, output, pixels * RGBA8_BYTES_PER_PIXEL);
    for (const buffer of buffers) buffer.destroy();
    return new Surface(width, height, bytes);
  }
}

/** Encodes the shared `Params` uniform of Edge Detect (see `EDGE_DETECT_WGSL`). */
function edgeParamsBytes(width: number, height: number, plan: EdgeDetectPlan): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(ARTISTIC_PARAMS_BYTES));
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setFloat32(8, plan.gain, true);
  view.setInt32(20, plan.radius, true);
  view.setUint32(24, plan.flags, true);
  return view.buffer;
}

/**
 * Emboss (FX-STYL-EMBOSS) on WebGPU: one pass over the whole image, with the kernel from the Rust
 * plan. The stage mirrors `emboss_rgba8`.
 */
export class GpuEmboss {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "emboss", EMBOSS_WGSL, ["emboss"] as const).emboss;
  }

  /** Returns the embossed `input` as a new surface, with opaque gray output. */
  async run(input: Surface, params: EmbossParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const plan = planEmboss(params);
    const uniform = new ArrayBuffer(EMBOSS_PARAMS_BYTES);
    const view = new DataView(uniform);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    return runPackedStage(this.#device, this.#pipeline, width, height, uniform, input.data, [
      plan.weights,
    ]);
  }
}

/**
 * Outline (FX-STYL-OUTLINE) on WebGPU. The shader is the WGSL twin of `outline_rgba8`: each pixel runs
 * the Median Blur rank search at the low and the high rank. It runs once per tile, awaiting each
 * submission, so the worker stays responsive (WEB-GPU-06).
 */
export class GpuOutline {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "outline", OUTLINE_WGSL, ["outline"] as const).outline;
  }

  /** Returns the outline of `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: OutlineParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const plan = planOutline(params);
    return runTiledBlur(this.#device, this.#pipeline, input, OUTLINE_PARAMS_BYTES, (origin) =>
      outlineParamsBytes(width, height, origin, params, plan),
    );
  }
}

/** Encodes the Outline `Params` uniform of little-endian u32 words (see `OUTLINE_WGSL`). */
function outlineParamsBytes(
  width: number,
  height: number,
  origin: { x: number; y: number },
  params: OutlineParams,
  plan: OutlinePlan,
): ArrayBuffer {
  const bytes = new ArrayBuffer(OUTLINE_PARAMS_BYTES);
  const view = new DataView(bytes);
  const words = [
    width,
    height,
    origin.x,
    origin.y,
    params.thickness,
    plan.lowRank,
    plan.highRank,
    params.quality,
  ];
  for (const [index, word] of words.entries()) view.setUint32(index * 4, word, true);
  return bytes;
}

/**
 * Relief (FX-STYL-RELIEF) on WebGPU: one pass over the whole image, with the kernel from the Rust
 * plan. The stage mirrors `relief_rgba8`.
 */
export class GpuRelief {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "relief", RELIEF_WGSL, ["relief"] as const).relief;
  }

  /** Returns the relief of `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: ReliefParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const plan = planRelief(params);
    const uniform = new ArrayBuffer(RELIEF_PARAMS_BYTES);
    const view = new DataView(uniform);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    return runPackedStage(this.#device, this.#pipeline, width, height, uniform, input.data, [
      plan.weights,
    ]);
  }
}
