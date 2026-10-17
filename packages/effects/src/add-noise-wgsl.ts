import { PIXEL_RNG_WGSL } from "./rng-wgsl";

/** Bytes of the `Params` uniform of the Add Noise shader. */
export const ADD_NOISE_PARAMS_BYTES = 32;

/**
 * WGSL twin of `add_noise_rgba8` in `crates/opaint-cpu/src/noise.rs` (FX-NOISE-ADD-03). Each invocation
 * computes one pixel with the per-pixel generator of `rng-wgsl.ts`, so the draws match the Rust reference.
 * All arithmetic is integer, as in the reference, except the coverage test on a draw. The deviate table
 * comes from Rust as a storage buffer, and `origin` places each tile in the image.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed RGBA8
 * `u32` words, 3 the deviate table as `i32` values.
 */
export const ADD_NOISE_WGSL = /* wgsl */ `
${PIXEL_RNG_WGSL}

struct Params {
  width: u32,
  height: u32,
  origin_x: u32,
  origin_y: u32,
  seed: u32,
  intensity: u32,
  saturation: u32,
  coverage: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> deviates: array<i32>;

fn deviate(unit: f32) -> i32 {
  let count = arrayLength(&deviates);
  let index = min(u32(floor(unit * f32(count))), count - 1u);
  return deviates[index];
}

fn add_channel(value: u32, c1: i32, i: i32, sat: i32, dev: i32) -> u32 {
  let c2 = i + (((c1 - i) * sat) >> 12u);
  let delta = (c2 * dev + 32768) >> 16u;
  return u32(clamp(i32(value) + delta, 0, 255));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = params.origin_x + id.x;
  let y = params.origin_y + id.y;
  if (x >= params.width || y >= params.height) {
    return;
  }
  let index = y * params.width + x;
  let word = src[index];
  var state = pixel_state(params.seed, x, y);
  if (draw_unit(&state) > params.coverage / 100.0) {
    dst[index] = word;
    return;
  }
  let r1 = deviate(draw_unit(&state));
  let g1 = deviate(draw_unit(&state));
  let b1 = deviate(draw_unit(&state));
  let dev = i32(params.intensity * params.intensity / 4u);
  let sat = i32((params.saturation * 4096u + 50u) / 100u);
  let i = (4899 * r1 + 9618 * g1 + 1867 * b1) >> 14u;
  let red = add_channel(word & 0xffu, r1, i, sat, dev);
  let green = add_channel((word >> 8u) & 0xffu, g1, i, sat, dev);
  let blue = add_channel((word >> 16u) & 0xffu, b1, i, sat, dev);
  dst[index] = red | (green << 8u) | (blue << 16u) | (word & 0xff000000u);
}
`;
