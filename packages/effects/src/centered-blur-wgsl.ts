/**
 * The bindings and helpers shared by the Radial Blur and Zoom Blur shaders. Each shader appends its
 * `main` entry point. The sampling matches the bilinear sampler of `crates/opaint-cpu/src/distort.rs`:
 * Radial Blur reads the premultiplied source with the Transparent edge and the coverage of its taps,
 * Zoom Blur reads it with the Clamp edge.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the plan as
 * `vec2<f32>` pairs, 3 the output as packed RGBA8 `u32` words. `Params` holds the image size, the
 * number of plan pairs, and the center in pixels. Each `vec2` sits at an 8-byte boundary.
 */
export const CENTERED_BLUR_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  count: u32,
  pad0: u32,
  center: vec2<f32>,
  pad1: vec2<f32>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> plan: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

fn unpack_texel(index: u32) -> vec4<f32> {
  let word = src[index];
  let alpha = f32(word >> 24u) / 255.0;
  return vec4<f32>(
    f32(word & 0xffu) / 255.0 * alpha,
    f32((word >> 8u) & 0xffu) / 255.0 * alpha,
    f32((word >> 16u) & 0xffu) / 255.0 * alpha,
    alpha,
  );
}

fn inside(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(params.width) && y < i32(params.height);
}

fn tap(x: i32, y: i32) -> vec4<f32> {
  if (!inside(x, y)) {
    return vec4<f32>(0.0);
  }
  return unpack_texel(u32(y) * params.width + u32(x));
}

fn clamped_tap(x: i32, y: i32) -> vec4<f32> {
  let cx = clamp(x, 0, i32(params.width) - 1);
  let cy = clamp(y, 0, i32(params.height) - 1);
  return unpack_texel(u32(cy) * params.width + u32(cx));
}

fn inside_weight(x: i32, y: i32, weight: f32) -> f32 {
  if (inside(x, y)) {
    return weight;
  }
  return 0.0;
}

fn sample_texel(s: vec2<f32>) -> vec4<f32> {
  let u = s - vec2<f32>(0.5);
  let base = floor(u);
  let t = u - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);
  return tap(x0, y0) * ((1.0 - t.x) * (1.0 - t.y))
    + tap(x0 + 1, y0) * (t.x * (1.0 - t.y))
    + tap(x0, y0 + 1) * ((1.0 - t.x) * t.y)
    + tap(x0 + 1, y0 + 1) * (t.x * t.y);
}

fn sample_clamped(s: vec2<f32>) -> vec4<f32> {
  let u = s - vec2<f32>(0.5);
  let base = floor(u);
  let t = u - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);
  return clamped_tap(x0, y0) * ((1.0 - t.x) * (1.0 - t.y))
    + clamped_tap(x0 + 1, y0) * (t.x * (1.0 - t.y))
    + clamped_tap(x0, y0 + 1) * ((1.0 - t.x) * t.y)
    + clamped_tap(x0 + 1, y0 + 1) * (t.x * t.y);
}

fn sample_coverage(s: vec2<f32>) -> f32 {
  let u = s - vec2<f32>(0.5);
  let base = floor(u);
  let t = u - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);
  return inside_weight(x0, y0, (1.0 - t.x) * (1.0 - t.y))
    + inside_weight(x0 + 1, y0, t.x * (1.0 - t.y))
    + inside_weight(x0, y0 + 1, (1.0 - t.x) * t.y)
    + inside_weight(x0 + 1, y0 + 1, t.x * t.y);
}

fn straight_channel(channel: f32, alpha: f32) -> f32 {
  if (alpha > 0.0) {
    return clamp(channel / alpha, 0.0, 1.0);
  }
  return 0.0;
}

fn to_byte(value: f32) -> u32 {
  return u32(clamp(floor(value * 255.0 + 0.5), 0.0, 255.0));
}

fn pack_straight(avg: vec4<f32>) -> u32 {
  let alpha = clamp(avg.w, 0.0, 1.0);
  return to_byte(straight_channel(avg.x, alpha))
    | (to_byte(straight_channel(avg.y, alpha)) << 8u)
    | (to_byte(straight_channel(avg.z, alpha)) << 16u)
    | (to_byte(alpha) << 24u);
}
`;
