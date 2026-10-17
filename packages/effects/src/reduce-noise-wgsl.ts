/** Bytes of the `Params` uniform of the Reduce Noise shader. */
export const REDUCE_NOISE_PARAMS_BYTES = 32;

/**
 * WGSL twin of `reduce_noise_rgba8` in `crates/opaint-cpu/src/noise.rs` (FX-NOISE-REDUCE-03). Each
 * invocation computes one pixel: a count of the mirrored disc's pixels darker than the pixel in each
 * channel, then the lerp with the luma-dependent factor. The GPU runs it once per tile, and `origin` places
 * the tile in the image.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed RGBA8
 * `u32` words.
 */
export const REDUCE_NOISE_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  origin_x: u32,
  origin_y: u32,
  radius: u32,
  strength: f32,
  pad_a: u32,
  pad_b: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

fn mirror_index(index: i32, len: i32) -> i32 {
  let period = 2 * len;
  let m = ((index % period) + period) % period;
  return select(m, period - 1 - m, m >= len);
}

fn channel_of(word: u32, channel: u32) -> u32 {
  return (word >> (8u * channel)) & 0xffu;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = params.origin_x + id.x;
  let y = params.origin_y + id.y;
  if (x >= params.width || y >= params.height) {
    return;
  }
  let index = y * params.width + x;
  let center = src[index];
  if (params.radius == 0u) {
    dst[index] = center;
    return;
  }
  let r = i32(params.radius);
  let width = i32(params.width);
  let height = i32(params.height);
  var below = vec3<u32>(0u, 0u, 0u);
  var total = 0u;
  for (var dy = -r; dy <= r; dy = dy + 1) {
    for (var dx = -r; dx <= r; dx = dx + 1) {
      if (dx * dx + dy * dy <= r * r) {
        let mx = mirror_index(i32(x) + dx, width);
        let my = mirror_index(i32(y) + dy, height);
        let neighbor = src[u32(my) * params.width + u32(mx)];
        for (var channel = 0u; channel < 3u; channel = channel + 1u) {
          if (channel_of(neighbor, channel) < channel_of(center, channel)) {
            below[channel] = below[channel] + 1u;
          }
        }
        total = total + 1u;
      }
    }
  }
  let value = vec3<f32>(
    f32(channel_of(center, 0u)),
    f32(channel_of(center, 1u)),
    f32(channel_of(center, 2u)),
  ) / 255.0;
  let luma = 0.2126 * value.x + 0.7152 * value.y + 0.0722 * value.z;
  let lambda = (-0.2 * params.strength) * (1.0 - 0.75 * luma);
  let count = f32(total);
  var word = center & 0xff000000u;
  for (var channel = 0u; channel < 3u; channel = channel + 1u) {
    let v = value[channel];
    let rank = f32(below[channel]) / count;
    let mixed = clamp(v + (rank - v) * lambda, 0.0, 1.0);
    word = word | (u32(floor(mixed * 255.0 + 0.5)) << (8u * channel));
  }
  dst[index] = word;
}
`;
