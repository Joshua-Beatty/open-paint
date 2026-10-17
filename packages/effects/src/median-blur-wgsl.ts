/** Bytes of the `Params` uniform of the Median Blur shader. */
export const MEDIAN_BLUR_PARAMS_BYTES = 32;

/**
 * WGSL twin of `median_blur_rgba8` in `crates/opaint-cpu/src/neighborhood_blur.rs` (FX-BLUR-MEDIAN-03).
 * Each invocation computes one pixel: for each channel, the bisection of `median_estimate` over the
 * disc, with the integer rank test. The GPU runs it once per tile, and `origin` places the tile in the
 * image (FX-BLUR-MEDIAN-03: no single dispatch runs long).
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed
 * RGBA8 `u32` words.
 */
export const MEDIAN_BLUR_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  origin_x: u32,
  origin_y: u32,
  radius: u32,
  percentile: u32,
  quality: u32,
  pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

fn channel_at(x: i32, y: i32, channel: u32) -> f32 {
  let cx = clamp(x, 0, i32(params.width) - 1);
  let cy = clamp(y, 0, i32(params.height) - 1);
  let word = src[u32(cy) * params.width + u32(cx)];
  return f32((word >> (8u * channel)) & 0xffu);
}

fn median_estimate(x: i32, y: i32, channel: u32) -> f32 {
  let r = i32(params.radius);
  var lo = 255.0;
  var hi = 0.0;
  var total = 0u;
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      if (dx * dx + dy * dy <= r * r) {
        let v = channel_at(x + dx, y + dy, channel);
        lo = min(lo, v);
        hi = max(hi, v);
        total = total + 1u;
      }
    }
  }
  for (var i = 0u; i < params.quality; i = i + 1u) {
    let mid = (lo + hi) * 0.5;
    var below = 0u;
    for (var dy = -r; dy <= r; dy = dy + 1) {
      for (var dx = -r; dx <= r; dx = dx + 1) {
        if (dx * dx + dy * dy <= r * r && channel_at(x + dx, y + dy, channel) < mid) {
          below = below + 1u;
        }
      }
    }
    if (below * 100u < params.percentile * total) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return floor(hi);
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
    word = word | (u32(median_estimate(i32(x), i32(y), channel)) << (8u * channel));
  }
  dst[y * params.width + x] = word;
}
`;
