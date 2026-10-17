import { Surface } from "@openpaint/document";
import {
  MORPHOLOGY_PARAMS_BYTES,
  MORPHOLOGY_WGSL,
  type MorphologyParams,
  morphologyCode,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";

const WORKGROUP_SIZE = 8;
const RGBA8_BYTES_PER_PIXEL = 4;
/** One premultiplied `vec4<f32>` per pixel in the scratch buffer. */
const SCRATCH_BYTES_PER_PIXEL = 16;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;

/**
 * Morphology (FX-DIST-MORPH) on WebGPU, as two compute passes. `horizontal` writes each pixel's
 * premultiplied window extremum along its row, and `vertical` takes the extremum down each column
 * and writes straight-alpha RGBA8. The shader is the WGSL twin of `morphology_rgba8`. One pair of
 * pipelines serves every parameter set (FX-A-00-02c).
 */
export class GpuMorphology {
  readonly #device: GPUDevice;
  readonly #horizontal: GPUComputePipeline;
  readonly #vertical: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "morphology", code: MORPHOLOGY_WGSL });
    this.#horizontal = device.createComputePipeline({
      label: "morphology horizontal",
      layout: "auto",
      compute: { module, entryPoint: "horizontal" },
    });
    this.#vertical = device.createComputePipeline({
      label: "morphology vertical",
      layout: "auto",
      compute: { module, entryPoint: "vertical" },
    });
  }

  /** Returns the morphed `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: MorphologyParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const device = this.#device;
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
    const scratch = buffer("scratch", pixels * SCRATCH_BYTES_PER_PIXEL, BufferUsage.STORAGE);
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
    const uniform = buffer(
      "params",
      MORPHOLOGY_PARAMS_BYTES,
      BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(source, 0, input.data);
    device.queue.writeBuffer(uniform, 0, paramsBytes(width, height, params));

    const horizontalGroup = device.createBindGroup({
      layout: this.#horizontal.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: source } },
        { binding: 2, resource: { buffer: scratch } },
      ],
    });
    const verticalGroup = device.createBindGroup({
      layout: this.#vertical.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 2, resource: { buffer: scratch } },
        { binding: 3, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const groupsX = Math.ceil(width / WORKGROUP_SIZE);
    const groupsY = Math.ceil(height / WORKGROUP_SIZE);
    const horizontalPass = encoder.beginComputePass();
    horizontalPass.setPipeline(this.#horizontal);
    horizontalPass.setBindGroup(0, horizontalGroup);
    horizontalPass.dispatchWorkgroups(groupsX, groupsY);
    horizontalPass.end();
    const verticalPass = encoder.beginComputePass();
    verticalPass.setPipeline(this.#vertical);
    verticalPass.setBindGroup(0, verticalGroup);
    verticalPass.dispatchWorkgroups(groupsX, groupsY);
    verticalPass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, pixels * RGBA8_BYTES_PER_PIXEL);
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(MAP_READ_MODE);
    const bytes = new Uint8ClampedArray(readback.getMappedRange().slice(0));
    readback.unmap();
    for (const created of buffers) created.destroy();
    return new Surface(width, height, bytes);
  }
}

/** Encodes the `Params` uniform (little-endian, matching the WGSL struct layout). */
function paramsBytes(width: number, height: number, params: MorphologyParams): ArrayBuffer {
  const bytes = new ArrayBuffer(MORPHOLOGY_PARAMS_BYTES);
  const view = new DataView(bytes);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, params.width, true);
  view.setUint32(12, params.height, true);
  view.setUint32(16, morphologyCode(params), true);
  return bytes;
}
