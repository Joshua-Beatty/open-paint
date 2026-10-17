import { PIXEL_RNG_WGSL } from "./rng-wgsl";

/** Bytes of the `Params` uniform of the Frosted Glass shader. */
export const FROSTED_GLASS_PARAMS_BYTES = 32;

/**
 * WGSL twin of `frost_rgba8` in `crates/opaint-cpu/src/distort.rs` (FX-DIST-FROST-03). Each sample
 * map draws its angle and radius from the per-pixel generator under its own seed, reads the
 * premultiplied source bilinearly with the Reflect edge, and the samples are averaged. The same f32
 * operations run in the same order as the reference.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the seeds (one `u32`
 * per sample map), 3 the output as packed RGBA8 `u32` words.
 */
export const FROSTED_GLASS_WGSL = /* wgsl */ `
${PIXEL_RNG_WGSL}

struct Params {
  width: u32,
  height: u32,
  samples: u32,
  pad: u32,
  plan: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> seeds: array<u32>;
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

fn reflect_index(index: i32, len: i32) -> i32 {
  let period = 2 * len;
  let m = ((index % period) + period) % period;
  if (m >= len) {
    return period - 1 - m;
  }
  return m;
}

fn tap(x: i32, y: i32) -> vec4<f32> {
  let ix = reflect_index(x, i32(params.width));
  let iy = reflect_index(y, i32(params.height));
  return unpack_texel(u32(iy) * params.width + u32(ix));
}

fn sample_bilinear(s: vec2<f32>) -> vec4<f32> {
  let u = s - vec2<f32>(0.5);
  let base = floor(u);
  let frac = u - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);
  return tap(x0, y0) * ((1.0 - frac.x) * (1.0 - frac.y))
    + tap(x0 + 1, y0) * (frac.x * (1.0 - frac.y))
    + tap(x0, y0 + 1) * ((1.0 - frac.x) * frac.y)
    + tap(x0 + 1, y0 + 1) * (frac.x * frac.y);
}

// A power that is zero for a base that is not positive, as in the reference.
fn frost_power(base: f32, exponent: f32) -> f32 {
  if (base > 0.0) {
    return pow(base, exponent);
  }
  return 0.0;
}

fn frost_offset(u1: f32, u2: f32) -> vec2<f32> {
  let min_radius = params.plan.x;
  let max_radius = params.plan.y;
  let diffusion = params.plan.z;
  let theta = 2.0 * 3.14159265358979323846 * u1;
  let lo = frost_power(min_radius, diffusion);
  let hi = frost_power(max_radius, diffusion);
  let radius = frost_power(lo + u2 * (hi - lo), 1.0 / diffusion);
  return vec2<f32>(radius * cos(theta), radius * sin(theta));
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
  for (var s = 0u; s < params.samples; s = s + 1u) {
    var state = pixel_state(seeds[s], id.x, id.y);
    let u1 = draw_unit(&state);
    let u2 = draw_unit(&state);
    let shift = frost_offset(u1, u2);
    let scene = vec2<f32>(f32(id.x) + 0.5, f32(id.y) + 0.5) + shift;
    acc = acc + sample_bilinear(scene);
  }
  let avg = acc / f32(params.samples);
  let alpha = clamp(avg.w, 0.0, 1.0);
  let word = to_byte(straight_channel(avg.x, alpha))
    | (to_byte(straight_channel(avg.y, alpha)) << 8u)
    | (to_byte(straight_channel(avg.z, alpha)) << 16u)
    | (to_byte(alpha) << 24u);
  dst[id.y * params.width + id.x] = word;
}
`;
