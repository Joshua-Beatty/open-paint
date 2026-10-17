import { Surface } from "@openpaint/document";
import { BufferUsage } from "./gpu-device";
import { readBack } from "./gpu-pool";

/**
 * The sampling functions of `TRANSFORM_WGSL`, shared with the floating preview: they read the
 * packed RGBA8 source `src` of `p.src_w` x `p.src_h` pixels, with `p.linear_light`, and the
 * footprint grid `p.grid_x` x `p.grid_y`.
 */
export const TRANSFORM_SAMPLING_WGSL = /* wgsl */ `
fn to_linear(v: f32) -> f32 {
  if (v <= 0.04045) {
    return v / 12.92;
  }
  return pow((v + 0.055) / 1.055, 2.4);
}

fn to_srgb(v: f32) -> f32 {
  if (v <= 0.0031308) {
    return v * 12.92;
  }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

fn texel(x: i32, y: i32) -> vec4<f32> {
  if (x < 0 || y < 0 || x >= i32(p.src_w) || y >= i32(p.src_h)) {
    return vec4<f32>(0.0);
  }
  let word = src[u32(y) * p.src_w + u32(x)];
  let a8 = (word >> 24u) & 255u;
  if (a8 == 0u) {
    return vec4<f32>(0.0);
  }
  let alpha = f32(a8) / 255.0;
  var rgb = vec3<f32>(f32(word & 255u), f32((word >> 8u) & 255u), f32((word >> 16u) & 255u)) / 255.0;
  if (p.linear_light == 1u) {
    rgb = vec3<f32>(to_linear(rgb.x), to_linear(rgb.y), to_linear(rgb.z));
  }
  return vec4<f32>(rgb * alpha, alpha);
}

fn nearest(at: vec2<f32>) -> vec4<f32> {
  return texel(i32(floor(at.x)), i32(floor(at.y)));
}

fn bilinear(at: vec2<f32>) -> vec4<f32> {
  let f = at - vec2<f32>(0.5);
  let o = floor(f);
  let t = f - o;
  let x0 = i32(o.x);
  let y0 = i32(o.y);
  var out = vec4<f32>(0.0);
  out = out + texel(x0, y0) * ((1.0 - t.x) * (1.0 - t.y));
  out = out + texel(x0 + 1, y0) * (t.x * (1.0 - t.y));
  out = out + texel(x0, y0 + 1) * ((1.0 - t.x) * t.y);
  out = out + texel(x0 + 1, y0 + 1) * (t.x * t.y);
  return out;
}

fn catmull_rom(t: f32) -> vec4<f32> {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4<f32>(
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2,
  );
}

fn cubic(at: vec2<f32>) -> vec4<f32> {
  let f = at - vec2<f32>(0.5);
  let o = floor(f);
  let wx = catmull_rom(f.x - o.x);
  let wy = catmull_rom(f.y - o.y);
  let x0 = i32(o.x);
  let y0 = i32(o.y);
  var out = vec4<f32>(0.0);
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      out = out + texel(x0 - 1 + i, y0 - 1 + j) * (wx[i] * wy[j]);
    }
  }
  if (out.w <= 0.0) {
    return vec4<f32>(0.0);
  }
  if (out.w > 1.0) {
    out = out / out.w;
  }
  let alpha = out.w;
  return vec4<f32>(clamp(out.xyz, vec3<f32>(0.0), vec3<f32>(alpha)), alpha);
}

fn footprint(center: vec2<f32>, v1: vec2<f32>, v2: vec2<f32>) -> vec4<f32> {
  var sum = vec4<f32>(0.0);
  for (var j = 0u; j < p.grid_y; j++) {
    let t2 = (f32(j) + 0.5) / f32(p.grid_y) - 0.5;
    for (var i = 0u; i < p.grid_x; i++) {
      let t1 = (f32(i) + 0.5) / f32(p.grid_x) - 0.5;
      sum = sum + bilinear(center + t1 * v1 + t2 * v2);
    }
  }
  return sum / f32(p.grid_x * p.grid_y);
}

fn to_u8(v: f32) -> u32 {
  return u32(clamp(floor(v * 255.0 + 0.5), 0.0, 255.0));
}

fn encode(color: vec4<f32>) -> u32 {
  let alpha = clamp(color.w, 0.0, 1.0);
  if (alpha <= 0.0) {
    return 0u;
  }
  var rgb = clamp(color.xyz / alpha, vec3<f32>(0.0), vec3<f32>(1.0));
  if (p.linear_light == 1u) {
    rgb = vec3<f32>(to_srgb(rgb.x), to_srgb(rgb.y), to_srgb(rgb.z));
  }
  return to_u8(rgb.x) | (to_u8(rgb.y) << 8u) | (to_u8(rgb.z) << 16u) | (to_u8(alpha) << 24u);
}
`;

/**
 * WGSL twin of `crates/opaint-cpu/src/transform.rs` (TL-MOVE-PIX-01, TL-OPT-RESAMP, TL-OPT-GAMMA):
 * each destination pixel maps back through the inverse transform and mixes premultiplied source
 * pixels (in linear light when asked) with the chosen filter, in the reference's order. Source
 * coordinates are f32 here and f64 in the reference, so the results agree within ±1 per channel,
 * except that Nearest Neighbor can pick the neighbor of a sample that falls within about 1e-3 px
 * of a pixel edge.
 */
export const TRANSFORM_WGSL = /* wgsl */ `
struct Params {
  src_w: u32,
  src_h: u32,
  dst_w: u32,
  dst_h: u32,
  sampling: u32,
  linear_light: u32,
  grid_x: u32,
  grid_y: u32,
  a: f32,
  b: f32,
  c: f32,
  d: f32,
  e: f32,
  f: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

${TRANSFORM_SAMPLING_WGSL}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.dst_w || id.y >= p.dst_h) {
    return;
  }
  let cx = f32(id.x) + 0.5;
  let cy = f32(id.y) + 0.5;
  let center = vec2<f32>(p.a * cx + p.c * cy + p.e, p.b * cx + p.d * cy + p.f);
  var color: vec4<f32>;
  switch (p.sampling) {
    case 0u: {
      color = nearest(center);
    }
    case 4u: {
      color = cubic(center);
    }
    case 1u: {
      color = bilinear(center);
    }
    default: {
      color = footprint(center, vec2<f32>(p.a, p.b), vec2<f32>(p.c, p.d));
    }
  }
  dst[id.y * p.dst_w + id.x] = encode(color);
}
`;

/** Samples per footprint axis of Multisample Bilinear, as in the reference. */
const MULTISAMPLE_GRID = 4;
/** The most samples per footprint axis of Anisotropic sampling, as in the reference. */
const MAX_ANISOTROPIC_AXIS = 16;
const PARAMS_BYTES = 64;
const WORKGROUP_SIZE = 8;
const RGBA8_BYTES_PER_PIXEL = 4;

/**
 * One resampling: the destination size, the inverse transform `a, b, c, d, e, f` from destination
 * pixel centers to source coordinates, and the TL-OPT-RESAMP sampling id (the order of
 * `TRANSFORM_SAMPLINGS`).
 */
export interface GpuTransformSpec {
  readonly width: number;
  readonly height: number;
  readonly inverse: readonly number[];
  readonly sampling: number;
  readonly linearLight: boolean;
}

/** The footprint grid of the reference: computed in f64 on the CPU, so both use the same counts. */
export function footprintGrid(
  spec: Pick<GpuTransformSpec, "inverse" | "sampling">,
): readonly [number, number] {
  const [a = 0, b = 0, c = 0, d = 0] = spec.inverse;
  if (spec.sampling === 2) return [MULTISAMPLE_GRID, MULTISAMPLE_GRID];
  if (spec.sampling !== 3) return [1, 1];
  const axis = (x: number, y: number) =>
    Math.min(MAX_ANISOTROPIC_AXIS, Math.max(1, Math.ceil(Math.hypot(x, y))));
  return [axis(a, b), axis(c, d)];
}

/**
 * Affine resampling for Move Selected Pixels on WebGPU: the WGSL twin of `transform_rgba8`. The
 * source goes up as packed RGBA8 words and the result comes back the same way.
 */
export class GpuTransform {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#pipeline = device.createComputePipeline({
      label: "transform",
      layout: "auto",
      compute: {
        module: device.createShaderModule({ label: "transform", code: TRANSFORM_WGSL }),
        entryPoint: "main",
      },
    });
  }

  async run(input: Surface, spec: GpuTransformSpec): Promise<Surface> {
    const { width, height } = spec;
    if (width === 0 || height === 0) return new Surface(width, height);
    const device = this.#device;
    const [gridX, gridY] = footprintGrid(spec);
    const uniform = new DataView(new ArrayBuffer(PARAMS_BYTES));
    const words = [input.width, input.height, width, height, spec.sampling];
    words.push(spec.linearLight ? 1 : 0, gridX, gridY);
    for (const [index, value] of words.entries()) uniform.setUint32(index * 4, value, true);
    for (const [index, value] of spec.inverse.entries()) {
      uniform.setFloat32(32 + index * 4, value, true);
    }
    const bytes = width * height * RGBA8_BYTES_PER_PIXEL;
    const params = device.createBuffer({
      label: "transform params",
      size: PARAMS_BYTES,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    });
    const source = device.createBuffer({
      label: "transform source",
      size: Math.max(4, input.data.byteLength),
      usage: BufferUsage.STORAGE | BufferUsage.COPY_DST,
    });
    const output = device.createBuffer({
      label: "transform output",
      size: bytes,
      usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC,
    });
    device.queue.writeBuffer(params, 0, uniform.buffer);
    if (input.data.byteLength > 0) device.queue.writeBuffer(source, 0, input.data);
    const encoder = device.createCommandEncoder({ label: "transform" });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: source } },
          { binding: 2, resource: { buffer: output } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
    pass.end();
    const pixels = await readBack(device, encoder, output, bytes);
    for (const buffer of [params, source, output]) buffer.destroy();
    return new Surface(width, height, pixels);
  }
}
