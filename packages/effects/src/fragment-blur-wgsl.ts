/** Bytes of the `Params` uniform of the Fragment Blur shader. */
export const FRAGMENT_BLUR_PARAMS_BYTES = 16;

/**
 * WGSL twin of `fragment_blur_rgba8` in `crates/opaint-cpu/src/directional_blur.rs` (FX-BLUR-FRAG-03).
 * Each pixel sums the premultiplied bilinear samples at the fragment offsets, divides by the coverage
 * of the samples inside the image, and writes straight-alpha RGBA8. The offsets come from
 * `fragment_offsets`, so the shader and the reference read the same numbers.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the offsets as
 * `vec2<f32>` (dx, dy), 3 the output as packed RGBA8 `u32` words.
 */
export const FRAGMENT_BLUR_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  count: u32,
  pad0: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> offsets: array<vec2<f32>>;
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

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  var acc = vec4<f32>(0.0);
  var total = 0.0;
  for (var i = 0u; i < params.count; i = i + 1u) {
    let shift = offsets[i];
    let s = vec2<f32>(f32(id.x) + 0.5 + shift.x, f32(id.y) + 0.5 + shift.y);
    acc = acc + sample_texel(s);
    total = total + sample_coverage(s);
  }
  var word = 0u;
  if (total > 0.0) {
    let avg = acc / total;
    let alpha = clamp(avg.w, 0.0, 1.0);
    word = to_byte(straight_channel(avg.x, alpha))
      | (to_byte(straight_channel(avg.y, alpha)) << 8u)
      | (to_byte(straight_channel(avg.z, alpha)) << 16u)
      | (to_byte(alpha) << 24u);
  }
  dst[id.y * params.width + id.x] = word;
}
`;
