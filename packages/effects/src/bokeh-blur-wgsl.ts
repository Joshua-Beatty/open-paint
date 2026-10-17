/**
 * WGSL twin of `crates/opaint-cpu/src/bokeh.rs` (FX-BLUR-BOKEH). The steps match the Rust reference in order: the
 * gamma pipeline, then per complex term a vertical complex pass and a horizontal pass that accumulates the real
 * part, then the output. The weights are read from storage buffers that Rust computes, so both backends sample
 * the same numbers.
 *
 * `Params.first_tap` is the index of the term's first tap in the weight buffers. The accumulator starts at zero
 * (WebGPU zero-initializes buffers), so the first term does not need a clear pass.
 */
export const BOKEH_BLUR_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  radius: i32,
  first_tap: u32,
  exponent: f32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src_u32: array<u32>;
@group(0) @binding(2) var<storage, read> plane_in: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> plane_out: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> v_re: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> v_im: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> acc: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> dst_u32: array<u32>;
@group(0) @binding(8) var<storage, read> vertical: array<vec2<f32>>;
@group(0) @binding(9) var<storage, read> horizontal: array<vec2<f32>>;

fn to_linear(c: f32) -> f32 {
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return pow((c + 0.055) / 1.055, 2.4);
}

fn to_srgb(v: f32) -> f32 {
  if (v <= 0.0031308) {
    return v * 12.92;
  }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

fn pow_nonneg(base: f32, exponent: f32) -> f32 {
  if (base <= 0.0) {
    return 0.0;
  }
  return pow(base, exponent);
}

fn to_u8(v: f32) -> u32 {
  return u32(clamp(floor(v * 255.0 + 0.5), 0.0, 255.0));
}

fn mirror_index(i: i32, n: i32) -> i32 {
  let period = 2 * n;
  var m = i % period;
  if (m < 0) {
    m = m + period;
  }
  if (m >= n) {
    m = period - 1 - m;
  }
  return m;
}

fn unpremultiply(v: f32, a: f32) -> f32 {
  if (a > 0.0) {
    return clamp(v / a, 0.0, 1.0);
  }
  return 0.0;
}

@compute @workgroup_size(8, 8)
fn prepare(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let word = src_u32[i];
  let a = f32((word >> 24u) & 255u) / 255.0;
  let r = pow_nonneg(to_linear(f32(word & 255u) / 255.0), p.exponent) * a;
  let g = pow_nonneg(to_linear(f32((word >> 8u) & 255u) / 255.0), p.exponent) * a;
  let b = pow_nonneg(to_linear(f32((word >> 16u) & 255u) / 255.0), p.exponent) * a;
  plane_out[i] = vec4<f32>(r, g, b, a);
}

@compute @workgroup_size(8, 8)
fn blur_vertical(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  var re = vec4<f32>(0.0);
  var im = vec4<f32>(0.0);
  let taps = 2u * u32(p.radius) + 1u;
  for (var t = 0u; t < taps; t++) {
    let sy = mirror_index(i32(id.y) + i32(t) - p.radius, i32(p.height));
    let w = vertical[p.first_tap + t];
    let s = plane_in[u32(sy) * p.width + id.x];
    re = re + w.x * s;
    im = im + w.y * s;
  }
  let i = id.y * p.width + id.x;
  v_re[i] = re;
  v_im[i] = im;
}

@compute @workgroup_size(8, 8)
fn blur_horizontal(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  var term = vec4<f32>(0.0);
  let taps = 2u * u32(p.radius) + 1u;
  for (var t = 0u; t < taps; t++) {
    let sx = mirror_index(i32(id.x) + i32(t) - p.radius, i32(p.width));
    let w = horizontal[p.first_tap + t];
    let i = id.y * p.width + u32(sx);
    term = term + w.x * v_re[i] - w.y * v_im[i];
  }
  let o = id.y * p.width + id.x;
  acc[o] = acc[o] + term;
}

@compute @workgroup_size(8, 8)
fn finish(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let t = acc[i];
  let a = clamp(t.w, 0.0, 1.0);
  let inv_e = 1.0 / p.exponent;
  let r = to_u8(to_srgb(pow_nonneg(unpremultiply(t.x, a), inv_e)));
  let g = to_u8(to_srgb(pow_nonneg(unpremultiply(t.y, a), inv_e)));
  let b = to_u8(to_srgb(pow_nonneg(unpremultiply(t.z, a), inv_e)));
  dst_u32[i] = r | (g << 8u) | (b << 16u) | (to_u8(a) << 24u);
}
`;

/** Bytes of the shader's `Params` uniform: eight 4-byte fields. */
export const BOKEH_BLUR_PARAMS_BYTES = 32;
