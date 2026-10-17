import { Surface } from "@openpaint/document";
import {
  DISTORTION_MAP_FLOATS,
  DISTORTION_PARAMS_BYTES,
  distortionWgsl,
  type EdgeBehavior,
  edgeBehaviorCode,
  planDistortionOffsets,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";
import { readBack } from "./gpu-pool";

const WORKGROUP_SIZE = 8;
const RGBA8_BYTES_PER_PIXEL = 4;

/** The per-dispatch parameters of one distortion run. */
export interface GpuDistortionParams {
  /** Quality 1-8: the engine samples `quality²` rotated-grid offsets per pixel. */
  readonly quality: number;
  readonly edge: EdgeBehavior;
  /** The sample map's parameters (`params.map`), at most `DISTORTION_MAP_FLOATS` values. */
  readonly mapParams: readonly number[];
}

/**
 * The distortion engine on WebGPU (FX-A-00-04) for one sample map. The shader is the WGSL twin of
 * `crates/opaint-cpu/src/distort.rs`, so the same map gives the same pixels on both backends.
 * Build one runner per sample map: each run binds parameters and never rebuilds the pipeline
 * (FX-A-00-02c). Requires the WASM kernels to be initialized, for the rotated-grid offsets.
 */
export class GpuDistortion {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice, sampleMapWgsl: string) {
    this.#device = device;
    const module = device.createShaderModule({
      label: "distortion",
      code: distortionWgsl(sampleMapWgsl),
    });
    this.#pipeline = device.createComputePipeline({
      label: "distortion",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
  }

  /** Returns the distorted `input` as a new surface, with straight alpha. */
  async run(input: Surface, params: GpuDistortionParams): Promise<Surface> {
    const { width, height } = input;
    if (width === 0 || height === 0) return new Surface(width, height);
    if (params.mapParams.length > DISTORTION_MAP_FLOATS) {
      throw new RangeError(`A sample map takes at most ${DISTORTION_MAP_FLOATS} parameters.`);
    }

    const device = this.#device;
    const pixels = width * height;
    const offsets = planDistortionOffsets(params.quality);
    const samples = offsets.length / 2;
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
    const offsetBuffer = buffer(
      "offsets",
      offsets.byteLength,
      BufferUsage.STORAGE | BufferUsage.COPY_DST,
    );
    const output = buffer(
      "output",
      pixels * RGBA8_BYTES_PER_PIXEL,
      BufferUsage.STORAGE | BufferUsage.COPY_SRC,
    );
    const uniform = buffer(
      "params",
      DISTORTION_PARAMS_BYTES,
      BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    );
    device.queue.writeBuffer(source, 0, input.data);
    device.queue.writeBuffer(offsetBuffer, 0, offsets);
    device.queue.writeBuffer(uniform, 0, paramsBytes(width, height, samples, params));

    const layout = this.#pipeline.getBindGroupLayout(0);
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: source } },
        { binding: 2, resource: { buffer: offsetBuffer } },
        { binding: 3, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
    pass.end();
    const bytes = await readBack(device, encoder, output, pixels * RGBA8_BYTES_PER_PIXEL);
    for (const created of buffers) created.destroy();
    return new Surface(width, height, bytes);
  }
}

/** Encodes the `Params` uniform (little-endian, matching the WGSL struct layout). */
function paramsBytes(
  width: number,
  height: number,
  samples: number,
  params: GpuDistortionParams,
): ArrayBuffer {
  const bytes = new ArrayBuffer(DISTORTION_PARAMS_BYTES);
  const view = new DataView(bytes);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, samples, true);
  view.setUint32(12, edgeBehaviorCode(params.edge), true);
  const map = new Float32Array(bytes, 16, DISTORTION_MAP_FLOATS);
  map.set(params.mapParams);
  return bytes;
}
