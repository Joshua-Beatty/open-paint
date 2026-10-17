/** Bytes of the `Params` uniform of the Morphology shaders. */
export const MORPHOLOGY_PARAMS_BYTES = 32;

/**
 * WGSL twin of `morphology_rgba8` in `crates/opaint-cpu/src/morphology.rs` (FX-DIST-MORPH-03), in two
 * entry points. `horizontal` writes each pixel's premultiplied window extremum along its row into
 * the scratch buffer, and `vertical` takes the extremum of those down each column, then writes
 * straight-alpha RGBA8. Dispatch the two in order, in separate compute passes.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the scratch as
 * premultiplied `vec4<f32>` per pixel, 3 the output as packed RGBA8 `u32` words. Min and max are
 * exact, so this reads each window directly and still matches the Rust block extrema bit for bit.
 */
export const MORPHOLOGY_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  kernel_width: u32,
  kernel_height: u32,
  dilate: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> scratch: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

fn unpack_source(word: u32) -> vec4<f32> {
  let alpha = f32(word >> 24u) / 255.0;
  return vec4<f32>(
    f32(word & 0xffu) / 255.0 * alpha,
    f32((word >> 8u) & 0xffu) / 255.0 * alpha,
    f32((word >> 16u) & 0xffu) / 255.0 * alpha,
    alpha,
  );
}

fn combine(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  if (params.dilate == 1u) {
    return max(a, b);
  }
  return min(a, b);
}

fn to_byte(value: f32) -> u32 {
  return u32(clamp(floor(value * 255.0 + 0.5), 0.0, 255.0));
}

fn straight_channel(channel: f32, alpha: f32) -> f32 {
  if (alpha > 0.0) {
    return clamp(channel / alpha, 0.0, 1.0);
  }
  return 0.0;
}

@compute @workgroup_size(8, 8)
fn horizontal(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  let last = i32(params.width) - 1;
  let start = i32(id.x) - i32(params.kernel_width);
  let row = id.y * params.width;
  let span = i32(2u * params.kernel_width);
  var acc = unpack_source(src[row + u32(clamp(start, 0, last))]);
  for (var k = 1; k < span; k = k + 1) {
    acc = combine(acc, unpack_source(src[row + u32(clamp(start + k, 0, last))]));
  }
  scratch[row + id.x] = acc;
}

@compute @workgroup_size(8, 8)
fn vertical(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  let last = i32(params.height) - 1;
  let start = i32(id.y) - i32(params.kernel_height);
  let span = i32(2u * params.kernel_height);
  var acc = scratch[u32(clamp(start, 0, last)) * params.width + id.x];
  for (var k = 1; k < span; k = k + 1) {
    acc = combine(acc, scratch[u32(clamp(start + k, 0, last)) * params.width + id.x]);
  }
  let alpha = clamp(acc.w, 0.0, 1.0);
  dst[id.y * params.width + id.x] = to_byte(straight_channel(acc.x, alpha))
    | (to_byte(straight_channel(acc.y, alpha)) << 8u)
    | (to_byte(straight_channel(acc.z, alpha)) << 16u)
    | (to_byte(alpha) << 24u);
}
`;
