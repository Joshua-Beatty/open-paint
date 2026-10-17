import { Surface } from "@openpaint/document";
import {
  FROSTED_GLASS_PARAMS_BYTES,
  FROSTED_GLASS_WGSL,
  type FrostedGlassParams,
  frostedGlassPlan,
  frostedGlassSeeds,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";

const WORKGROUP_SIZE = 8;
const RGBA8_BYTES_PER_PIXEL = 4;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;

/**
 * Frosted Glass (FX-DIST-FROST) on WebGPU. The shader is the WGSL twin of `frost_rgba8`, so the same
 * parameters give the same pixels on both backends. One pipeline serves every parameter set: a run
 * only writes its uniform and seeds (FX-A-00-02c). Requires the WASM kernels to be initialized, for
 * the seeds.
 */
export class GpuFrostedGlass {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({
      label: "frosted glass",
      code: FROSTED_GLASS_WGSL,
    });
    this.#pipeline = device.createComputePipeline({
      label: "frosted glass",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the scattered `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: FrostedGlassParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const device = this.#device;
    const pixels = width * height;
    const seeds = frostedGlassSeeds(params);
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
    const seedBuffer = buffer(
      "seeds",
      seeds.byteLength,
      BufferUsage.STORAGE | BufferUsage.COPY_DST,
    );
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
      FROSTED_GLASS_PARAMS_BYTES,
      BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(source, 0, input.data);
    device.queue.writeBuffer(seedBuffer, 0, seeds);
    device.queue.writeBuffer(
      uniform,
      0,
      paramsBytes(width, height, seeds.length, frostedGlassPlan(params)),
    );

    const bindGroup = device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: source } },
        { binding: 2, resource: { buffer: seedBuffer } },
        { binding: 3, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bindGroup);
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
}

/** Encodes the `Params` uniform (little-endian, matching the WGSL struct layout). */
function paramsBytes(
  width: number,
  height: number,
  samples: number,
  plan: Float32Array,
): ArrayBuffer {
  const bytes = new ArrayBuffer(FROSTED_GLASS_PARAMS_BYTES);
  const view = new DataView(bytes);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, samples, true);
  new Float32Array(bytes, 16, 4).set(plan);
  return bytes;
}
