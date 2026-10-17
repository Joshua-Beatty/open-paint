import { Surface } from "@openpaint/document";
import {
  ADJUSTMENTS_WGSL,
  type AdjustmentPlan,
  BLUR_WEIGHTS,
  CURVE_LUT_SIZE,
  CURVE_TABLES,
  HIGHLIGHTS_SHADOWS_OP,
} from "@openpaint/effects";
import { BufferUsage } from "./gpu-device";
import { readBack } from "./gpu-pool";

/** Pixels per workgroup; must match `@workgroup_size` in `ADJUSTMENTS_WGSL`. */
const WORKGROUP_SIZE = 256;
/** The most workgroups one dimension may dispatch (WebGPU's default limit). */
const MAX_DISPATCH_DIMENSION = 65535;
/** Offset of the linear-light gains in the shader's `Params` uniform, after the fixed fields. */
const GAINS_OFFSET = 160;
/** Offset of the Highlights / Shadows / Clarity values and the blur radius in taps. */
const TONE_OFFSET = 176;
/** Offset of the blur weights, `BLUR_WEIGHTS` floats in vec4 groups. */
const WEIGHTS_OFFSET = 192;
/** Offset of the Curves tables in the shader's `Params` uniform, after the blur weights. */
const CURVES_OFFSET = WEIGHTS_OFFSET + BLUR_WEIGHTS * 4;
/** Bytes of the shader's `AdjustParams` uniform: the fixed fields, then the Curves tables. */
export const PARAMS_BYTES = CURVES_OFFSET + CURVE_TABLES * CURVE_LUT_SIZE * 4;
/** Bytes per pixel of the packed RGBA8 buffer. */
const PIXEL_BYTES = 4;
/** Bytes per value of the f32 scratch buffers of the blur. */
const FLOAT_BYTES = 4;

/** A buffer bound at one slot of the entry point's bind group. */
interface Binding {
  readonly binding: number;
  readonly buffer: GPUBuffer;
}

/**
 * The point adjustments, the Curves tables and the local Highlights / Shadows on WebGPU. The
 * pixels go up as packed RGBA8 words, one invocation each, and come back the same way. Highlights
 * / Shadows first blurs the luma in two passes, horizontal then vertical, and the tone pass reads
 * the result. Each call owns its buffers, so a parameter change writes a new uniform and never
 * rebuilds the pipelines (FX-A-00-02c).
 */
export class GpuAdjustment {
  readonly #device: GPUDevice;
  readonly #adjust: GPUComputePipeline;
  readonly #blurHorizontal: GPUComputePipeline;
  readonly #blurVertical: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    const module = device.createShaderModule({ label: "adjustments", code: ADJUSTMENTS_WGSL });
    const pipeline = (entryPoint: string) =>
      device.createComputePipeline({
        label: entryPoint,
        layout: "auto",
        compute: { module, entryPoint },
      });
    this.#adjust = pipeline("adjust");
    this.#blurHorizontal = pipeline("luma_blur_horizontal");
    this.#blurVertical = pipeline("luma_blur_vertical");
  }

  /** Returns the adjusted `input` as a new surface. Alpha and transparent colors follow the reference. */
  async run(input: Surface, plan: AdjustmentPlan): Promise<Surface> {
    const { width, height } = input;
    const count = width * height;
    if (count === 0) return new Surface(width, height);

    const device = this.#device;
    const bytes = count * PIXEL_BYTES;
    const groups = Math.ceil(count / WORKGROUP_SIZE);
    const groupsX = Math.min(groups, MAX_DISPATCH_DIMENSION);
    const groupsY = Math.ceil(groups / groupsX);
    const blurs = plan.op === HIGHLIGHTS_SHADOWS_OP;

    const pixels = device.createBuffer({
      label: "adjustment pixels",
      size: bytes,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
    });
    const uniform = device.createBuffer({
      label: "adjustment params",
      size: PARAMS_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    const scratch = blurs ? count * FLOAT_BYTES : FLOAT_BYTES;
    const horizontal = device.createBuffer({
      label: "luma horizontal blur",
      size: scratch,
      usage: BufferUsage.STORAGE,
    });
    const blurred = device.createBuffer({
      label: "luma blur",
      size: scratch,
      usage: BufferUsage.STORAGE,
    });
    device.queue.writeBuffer(pixels, 0, input.data);
    device.queue.writeBuffer(uniform, 0, paramsBytes(count, groupsX * WORKGROUP_SIZE, width, plan));

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    const dispatch = (pipeline: GPUComputePipeline, buffers: readonly Binding[]): void => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            ...buffers.map(({ binding, buffer }) => ({ binding, resource: { buffer } })),
          ],
        }),
      );
      pass.dispatchWorkgroups(groupsX, groupsY);
    };
    if (blurs) {
      dispatch(this.#blurHorizontal, [
        { binding: 1, buffer: pixels },
        { binding: 2, buffer: horizontal },
      ]);
      dispatch(this.#blurVertical, [
        { binding: 2, buffer: horizontal },
        { binding: 3, buffer: blurred },
      ]);
    }
    dispatch(this.#adjust, [
      { binding: 1, buffer: pixels },
      { binding: 3, buffer: blurred },
    ]);
    pass.end();
    const out = await readBack(device, encoder, pixels, bytes);
    for (const buffer of [pixels, uniform, horizontal, blurred]) buffer.destroy();
    return new Surface(width, height, out);
  }
}

/**
 * Encodes the `AdjustParams` uniform (little-endian, matching the WGSL struct layout). Each vec4
 * holds one value per channel, or the shift, multiplier and divisor of Brightness / Contrast. The
 * engine v2 compositor encodes its live filter with it, with no pixel buffer (`count` 0).
 */
export function paramsBytes(
  count: number,
  rowStride: number,
  width: number,
  plan: AdjustmentPlan,
): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(PARAMS_BYTES));
  view.setUint32(0, count, true);
  view.setUint32(4, rowStride, true);
  view.setUint32(8, plan.op, true);
  view.setUint32(12, width, true);
  writeVec4(view, 16, plan.exponents);
  writeVec4(view, 32, perChannel(plan.levels, 0));
  writeVec4(view, 48, perChannel(plan.levels, 1));
  writeVec4(view, 64, perChannel(plan.levels, 2));
  writeVec4(view, 80, perChannel(plan.levels, 3));
  writeVec4(view, 96, perChannel(plan.levels, 4));
  writeVec4(view, 112, plan.brightnessContrast);
  writeVec4(view, 128, plan.hueSaturation);
  writeVec4(view, 144, plan.posterize);
  writeVec4(view, GAINS_OFFSET, plan.gains);
  writeVec4(view, TONE_OFFSET, plan.tone);
  for (let vec = 0; vec < BLUR_WEIGHTS / 4; vec++) {
    writeVec4(view, WEIGHTS_OFFSET + vec * 16, plan.weights.subarray(vec * 4, vec * 4 + 4));
  }
  for (let vec = 0; vec < (CURVE_TABLES * CURVE_LUT_SIZE) / 4; vec++) {
    writeVec4(view, CURVES_OFFSET + vec * 16, plan.curves.subarray(vec * 4, vec * 4 + 4));
  }
  return view.buffer;
}

/** Writes up to three values and zero-fills the fourth lane. */
function writeVec4(view: DataView, offset: number, values: ArrayLike<number>): void {
  for (let lane = 0; lane < 4; lane++) {
    view.setFloat32(offset + lane * 4, values[lane] ?? 0, true);
  }
}

/**
 * Takes one field of the R, G, B groups of `levels` as a three-lane list. Each group holds input
 * black, input white, gamma, output black and output white, in that order (`LEVELS_PER_CHANNEL`).
 */
function perChannel(levels: ArrayLike<number>, field: number): number[] {
  return [levels[field] ?? 0, levels[5 + field] ?? 0, levels[10 + field] ?? 0];
}
