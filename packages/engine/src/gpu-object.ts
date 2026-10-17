import { Surface } from "@openpaint/document";
import {
  ALIGN_OBJECT_PARAMS_BYTES,
  ALIGN_OBJECT_WGSL,
  type AlignObjectParams,
  type AlignObjectPlan,
  DROP_SHADOW_PARAMS_BYTES,
  DROP_SHADOW_WGSL,
  type DropShadowParams,
  type DropShadowPlan,
  FLIP_OBJECT_PARAMS_BYTES,
  FLIP_OBJECT_WGSL,
  type FlipObjectParams,
  planAlignObject,
  planDropShadow,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";
import { readBack } from "./gpu-pool";
import { entryPipelines } from "./gpu-stage";

const SHADOW_ENTRIES = ["blur_h", "blur_v", "composite"] as const;
type ShadowEntry = (typeof SHADOW_ENTRIES)[number];

/** Binding index of each storage resource in `DROP_SHADOW_WGSL` (`@binding(n)`). */
const SLOT = { src: 1, plane_a: 2, plane_b: 3, weights: 4, dst: 5 } as const;
type Slot = keyof typeof SLOT;

const WORKGROUP_SIZE = 8;
/** Bytes per pixel of the packed RGBA8 input and output. */
const RGBA8_BYTES_PER_PIXEL = 4;
/** Bytes per pixel of the `f32` alpha planes. */
const PLANE_BYTES_PER_PIXEL = 4;

/**
 * Drop Shadow (FX-OBJ-DROPSHADOW) on WebGPU. Three stages run in one compute pass: the blur of the
 * alpha in two separable passes, then the composite. The stages mirror `object::drop_shadow_rgba8`,
 * and the Rust plan supplies the kernel, the offset, the shadow color and the opacity.
 */
export class GpuDropShadow {
  readonly #device: GPUDevice;
  readonly #pipelines: Readonly<Record<ShadowEntry, GPUComputePipeline>>;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipelines = entryPipelines(device, "drop shadow", DROP_SHADOW_WGSL, SHADOW_ENTRIES);
  }

  /** Returns the shadow of `input`, with the layer over it, as a new surface with straight alpha. */
  async run(input: Surface, params: DropShadowParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const plan = planDropShadow(params);
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
      size: DROP_SHADOW_PARAMS_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    buffers.push(uniform);
    device.queue.writeBuffer(source, 0, input.data);
    device.queue.writeBuffer(weights, 0, plan.weights);
    device.queue.writeBuffer(uniform, 0, paramsBytes(width, height, plan));

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const dispatch = (entry: ShadowEntry, resources: Partial<Record<Slot, GPUBuffer>>) => {
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

    dispatch("blur_h", { src: source, plane_a: planeA, weights });
    dispatch("blur_v", { plane_a: planeA, plane_b: planeB, weights });
    dispatch("composite", { src: source, plane_b: planeB, dst: output });
    pass.end();
    const bytes = await readBack(device, encoder, output, pixels * RGBA8_BYTES_PER_PIXEL);
    for (const buffer of buffers) buffer.destroy();
    return new Surface(width, height, bytes);
  }
}

/**
 * Align Object (FX-OBJ-ALIGN) on WebGPU: one dispatch translates the object by the plan's offset.
 * The object box comes from the shared Rust/WASM scan (`planAlignObject`), and the shader mirrors
 * `align::align_object_translate_rgba8` word for word, so the output equals the Rust reference.
 */
export class GpuAlignObject {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "align object", ALIGN_OBJECT_WGSL, ["main"]).main;
  }

  /** Returns `input` with its object aligned, as a new surface. `coverage` is the aliased selection. */
  async run(
    input: Surface,
    params: AlignObjectParams,
    coverage?: ArrayLike<number>,
  ): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const plan = planAlignObject(input, params, coverage);
    if (plan === null) return input.clone();

    const device = this.#device;
    const bytes = width * height * RGBA8_BYTES_PER_PIXEL;
    const buffers: GPUBuffer[] = [];
    const buffer = (label: string, size: number, usage: number) => {
      const created = device.createBuffer({ label, size, usage });
      buffers.push(created);
      return created;
    };
    const source = buffer("input", bytes, BufferUsage.STORAGE | BufferUsage.COPY_DST);
    // Coverage bytes, packed four to a word; one empty word when every pixel is selected.
    const mask = maskBytes(coverage, width * height);
    const maskBuffer = buffer(
      "coverage",
      mask.byteLength,
      BufferUsage.STORAGE | BufferUsage.COPY_DST,
    );
    const output = buffer("output", bytes, BufferUsage.STORAGE | BufferUsage.COPY_SRC);
    const uniform = buffer(
      "params",
      ALIGN_OBJECT_PARAMS_BYTES,
      BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(source, 0, input.data);
    device.queue.writeBuffer(maskBuffer, 0, mask);
    device.queue.writeBuffer(
      uniform,
      0,
      alignParamsBytes(width, height, plan, coverage !== undefined),
    );

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: source } },
          { binding: 2, resource: { buffer: maskBuffer } },
          { binding: 3, resource: { buffer: output } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
    pass.end();
    const out = await readBack(device, encoder, output, bytes);
    for (const created of buffers) created.destroy();
    return new Surface(width, height, out);
  }
}

/**
 * Flip Horizontal and Flip Vertical (FX-OBJ-FLIP) on WebGPU: one dispatch mirrors the selected
 * pixels about the region's centre line. The shader mirrors `flip::flip_object_rgba8` in integer
 * arithmetic, so the output equals the Rust reference.
 */
export class GpuFlipObject {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = entryPipelines(device, "flip", FLIP_OBJECT_WGSL, ["main"]).main;
  }

  /** Returns `input` with its selected pixels mirrored, as a new surface. */
  async run(
    input: Surface,
    params: FlipObjectParams,
    coverage?: ArrayLike<number>,
  ): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const device = this.#device;
    const bytes = width * height * RGBA8_BYTES_PER_PIXEL;
    const buffers: GPUBuffer[] = [];
    const buffer = (label: string, size: number, usage: number) => {
      const created = device.createBuffer({ label, size, usage });
      buffers.push(created);
      return created;
    };
    const source = buffer("input", bytes, BufferUsage.STORAGE | BufferUsage.COPY_DST);
    const mask = maskBytes(coverage, width * height);
    const maskBuffer = buffer(
      "coverage",
      mask.byteLength,
      BufferUsage.STORAGE | BufferUsage.COPY_DST,
    );
    const output = buffer("output", bytes, BufferUsage.STORAGE | BufferUsage.COPY_SRC);
    const uniform = buffer(
      "params",
      FLIP_OBJECT_PARAMS_BYTES,
      BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    );
    const view = new DataView(new ArrayBuffer(FLIP_OBJECT_PARAMS_BYTES));
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    view.setUint32(8, params.vertical ? 1 : 0, true);
    view.setUint32(12, coverage === undefined ? 0 : 1, true);
    device.queue.writeBuffer(source, 0, input.data);
    device.queue.writeBuffer(maskBuffer, 0, mask);
    device.queue.writeBuffer(uniform, 0, view.buffer);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: source } },
          { binding: 2, resource: { buffer: maskBuffer } },
          { binding: 3, resource: { buffer: output } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
    pass.end();
    const out = await readBack(device, encoder, output, bytes);
    for (const created of buffers) created.destroy();
    return new Surface(width, height, out);
  }
}

/** The coverage padded to whole words, or one zero word when there is no selection. */
function maskBytes(coverage: ArrayLike<number> | undefined, pixels: number): Uint8Array {
  if (coverage === undefined) return new Uint8Array(4);
  const padded = new Uint8Array(Math.ceil(pixels / 4) * 4);
  padded.set(coverage instanceof Uint8Array ? coverage : Uint8Array.from(coverage));
  return padded;
}

/** Encodes the `Params` uniform of Align Object (see `ALIGN_OBJECT_WGSL`). */
function alignParamsBytes(
  width: number,
  height: number,
  plan: AlignObjectPlan,
  hasMask: boolean,
): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(ALIGN_OBJECT_PARAMS_BYTES));
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setInt32(8, plan.dx, true);
  view.setInt32(12, plan.dy, true);
  view.setInt32(16, plan.box.x1, true);
  view.setInt32(20, plan.box.y1, true);
  view.setInt32(24, plan.box.x2, true);
  view.setInt32(28, plan.box.y2, true);
  view.setUint32(32, hasMask ? 1 : 0, true);
  view.setUint32(36, plan.faint ? 1 : 0, true);
  return view.buffer;
}

/** Encodes the `Params` uniform of Drop Shadow (see `DROP_SHADOW_WGSL`). */
function paramsBytes(width: number, height: number, plan: DropShadowPlan): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(DROP_SHADOW_PARAMS_BYTES));
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setInt32(8, (plan.weights.length - 1) / 2, true);
  view.setUint32(12, plan.onlyShadow ? 1 : 0, true);
  // The offset, the shadow color in linear light and the opacity, as `[dx, dy, r, g, b, opacity]`.
  for (const [index, value] of plan.plan.entries()) view.setFloat32(16 + index * 4, value, true);
  return view.buffer;
}
