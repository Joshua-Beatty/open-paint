import { Surface } from "@openpaint/document";
import {
  PIXELATE_PARAMS_BYTES,
  PIXELATE_WGSL,
  type PixelateParams,
  pixelateCodes,
  pixelateGrid,
  pixelatePlan,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";
import { readBack } from "./gpu-pool";

const WORKGROUP_SIZE = 8;
const RGBA8_BYTES_PER_PIXEL = 4;

/**
 * Pixelate (FX-DIST-PIXELATE) on WebGPU, as two compute passes. `scale_down` writes one premultiplied
 * cell per grid cell, and `scale_up` maps every pixel into the cells. The shader is the WGSL twin of
 * `pixelate_rgba8`, and the plan and grid come from the same Rust functions. One pair of pipelines
 * serves every parameter set (FX-A-00-02c). Requires the WASM kernels to be initialized.
 */
export class GpuPixelate {
  readonly #device: GPUDevice;
  readonly #scaleDown: GPUComputePipeline;
  readonly #scaleUp: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "pixelate", code: PIXELATE_WGSL });
    this.#scaleDown = device.createComputePipeline({
      label: "pixelate scale down",
      layout: "auto",
      compute: { module, entryPoint: "scale_down" },
    });
    this.#scaleUp = device.createComputePipeline({
      label: "pixelate scale up",
      layout: "auto",
      compute: { module, entryPoint: "scale_up" },
    });
  }

  /** Returns the pixelated `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: PixelateParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);

    const device = this.#device;
    const plan = pixelatePlan(params, width, height);
    const grid = pixelateGrid(plan, width, height);
    const { down, up } = pixelateCodes(params);
    const cols = grid[2] ?? 0;
    const rows = grid[3] ?? 0;
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
    const cells = buffer("cells", cols * rows * RGBA8_BYTES_PER_PIXEL, BufferUsage.STORAGE);
    const output = buffer(
      "output",
      pixels * RGBA8_BYTES_PER_PIXEL,
      BufferUsage.STORAGE | BufferUsage.COPY_SRC,
    );
    const uniform = buffer(
      "params",
      PIXELATE_PARAMS_BYTES,
      BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(source, 0, input.data);
    device.queue.writeBuffer(uniform, 0, paramsBytes(width, height, grid, down, up, plan));

    const scaleDownGroup = device.createBindGroup({
      layout: this.#scaleDown.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: source } },
        { binding: 2, resource: { buffer: cells } },
      ],
    });
    const scaleUpGroup = device.createBindGroup({
      layout: this.#scaleUp.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: source } },
        { binding: 2, resource: { buffer: cells } },
        { binding: 3, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const downPass = encoder.beginComputePass();
    downPass.setPipeline(this.#scaleDown);
    downPass.setBindGroup(0, scaleDownGroup);
    downPass.dispatchWorkgroups(Math.ceil(cols / WORKGROUP_SIZE), Math.ceil(rows / WORKGROUP_SIZE));
    downPass.end();
    const upPass = encoder.beginComputePass();
    upPass.setPipeline(this.#scaleUp);
    upPass.setBindGroup(0, scaleUpGroup);
    upPass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP_SIZE),
      Math.ceil(height / WORKGROUP_SIZE),
    );
    upPass.end();
    const bytes = await readBack(device, encoder, output, pixels * RGBA8_BYTES_PER_PIXEL);
    for (const created of buffers) created.destroy();
    return new Surface(width, height, bytes);
  }
}

/** Encodes the `Params` uniform (little-endian, matching the WGSL struct layout). */
function paramsBytes(
  width: number,
  height: number,
  grid: Int32Array,
  down: number,
  up: number,
  plan: Float32Array,
): ArrayBuffer {
  const bytes = new ArrayBuffer(PIXELATE_PARAMS_BYTES);
  const view = new DataView(bytes);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, grid[2] ?? 0, true);
  view.setUint32(12, grid[3] ?? 0, true);
  view.setInt32(16, grid[0] ?? 0, true);
  view.setInt32(20, grid[1] ?? 0, true);
  view.setUint32(24, down, true);
  view.setUint32(28, up, true);
  new Float32Array(bytes, 32, 4).set(plan);
  return bytes;
}
