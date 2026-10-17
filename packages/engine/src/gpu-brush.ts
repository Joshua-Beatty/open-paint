import { Surface } from "@openpaint/document";
import { BRUSH_WGSL } from "./brush-wgsl";
import { type BrushSettings, brushDabs, brushTipSprite } from "./cpu";
import { BufferUsage } from "./gpu-device";

/** `GPUShaderStage.COMPUTE`; the DOM lib types WebGPU interfaces but not these globals. */
const COMPUTE_STAGE = 0x4;
/** Bytes of the shader's `Dab` uniform: sixteen 4-byte fields. */
const DAB_BYTES = 64;
const WORKGROUP_SIZE = 8;
const BYTES_PER_PIXEL = 4;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;
/** The brush blend value that replaces the destination (TL-OPT-BLEND "Overwrite"). */
const OVERWRITE_BLEND = 14;
/** `paint_mode` values of the shader's `Dab` uniform. */
const PAINT = { blend: 0, erase: 1, overwrite: 2 } as const;

/** One dispatch: its dab, the origin and size of its bounding box, and its uniform slot. */
interface Stamp {
  readonly slot: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly originX: number;
  readonly originY: number;
  readonly extentX: number;
  readonly extentY: number;
}

/**
 * Brush stroke on WebGPU (TL-BRUSH-01). The dab list and the tip sprite come from the Rust kernels.
 * The WGSL twin raises a coverage buffer to each dab's tip coverage, one dispatch per dab, then
 * paints the stroke's bounding box once with that coverage. Every dispatch's uniform sits in one
 * buffer and is selected with a dynamic offset, so a stroke costs one command encoder.
 */
export class GpuBrush {
  readonly #device: GPUDevice;
  readonly #layout: GPUBindGroupLayout;
  readonly #pipeline: GPUComputePipeline;
  readonly #apply: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "brush", code: BRUSH_WGSL });
    this.#layout = device.createBindGroupLayout({
      label: "brush",
      entries: [
        {
          binding: 0,
          visibility: COMPUTE_STAGE,
          buffer: { type: "uniform", hasDynamicOffset: true },
        },
        { binding: 1, visibility: COMPUTE_STAGE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: COMPUTE_STAGE, buffer: { type: "storage" } },
        { binding: 3, visibility: COMPUTE_STAGE, buffer: { type: "storage" } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.#layout] });
    this.#pipeline = device.createComputePipeline({
      label: "brush stamp",
      layout,
      compute: { module, entryPoint: "stamp" },
    });
    this.#apply = device.createComputePipeline({
      label: "brush apply",
      layout,
      compute: { module, entryPoint: "apply" },
    });
  }

  /**
   * Returns `input` with the stroke rendered on it. `path` is flat `x, y, pressure` triples in
   * canvas pixels. Requires the Rust/WASM kernels to be initialized.
   */
  async run(input: Surface, path: Float32Array, brush: BrushSettings): Promise<Surface> {
    const { width, height } = input;
    if (brush.blend > OVERWRITE_BLEND) throw new RangeError(`unknown blend mode ${brush.blend}`);
    const copy = () => new Surface(width, height, new Uint8ClampedArray(input.data));
    if (width === 0 || height === 0) return copy();

    const dabs = brushDabs(path, brush);
    const stamps: Stamp[] = [];
    for (let i = 0; i < dabs.length; i += 3) {
      const x = dabs[i] ?? 0;
      const y = dabs[i + 1] ?? 0;
      const radius = (dabs[i + 2] ?? 0) / 2;
      const originX = Math.max(0, Math.floor(x - radius));
      const originY = Math.max(0, Math.floor(y - radius));
      const extentX = Math.min(width, Math.ceil(x + radius)) - originX;
      const extentY = Math.min(height, Math.ceil(y + radius)) - originY;
      if (extentX <= 0 || extentY <= 0) continue;
      stamps.push({
        slot: stamps.length,
        x,
        y,
        radius,
        originX,
        originY,
        extentX,
        extentY,
      });
    }
    if (stamps.length === 0) return copy();
    // The last slot is the stroke's bounding box, which `apply` paints.
    let left = width;
    let top = height;
    let right = 0;
    let bottom = 0;
    for (const stamp of stamps) {
      left = Math.min(left, stamp.originX);
      top = Math.min(top, stamp.originY);
      right = Math.max(right, stamp.originX + stamp.extentX);
      bottom = Math.max(bottom, stamp.originY + stamp.extentY);
    }
    const bounds: Stamp = {
      slot: stamps.length,
      x: 0,
      y: 0,
      radius: 1,
      originX: left,
      originY: top,
      extentX: right - left,
      extentY: bottom - top,
    };

    const device = this.#device;
    const stride = Math.max(device.limits.minUniformBufferOffsetAlignment, DAB_BYTES);
    const params = new ArrayBuffer((stamps.length + 1) * stride);
    const view = new DataView(params);
    const sprite = brushTipSprite(brush);
    const spriteN = Math.round(Math.sqrt(sprite.length));
    const paint = brush.erase
      ? PAINT.erase
      : brush.blend === OVERWRITE_BLEND
        ? PAINT.overwrite
        : PAINT.blend;
    for (const stamp of [...stamps, bounds]) {
      const base = stamp.slot * stride;
      view.setFloat32(base, stamp.x, true);
      view.setFloat32(base + 4, stamp.y, true);
      view.setFloat32(base + 8, stamp.radius, true);
      view.setUint32(base + 12, spriteN, true);
      view.setUint32(base + 16, stamp.originX, true);
      view.setUint32(base + 20, stamp.originY, true);
      view.setUint32(base + 24, stamp.extentX, true);
      view.setUint32(base + 28, stamp.extentY, true);
      view.setUint32(base + 32, width, true);
      view.setUint32(base + 36, paint, true);
      view.setUint32(base + 40, brush.blend, true);
      view.setUint32(base + 44, brush.antialias ? 1 : 0, true);
      view.setUint32(base + 48, brush.r, true);
      view.setUint32(base + 52, brush.g, true);
      view.setUint32(base + 56, brush.b, true);
      view.setUint32(base + 60, brush.a, true);
    }

    const pixels = width * height;
    const words = new Uint32Array(pixels);
    new Uint8Array(words.buffer).set(input.data);
    const buffers: GPUBuffer[] = [];
    const buffer = (label: string, size: number, usage: number) => {
      const created = device.createBuffer({ label, size, usage });
      buffers.push(created);
      return created;
    };
    const pixelBuffer = buffer(
      "brush pixels",
      pixels * BYTES_PER_PIXEL,
      BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC,
    );
    const tipBuffer = buffer(
      "brush tip",
      sprite.byteLength,
      BufferUsage.STORAGE | BufferUsage.COPY_DST,
    );
    const dabBuffer = buffer(
      "brush dabs",
      params.byteLength,
      BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    );
    const coverBuffer = buffer(
      "brush coverage",
      pixels * BYTES_PER_PIXEL,
      BufferUsage.STORAGE | BufferUsage.COPY_DST,
    );
    const readback = buffer(
      "readback",
      pixels * BYTES_PER_PIXEL,
      BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(pixelBuffer, 0, words);
    device.queue.writeBuffer(tipBuffer, 0, sprite);
    device.queue.writeBuffer(dabBuffer, 0, params);

    const bindGroup = device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: dabBuffer, size: DAB_BYTES } },
        { binding: 1, resource: { buffer: tipBuffer } },
        { binding: 2, resource: { buffer: pixelBuffer } },
        { binding: 3, resource: { buffer: coverBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const dispatch = (stamp: Stamp) => {
      pass.setBindGroup(0, bindGroup, [stamp.slot * stride]);
      pass.dispatchWorkgroups(
        Math.ceil(stamp.extentX / WORKGROUP_SIZE),
        Math.ceil(stamp.extentY / WORKGROUP_SIZE),
      );
    };
    pass.setPipeline(this.#pipeline);
    for (const stamp of stamps) dispatch(stamp);
    pass.setPipeline(this.#apply);
    dispatch(bounds);
    pass.end();
    encoder.copyBufferToBuffer(pixelBuffer, 0, readback, 0, pixels * BYTES_PER_PIXEL);
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(MAP_READ_MODE);
    const bytes = new Uint8ClampedArray(readback.getMappedRange().slice(0));
    readback.unmap();
    for (const created of buffers) created.destroy();
    return new Surface(width, height, bytes);
  }
}
