import { Surface } from "@openpaint/document";
import { ARTISTIC_PARAMS_BYTES } from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";

const WORKGROUP_SIZE = 8;
const RGBA8_BYTES_PER_PIXEL = 4;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;
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
 * packed output comes back from slot 3. The stage is submitted and read back before it returns,
 * so a later stage can use its result.
 */
export async function runStage(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  width: number,
  height: number,
  fields: StageFields,
  inputs: readonly Uint8ClampedArray[],
): Promise<Surface> {
  const bytes = width * height * RGBA8_BYTES_PER_PIXEL;
  const buffers: GPUBuffer[] = [];
  const buffer = (label: string, size: number, usage: number) => {
    const created = device.createBuffer({ label, size, usage });
    buffers.push(created);
    return created;
  };

  const uniform = buffer(
    "params",
    ARTISTIC_PARAMS_BYTES,
    BufferUsage.UNIFORM | BufferUsage.COPY_DST,
  );
  device.queue.writeBuffer(uniform, 0, paramsBytes(width, height, fields));
  const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniform } }];
  inputs.forEach((data, index) => {
    const source = buffer(`input ${index}`, bytes, BufferUsage.STORAGE | BufferUsage.COPY_DST);
    device.queue.writeBuffer(source, 0, data);
    entries.push({ binding: index + 1, resource: { buffer: source } });
  });
  const output = buffer("output", bytes, BufferUsage.STORAGE | BufferUsage.COPY_SRC);
  entries.push({ binding: OUTPUT_SLOT, resource: { buffer: output } });
  const readback = buffer("readback", bytes, BufferUsage.MAP_READ | BufferUsage.COPY_DST);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
  pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
  pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
  device.queue.submit([encoder.finish()]);

  await readback.mapAsync(MAP_READ_MODE);
  const packed = new Uint8ClampedArray(readback.getMappedRange().slice(0));
  readback.unmap();
  for (const created of buffers) created.destroy();
  return new Surface(width, height, packed);
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
  const readback = device.createBuffer({
    label: "readback",
    size: bytes,
    usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
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
  encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
  device.queue.submit([encoder.finish()]);

  await readback.mapAsync(MAP_READ_MODE);
  const packed = new Uint8ClampedArray(readback.getMappedRange().slice(0));
  readback.unmap();
  for (const created of [params, source, output, readback, ...tableBuffers]) created.destroy();
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
