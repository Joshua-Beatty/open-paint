/**
 * WGSL twin of `crates/opaint-cpu/src/rng.rs` (FX-A-00-05). The functions compute the same u32
 * states and the same 24-bit draws, so a seed gives the same pattern on both backends.
 */
export const PIXEL_RNG_WGSL = /* wgsl */ `
fn pcg_hash(input: u32) -> u32 {
  let state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn hash_combine(seed: u32, value: u32) -> u32 {
  return (seed * 33u) ^ value;
}

fn pixel_state(seed: u32, x: u32, y: u32) -> u32 {
  return hash_combine(seed, pcg_hash(pcg_hash(x) ^ y));
}

fn draw_unit(state: ptr<function, u32>) -> f32 {
  *state = pcg_hash(*state);
  return f32(*state >> 8u) * (1.0 / 16777216.0);
}
`;

/**
 * A compute shader that writes the per-pixel noise of `noiseCpu` as packed RGBA8 (one `u32` per
 * pixel, little-endian bytes). Used by the GPU golden check of the generator.
 */
export const PIXEL_NOISE_WGSL = /* wgsl */ `
${PIXEL_RNG_WGSL}

struct NoiseParams {
  width: u32,
  height: u32,
  seed: u32,
  pad: u32,
};

@group(0) @binding(0) var<uniform> noise_params: NoiseParams;
@group(0) @binding(1) var<storage, read_write> noise_out: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= noise_params.width || id.y >= noise_params.height) {
    return;
  }
  var state = pixel_state(noise_params.seed, id.x, id.y);
  var word = 0xff000000u;
  for (var channel = 0u; channel < 3u; channel = channel + 1u) {
    let unit = draw_unit(&state);
    let component = min(u32(floor(unit * 256.0)), 255u);
    word = word | (component << (channel * 8u));
  }
  noise_out[id.y * noise_params.width + id.x] = word;
}
`;
