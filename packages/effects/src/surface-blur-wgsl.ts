/** Bytes of the `Params` uniform of the Surface Blur shader. */
export const SURFACE_BLUR_PARAMS_BYTES = 32;

/**
 * WGSL twin of `surface_blur_rgba8` in `crates/opaint-cpu/src/neighborhood_blur.rs` (FX-BLUR-SURFACE-03).
 * Each invocation computes one pixel, each channel as the weighted mean of its disc under the
 * mirrored border. `slope` is `surface_slope(Threshold)` from the Rust reference, so both backends use
 * the same k. The GPU runs it once per tile, and `origin` places the tile in the image.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed
 * RGBA8 `u32` words.
 */
export const SURFACE_BLUR_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  origin_x: u32,
  origin_y: u32,
  radius: u32,
  slope: f32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

fn mirror_index(i: i32, n: i32) -> i32 {
  let period = 2 * n;
  let m = ((i % period) + period) % period;
  if (m >= n) {
    return period - 1 - m;
  }
  return m;
}

fn channel_at(x: i32, y: i32, channel: u32) -> f32 {
  let mx = mirror_index(x, i32(params.width));
  let my = mirror_index(y, i32(params.height));
  let word = src[u32(my) * params.width + u32(mx)];
  return f32((word >> (8u * channel)) & 0xffu) / 255.0;
}

fn surface_estimate(x: i32, y: i32, channel: u32) -> f32 {
  let r = i32(params.radius);
  let center = channel_at(x, y, channel);
  var sum = 0.0;
  var total = 0.0;
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      if (dx * dx + dy * dy <= r * r) {
        let s = channel_at(x + dx, y + dy, channel);
        let w = max(0.0, 1.0 - abs(s - center) * params.slope);
        sum = sum + w * s;
        total = total + w;
      }
    }
  }
  return sum / total;
}

fn to_byte(value: f32) -> u32 {
  return u32(clamp(floor(value * 255.0 + 0.5), 0.0, 255.0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = params.origin_x + id.x;
  let y = params.origin_y + id.y;
  if (x >= params.width || y >= params.height) {
    return;
  }
  var word = 0u;
  for (var channel = 0u; channel < 4u; channel = channel + 1u) {
    word = word | (to_byte(surface_estimate(i32(x), i32(y), channel)) << (8u * channel));
  }
  dst[y * params.width + x] = word;
}
`;
