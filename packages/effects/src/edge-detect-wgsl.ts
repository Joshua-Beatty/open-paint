import { ARTISTIC_HELPERS_WGSL, ARTISTIC_PARAMS_WGSL } from "./artistic-wgsl-common";

/**
 * WGSL twin of `stylize::edge_detect_rgba8` (FX-STYL-EDGE). The stages are the entry points, run in
 * order: `premultiply` writes the premultiplied RGB into `plane_a`, `blur_h` and `blur_v` ping-pong
 * the clamped Gaussian through `plane_b` (only when Blurring > 0), and `edge` writes the packed
 * output. `f0` is the edge gain, `i0` the blur radius and `u0` the flags (bit 0 Prewitt, bit 1
 * overlay), all from the Rust plan. `weights` holds the blur kernel.
 */
export const EDGE_DETECT_WGSL = /* wgsl */ `
${ARTISTIC_PARAMS_WGSL}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> plane_a: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> plane_b: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> weights: array<f32>;
@group(0) @binding(5) var<storage, read_write> dst: array<u32>;

${ARTISTIC_HELPERS_WGSL}

fn clamp_x(x: i32) -> u32 {
  return u32(clamp(x, 0, i32(p.width) - 1));
}

fn clamp_y(y: i32) -> u32 {
  return u32(clamp(y, 0, i32(p.height) - 1));
}

fn sample_plane(x: i32, y: i32) -> vec3<f32> {
  return plane_a[clamp_y(y) * p.width + clamp_x(x)].xyz;
}

/** The entry of the x kernel at (row, col): [-1 0 1; -2 0 2; -1 0 1] for Sobel, Prewitt without the 2. */
fn kernel_x(row: i32, col: i32) -> f32 {
  var col_weight = 0.0;
  if (col == 0) {
    col_weight = -1.0;
  } else if (col == 2) {
    col_weight = 1.0;
  }
  var row_weight = 1.0;
  if ((p.u0 & 1u) == 0u && row == 1) {
    row_weight = 2.0;
  }
  return col_weight * row_weight;
}

fn magnitude(x: i32, y: i32, c: u32) -> f32 {
  var gx = 0.0;
  var gy = 0.0;
  for (var row = 0; row < 3; row++) {
    for (var col = 0; col < 3; col++) {
      let v = sample_plane(x + col - 1, y + row - 1)[c];
      gx = gx + kernel_x(row, col) * v;
      gy = gy + kernel_x(col, row) * v;
    }
  }
  return sqrt(gx * gx + gy * gy);
}

@compute @workgroup_size(8, 8)
fn premultiply(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let s = src[i];
  let a = channel(s, 3u);
  plane_a[i] = vec4<f32>(channel(s, 0u) * a, channel(s, 1u) * a, channel(s, 2u) * a, 0.0);
}

@compute @workgroup_size(8, 8)
fn blur_h(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  var acc = vec4<f32>(0.0);
  let taps = 2 * p.i0 + 1;
  for (var k = 0; k < taps; k++) {
    let sx = clamp_x(i32(id.x) + k - p.i0);
    acc = acc + weights[u32(k)] * plane_a[id.y * p.width + sx];
  }
  plane_b[id.y * p.width + id.x] = acc;
}

@compute @workgroup_size(8, 8)
fn blur_v(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  var acc = vec4<f32>(0.0);
  let taps = 2 * p.i0 + 1;
  for (var k = 0; k < taps; k++) {
    let sy = clamp_y(i32(id.y) + k - p.i0);
    acc = acc + weights[u32(k)] * plane_b[sy * p.width + id.x];
  }
  plane_a[id.y * p.width + id.x] = acc;
}

@compute @workgroup_size(8, 8)
fn edge(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let s = src[i];
  let alpha = channel(s, 3u);
  let x = i32(id.x);
  let y = i32(id.y);
  let e = vec3<f32>(
    clamp(magnitude(x, y, 0u) * p.f0, 0.0, 1.0),
    clamp(magnitude(x, y, 1u) * p.f0, 0.0, 1.0),
    clamp(magnitude(x, y, 2u) * p.f0, 0.0, 1.0),
  );
  if ((p.u0 & 2u) == 0u) {
    dst[i] = pack_rgba(to_u8(e.x), to_u8(e.y), to_u8(e.z), s >> 24u);
    return;
  }
  let edge_alpha = max(max(e.x, e.y), e.z);
  let out_alpha = edge_alpha + alpha * (1.0 - edge_alpha);
  let original = vec3<f32>(channel(s, 0u) * alpha, channel(s, 1u) * alpha, channel(s, 2u) * alpha);
  let premult = e * edge_alpha + original * (1.0 - edge_alpha);
  var straight = vec3<f32>(0.0);
  if (out_alpha > 0.0) {
    straight = premult / out_alpha;
  }
  dst[i] = pack_rgba(to_u8(straight.x), to_u8(straight.y), to_u8(straight.z), to_u8(out_alpha));
}
`;
