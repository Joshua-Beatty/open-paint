import { Surface } from "@openpaint/document";
import { ARTISTIC_PARAMS_BYTES } from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";
import { type BorrowedBuffer, borrowBuffer, readBack } from "./gpu-pool";

/** Buffers from this size up are lent from the device's pool rather than created per run. */
const POOLED_BYTES = 1 << 20;

const WORKGROUP_SIZE = 8;
const RGBA8_BYTES_PER_PIXEL = 4;
/** The storage slot of the packed RGBA8 output in every stage shader. */
const OUTPUT_SLOT = 3;

/** The `Params` fields of one dispatch (see `ARTISTIC_PARAMS_WGSL`). Unset fields read as 0. */
export interface StageFields {
  readonly f0?: number;
  readonly f1?: number;
  readonly f2?: number;
  readonly i0?: number;
  readonly u0?: number;
  readonly u1?: number;
}

/**
 * One compute entry point over RGBA8 images. `inputs` bind to slots 1 and 2 in order, and the
 * packed output comes back from slot 3. The stage is submitted and read back before it returns.
 */
export async function runStage(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  width: number,
  height: number,
  fields: StageFields,
  inputs: readonly Uint8ClampedArray[],
): Promise<Surface> {
  const chain = new StageChain(device, width, height);
  try {
    const sources = inputs.map((data) => chain.upload(data));
    return await chain.read(chain.stage(pipeline, fields, sources));
  } finally {
    chain.destroy();
  }
}

/**
 * Stages of a multi-stage effect recorded into one command encoder: each stage's output stays in a
 * GPU buffer that later stages read, and only the last one is read back (L9, L11), so a chain costs
 * one wait on the GPU instead of one per stage.
 */
export class StageChain {
  readonly encoder: GPUCommandEncoder;
  readonly bytes: number;
  readonly #buffers: GPUBuffer[] = [];
  readonly #lent: BorrowedBuffer[] = [];

  constructor(
    readonly device: GPUDevice,
    readonly width: number,
    readonly height: number,
  ) {
    this.encoder = device.createCommandEncoder({ label: "stage chain" });
    this.bytes = width * height * RGBA8_BYTES_PER_PIXEL;
  }

  /** A packed RGBA8 storage buffer for one image of the chain, freed with the chain. */
  image(label: string): GPUBuffer {
    return this.buffer(label, this.bytes, BufferUsage.STORAGE | BufferUsage.COPY_SRC);
  }

  /**
   * A buffer freed with the chain. Large ones (images, planes) are lent from the device's pool and
   * go back to it, so the next preview of the session reuses them (L9).
   */
  buffer(label: string, size: number, usage: number): GPUBuffer {
    if (size >= POOLED_BYTES) {
      const lent = borrowBuffer(this.device, label, size, usage);
      this.#lent.push(lent);
      return lent.buffer;
    }
    const created = this.device.createBuffer({ label, size, usage });
    this.#buffers.push(created);
    return created;
  }

  /** Uploads packed RGBA8 pixels into a new image of the chain. */
  upload(data: Uint8ClampedArray): GPUBuffer {
    const source = this.buffer(
      "stage input",
      this.bytes,
      BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
    );
    this.device.queue.writeBuffer(source, 0, data);
    return source;
  }

  /** Records one `ARTISTIC_PARAMS_WGSL` stage over `inputs` (slots 1 and 2) into a new image. */
  stage(
    pipeline: GPUComputePipeline,
    fields: StageFields,
    inputs: readonly GPUBuffer[],
  ): GPUBuffer {
    const { device, width, height } = this;
    const uniform = this.buffer(
      "params",
      ARTISTIC_PARAMS_BYTES,
      BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(uniform, 0, paramsBytes(width, height, fields));
    const output = this.image("stage output");
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: uniform } },
      ...inputs.map((buffer, index) => ({ binding: index + 1, resource: { buffer } })),
      { binding: OUTPUT_SLOT, resource: { buffer: output } },
    ];
    const pass = this.encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
    );
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
    pass.end();
    return output;
  }

  /** Submits the chain and reads `image` back. */
  async read(image: GPUBuffer): Promise<Surface> {
    const packed = await readBack(this.device, this.encoder, image, this.bytes);
    return new Surface(this.width, this.height, packed);
  }

  destroy(): void {
    for (const created of this.#buffers.splice(0)) created.destroy();
    for (const lent of this.#lent.splice(0)) lent.release();
  }
}

/**
 * One compute entry point over a packed RGBA8 image with its own `Params` uniform, for the shaders
 * whose fields do not fit `ARTISTIC_PARAMS_WGSL`. Binding 0 is the uniform, 1 the source and 2 the
 * output. `tables` are read-only storage arrays at bindings 3 and up, in order. The stage is submitted
 * and read back before it returns.
 */
export async function runPackedStage(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  width: number,
  height: number,
  uniform: ArrayBuffer,
  input: Uint8ClampedArray,
  tables: readonly ArrayBufferView[] = [],
): Promise<Surface> {
  const bytes = width * height * RGBA8_BYTES_PER_PIXEL;
  const params = device.createBuffer({
    label: "params",
    size: uniform.byteLength,
    usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
  });
  const source = device.createBuffer({
    label: "input",
    size: bytes,
    usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
  });
  const output = device.createBuffer({
    label: "output",
    size: bytes,
    usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC,
  });
  const tableBuffers = tables.map((table, index) => {
    const buffer = device.createBuffer({
      label: `table ${index}`,
      size: table.byteLength,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, table);
    return buffer;
  });
  device.queue.writeBuffer(params, 0, uniform);
  device.queue.writeBuffer(source, 0, input);

  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: { buffer: source } },
      { binding: 2, resource: { buffer: output } },
      ...tableBuffers.map((buffer, index) => ({ binding: 3 + index, resource: { buffer } })),
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
  pass.end();
  const packed = await readBack(device, encoder, output, bytes);
  for (const created of [params, source, output, ...tableBuffers]) created.destroy();
  return new Surface(width, height, packed);
}

/** Encodes the `Params` uniform (little-endian, matching the WGSL struct layout). */
function paramsBytes(width: number, height: number, fields: StageFields): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(ARTISTIC_PARAMS_BYTES));
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setFloat32(8, fields.f0 ?? 0, true);
  view.setFloat32(12, fields.f1 ?? 0, true);
  view.setFloat32(16, fields.f2 ?? 0, true);
  view.setInt32(20, fields.i0 ?? 0, true);
  view.setUint32(24, fields.u0 ?? 0, true);
  view.setUint32(28, fields.u1 ?? 0, true);
  return view.buffer;
}

/** The entry points of one shader, each a compute pipeline over the same module. */
export function entryPipelines<Entry extends string>(
  device: GPUDevice,
  label: string,
  code: string,
  entryPoints: readonly Entry[],
): Record<Entry, GPUComputePipeline> {
  const module = device.createShaderModule({ label, code });
  const pipelines = {} as Record<Entry, GPUComputePipeline>;
  for (const entryPoint of entryPoints) {
    pipelines[entryPoint] = device.createComputePipeline({
      label: `${label} ${entryPoint}`,
      layout: "auto",
      compute: { module, entryPoint },
    });
  }
  return pipelines;
}
