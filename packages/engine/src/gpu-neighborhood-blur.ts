import { Surface } from "@openpaint/document";
import {
  MEDIAN_BLUR_PARAMS_BYTES,
  MEDIAN_BLUR_WGSL,
  type MedianBlurParams,
  SKETCH_BLUR_PARAMS_BYTES,
  SKETCH_BLUR_WGSL,
  type SketchBlurParams,
  type SketchBlurPlan,
  SURFACE_BLUR_PARAMS_BYTES,
  SURFACE_BLUR_WGSL,
  type SurfaceBlurParams,
  sketchBlurPlan,
  surfaceBlurSlope,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";

/** Pixels per side of one tile. Each tile is one dispatch, so no single submission runs long (WEB-GPU-05). */
export const NEIGHBORHOOD_TILE_PIXELS = 128;
const WORKGROUP_SIZE = 8;
const RGBA8_BYTES_PER_PIXEL = 4;
/** `GPUMapMode.READ`. */
const MAP_READ_MODE = 1;

/**
 * Median Blur (FX-BLUR-MEDIAN) on WebGPU. The shader is the WGSL twin of `median_blur_rgba8`, and it
 * runs once per tile, awaiting each submission so the worker stays responsive (WEB-GPU-06).
 */
export class GpuMedianBlur {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "median blur", code: MEDIAN_BLUR_WGSL });
    this.#pipeline = device.createComputePipeline({
      label: "median blur",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the blurred `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: MedianBlurParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    return runTiledBlur(this.#device, this.#pipeline, input, MEDIAN_BLUR_PARAMS_BYTES, (origin) =>
      paramsBytes(MEDIAN_BLUR_PARAMS_BYTES, [
        width,
        height,
        origin.x,
        origin.y,
        params.radius,
        params.percentile,
        params.quality,
        0,
      ]),
    );
  }
}

/**
 * Surface Blur (FX-BLUR-SURFACE) on WebGPU. The shader is the WGSL twin of `surface_blur_rgba8`, and
 * it takes the weight slope from `surface_slope`, so both backends use the same k.
 */
export class GpuSurfaceBlur {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "surface blur", code: SURFACE_BLUR_WGSL });
    this.#pipeline = device.createComputePipeline({
      label: "surface blur",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the blurred `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: SurfaceBlurParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const slope = surfaceBlurSlope(params);
    return runTiledBlur(this.#device, this.#pipeline, input, SURFACE_BLUR_PARAMS_BYTES, (origin) =>
      surfaceParamsBytes(width, height, origin, params.radius, slope),
    );
  }
}

/**
 * Sketch Blur (FX-BLUR-SKETCH) on WebGPU. The shader is the WGSL twin of `sketch_blur_rgba8`. The scan
 * offsets and the P² constants come from the same Rust functions as the reference, through `sketchBlurPlan`,
 * so both backends read one set of numbers.
 */
export class GpuSketchBlur {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "sketch blur", code: SKETCH_BLUR_WGSL });
    this.#pipeline = device.createComputePipeline({
      label: "sketch blur",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the blurred `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: SketchBlurParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    const plan = sketchBlurPlan(params);
    return runTiledBlur(
      this.#device,
      this.#pipeline,
      input,
      SKETCH_BLUR_PARAMS_BYTES,
      (origin) => sketchParamsBytes(width, height, origin, params.smoothness, plan),
      plan.offsets,
    );
  }
}

/**
 * Runs a neighborhood blur over the image, one tile per dispatch. The shaders bind the `Params`
 * uniform at 0, the source at 1 and the output at 2. A shader that reads a scan table (Sketch Blur) also
 * binds `scan` at 3 (Sketch Blur's offsets and Add Noise's deviate table). `uniformAt` gives each tile's
 * uniform, and the tile's origin is in it. Each tile is
 * submitted and awaited before the next, so the GPU never holds a long submission. Returns the output as
 * straight RGBA8.
 */
export async function runTiledBlur(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  input: Surface,
  uniformBytes: number,
  uniformAt: (origin: { x: number; y: number }) => ArrayBuffer,
  scan?: Int32Array,
): Promise<Surface> {
  const { width, height } = input;
  const bytes = width * height * RGBA8_BYTES_PER_PIXEL;
  const source = device.createBuffer({
    label: "source",
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
  const params = device.createBuffer({
    label: "params",
    size: uniformBytes,
    usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
  });
  const scanBuffer = scan
    ? device.createBuffer({
        label: "scan",
        size: scan.byteLength,
        usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
      })
    : undefined;
  try {
    device.queue.writeBuffer(source, 0, input.data);
    if (scan && scanBuffer) device.queue.writeBuffer(scanBuffer, 0, scan);
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: { buffer: source } },
      { binding: 2, resource: { buffer: output } },
    ];
    if (scanBuffer) entries.push({ binding: 3, resource: { buffer: scanBuffer } });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    });
    for (let y = 0; y < height; y += NEIGHBORHOOD_TILE_PIXELS) {
      for (let x = 0; x < width; x += NEIGHBORHOOD_TILE_PIXELS) {
        const tileWidth = Math.min(NEIGHBORHOOD_TILE_PIXELS, width - x);
        const tileHeight = Math.min(NEIGHBORHOOD_TILE_PIXELS, height - y);
        device.queue.writeBuffer(params, 0, uniformAt({ x, y }));
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(
          Math.ceil(tileWidth / WORKGROUP_SIZE),
          Math.ceil(tileHeight / WORKGROUP_SIZE),
        );
        pass.end();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
      }
    }
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(MAP_READ_MODE);
    const pixels = new Uint8ClampedArray(readback.getMappedRange().slice(0));
    readback.unmap();
    return new Surface(width, height, pixels);
  } finally {
    for (const created of [source, output, readback, params, scanBuffer]) created?.destroy();
  }
}

/** Encodes a `Params` uniform of little-endian u32 words, matching the WGSL struct layout. */
function paramsBytes(size: number, words: readonly number[]): ArrayBuffer {
  const bytes = new ArrayBuffer(size);
  const view = new DataView(bytes);
  for (const [index, word] of words.entries()) view.setUint32(index * 4, word, true);
  return bytes;
}

/**
 * Encodes the Surface Blur `Params`: the image size, tile origin and radius as u32, then the weight
 * slope as f32 at byte 20, matching the WGSL struct layout.
 */
function surfaceParamsBytes(
  width: number,
  height: number,
  origin: { x: number; y: number },
  radius: number,
  slope: number,
): ArrayBuffer {
  const bytes = new ArrayBuffer(SURFACE_BLUR_PARAMS_BYTES);
  const view = new DataView(bytes);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, origin.x, true);
  view.setUint32(12, origin.y, true);
  view.setUint32(16, radius, true);
  view.setFloat32(20, slope, true);
  return bytes;
}

/**
 * Encodes the Sketch Blur `Params` (see `SKETCH_BLUR_WGSL`): the image size, tile origin, iteration count
 * and the sample that seeds the first iteration as u32, then the five initial marker positions and the five
 * increments as f32 from byte 32, matching the WGSL struct layout.
 */
function sketchParamsBytes(
  width: number,
  height: number,
  origin: { x: number; y: number },
  iterations: number,
  plan: SketchBlurPlan,
): ArrayBuffer {
  const bytes = new ArrayBuffer(SKETCH_BLUR_PARAMS_BYTES);
  const view = new DataView(bytes);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, origin.x, true);
  view.setUint32(12, origin.y, true);
  view.setUint32(16, iterations, true);
  view.setUint32(20, plan.rank, true);
  for (const [index, value] of plan.markers.entries()) view.setInt32(32 + index * 4, value, true);
  return bytes;
}
