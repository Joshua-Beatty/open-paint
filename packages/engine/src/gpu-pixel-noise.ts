import { Surface } from "@openpaint/document";
import { PIXEL_NOISE_WGSL } from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";

const WORKGROUP_SIZE = 8;
const RGBA8_BYTES_PER_PIXEL = 4;
/** Bytes of the `NoiseParams` uniform: width, height, seed and padding. */
const PARAMS_BYTES = 16;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;

/**
 * The per-pixel generator of the effects (FX-A-00-05) on WebGPU. The shader is the WGSL twin of
 * `crates/opaint-cpu/src/rng.rs`, so a seed gives the same noise on both backends.
 */
export class GpuPixelNoise {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "pixel noise", code: PIXEL_NOISE_WGSL });
    this.#pipeline = device.createComputePipeline({
      label: "pixel noise",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the noise image of the given size and seed, as opaque RGBA8. */
  async run(width: number, height: number, seed: number): Promise<Surface> {
    if (width === 0 || height === 0) return new Surface(width, height);
    const device = this.#device;
    const pixels = width * height;
    const bytes = pixels * RGBA8_BYTES_PER_PIXEL;

    const uniform = device.createBuffer({
      label: "noise params",
      size: PARAMS_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    const output = device.createBuffer({
      label: "noise output",
      size: bytes,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      label: "noise readback",
      size: bytes,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
    const params = new Uint32Array([width, height, seed >>> 0, 0]);
    device.queue.writeBuffer(uniform, 0, params);

    const pipelineLayout = this.#pipeline.getBindGroupLayout(0);
    const bindGroup = device.createBindGroup({
      layout: pipelineLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(MAP_READ_MODE);
    const data = new Uint8ClampedArray(readback.getMappedRange().slice(0));
    readback.unmap();
    uniform.destroy();
    output.destroy();
    readback.destroy();
    return new Surface(width, height, data);
  }
}
