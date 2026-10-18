import { Surface } from "@openpaint/document";
import { clampHardness, segmentsOf, tipPad } from "./brush-segments";
import { BRUSH_WGSL } from "./brush-wgsl";
import { type BrushSettings, brushDabs, brushJoinsDabs } from "./cpu";
import { BufferUsage } from "./gpu-device";
import { readBack } from "./gpu-pool";

/** `GPUShaderStage.COMPUTE`; the DOM lib types WebGPU interfaces but not these globals. */
const COMPUTE_STAGE = 0x4;
/** Bytes of the shader's `Segment` uniform: two vec4f and sixteen 4-byte fields. */
const SEGMENT_BYTES = 96;
const WORKGROUP_SIZE = 8;
const BYTES_PER_PIXEL = 4;
/** The brush blend value that replaces the destination (TL-OPT-BLEND "Overwrite"). */
const OVERWRITE_BLEND = 14;
/** `paint_mode` values of the shader's `Segment` uniform. */
const PAINT = { blend: 0, erase: 1, overwrite: 2 } as const;

/**
 * One dispatch: its segment's ends (`x, y, reach`), the origin and size of its bounding box, and
 * its uniform slot.
 */
interface Stamp {
  readonly slot: number;
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  readonly originX: number;
  readonly originY: number;
  readonly extentX: number;
  readonly extentY: number;
}

/**
 * Brush stroke on WebGPU (TL-BRUSH-01). The dab list comes from the Rust kernels. The WGSL twin
 * raises a coverage buffer to each segment's swept tip coverage (each pair of joined dabs, or each
 * dab alone), one dispatch per segment, then paints the stroke's bounding box once with that
 * coverage. Every dispatch's uniform sits in one buffer and is selected with a dynamic offset, so
 * a stroke costs one command encoder.
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
    const pad = tipPad(brush.antialias);
    const node = (i: number): [number, number, number] => [
      dabs[i * 3] ?? 0,
      dabs[i * 3 + 1] ?? 0,
      (dabs[i * 3 + 2] ?? 0) * 0.5 + pad,
    ];
    const stamps: Stamp[] = [];
    for (const [ia, ib] of segmentsOf(dabs.length / 3, brushJoinsDabs(brush))) {
      const a = node(ia);
      const b = node(ib);
      const originX = Math.max(0, Math.floor(Math.min(a[0] - a[2], b[0] - b[2])));
      const originY = Math.max(0, Math.floor(Math.min(a[1] - a[2], b[1] - b[2])));
      const extentX = Math.min(width, Math.ceil(Math.max(a[0] + a[2], b[0] + b[2]))) - originX;
      const extentY = Math.min(height, Math.ceil(Math.max(a[1] + a[2], b[1] + b[2]))) - originY;
      if (extentX <= 0 || extentY <= 0) continue;
      stamps.push({ slot: stamps.length, a, b, originX, originY, extentX, extentY });
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
      a: [0, 0, 1],
      b: [0, 0, 1],
      originX: left,
      originY: top,
      extentX: right - left,
      extentY: bottom - top,
    };

    const device = this.#device;
    const stride = Math.max(device.limits.minUniformBufferOffsetAlignment, SEGMENT_BYTES);
    const params = new ArrayBuffer((stamps.length + 1) * stride);
    const view = new DataView(params);
    const paint = brush.erase
      ? PAINT.erase
      : brush.blend === OVERWRITE_BLEND
        ? PAINT.overwrite
        : PAINT.blend;
    for (const stamp of [...stamps, bounds]) {
      const base = stamp.slot * stride;
      for (let k = 0; k < 3; k++) {
        view.setFloat32(base + k * 4, stamp.a[k] ?? 0, true);
        view.setFloat32(base + 16 + k * 4, stamp.b[k] ?? 0, true);
      }
      view.setUint32(base + 32, stamp.originX, true);
      view.setUint32(base + 36, stamp.originY, true);
      view.setUint32(base + 40, stamp.extentX, true);
      view.setUint32(base + 44, stamp.extentY, true);
      view.setUint32(base + 48, width, true);
      view.setUint32(base + 52, paint, true);
      view.setUint32(base + 56, brush.blend, true);
      view.setUint32(base + 60, brush.antialias ? 1 : 0, true);
      view.setUint32(base + 64, brush.r, true);
      view.setUint32(base + 68, brush.g, true);
      view.setUint32(base + 72, brush.b, true);
      view.setUint32(base + 76, brush.a, true);
      view.setFloat32(base + 80, clampHardness(brush.hardness), true);
      view.setUint32(base + 84, brush.square ? 1 : 0, true);
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
    const dabBuffer = buffer(
      "brush segments",
      params.byteLength,
      BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    );
    const coverBuffer = buffer(
      "brush coverage",
      pixels * BYTES_PER_PIXEL,
      BufferUsage.STORAGE | BufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(pixelBuffer, 0, words);
    device.queue.writeBuffer(dabBuffer, 0, params);

    const bindGroup = device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: dabBuffer, size: SEGMENT_BYTES } },
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
    const bytes = await readBack(device, encoder, pixelBuffer, pixels * BYTES_PER_PIXEL);
    for (const created of buffers) created.destroy();
    return new Surface(width, height, bytes);
  }
}
