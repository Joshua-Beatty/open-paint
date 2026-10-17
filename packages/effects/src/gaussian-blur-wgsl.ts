/**
 * WGSL twin of `crates/opaint-cpu/src/blur.rs` (FX-BLUR-GAUSS). Every entry point mirrors one step
 * of the Rust pipeline, in the same order, so the GPU result stays within ±1 per channel.
 *
 * Pixels move between passes as `vec4<f32>` (premultiplied, gamma-boosted linear light) in storage
 * buffers. Only the input (`prepare`) and output (`finish`) touch packed RGBA8 `u32` words.
 */
export const GAUSSIAN_BLUR_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  out_width: u32,
  out_height: u32,
  radius: i32,
  exponent: f32,
  scale_factor: f32,
  clamp_edge: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src_u32: array<u32>;
@group(0) @binding(2) var<storage, read> src_f: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> dst_f: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> dst_u32: array<u32>;
@group(0) @binding(5) var<storage, read> weights: array<f32>;

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

fn edge_index(i: i32, n: i32) -> i32 {
  if (p.clamp_edge == 1u) {
    return clamp(i, 0, n - 1);
  }
  return mirror_index(i, n);
}

fn texel(x: i32, y: i32) -> vec4<f32> {
  let cx = clamp(x, 0, i32(p.width) - 1);
  let cy = clamp(y, 0, i32(p.height) - 1);
  return src_f[u32(cy) * p.width + u32(cx)];
}

fn bilinear(sx: f32, sy: f32) -> vec4<f32> {
  let x0 = floor(sx);
  let y0 = floor(sy);
  let tx = sx - x0;
  let ty = sy - y0;
  let ix = i32(x0);
  let iy = i32(y0);
  let p00 = texel(ix, iy);
  let p10 = texel(ix + 1, iy);
  let p01 = texel(ix, iy + 1);
  let p11 = texel(ix + 1, iy + 1);
  let top = p00 + (p10 - p00) * tx;
  let bottom = p01 + (p11 - p01) * tx;
  return top + (bottom - top) * ty;
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
  dst_f[i] = vec4<f32>(r, g, b, a);
}

@compute @workgroup_size(8, 8)
fn resample(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.out_width || id.y >= p.out_height) {
    return;
  }
  let sx = (f32(id.x) + 0.5) * p.scale_factor - 0.5;
  let sy = (f32(id.y) + 0.5) * p.scale_factor - 0.5;
  dst_f[id.y * p.out_width + id.x] = bilinear(sx, sy);
}

@compute @workgroup_size(8, 8)
fn blur_h(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  var acc = vec4<f32>(0.0);
  let taps = 2u * u32(p.radius) + 1u;
  for (var k = 0u; k < taps; k++) {
    let tap = i32(k) - p.radius;
    let sx = edge_index(i32(id.x) + tap, i32(p.width));
    acc = acc + weights[k] * src_f[id.y * p.width + u32(sx)];
  }
  dst_f[id.y * p.width + id.x] = acc;
}

@compute @workgroup_size(8, 8)
fn blur_v(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  var acc = vec4<f32>(0.0);
  let taps = 2u * u32(p.radius) + 1u;
  for (var k = 0u; k < taps; k++) {
    let tap = i32(k) - p.radius;
    let sy = edge_index(i32(id.y) + tap, i32(p.height));
    acc = acc + weights[k] * src_f[u32(sy) * p.width + id.x];
  }
  dst_f[id.y * p.width + id.x] = acc;
}

@compute @workgroup_size(8, 8)
fn finish(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let t = src_f[i];
  let a = clamp(t.w, 0.0, 1.0);
  let inv_e = 1.0 / p.exponent;
  let r = to_u8(to_srgb(pow_nonneg(unpremultiply(t.x, a), inv_e)));
  let g = to_u8(to_srgb(pow_nonneg(unpremultiply(t.y, a), inv_e)));
  let b = to_u8(to_srgb(pow_nonneg(unpremultiply(t.z, a), inv_e)));
  dst_u32[i] = r | (g << 8u) | (b << 16u) | (to_u8(a) << 24u);
}
`;
