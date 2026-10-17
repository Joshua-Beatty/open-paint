import { ARTISTIC_HELPERS_WGSL, ARTISTIC_PARAMS_WGSL } from "./artistic-wgsl-common";

/**
 * WGSL twin of `ink_sketch_rgba8` (FX-ART-INK), as three entry points run in order. `ink_lines` is
 * the 5x5 high-pass and the threshold. `glow_screen` is the Brightness / Contrast and screen of the
 * Glow, over the clamped Gaussian. `ink_darken` blends the ink over the glow with Darken. Each
 * stage reads and writes packed RGBA8 words, as the Rust stages do, so the stages round to 8 bits
 * the same way. `f0` is the ink threshold for `ink_lines`, and `f0` to `f2` the Brightness /
 * Contrast plan for `glow_screen`.
 */
export const INK_SKETCH_WGSL = /* wgsl */ `
${ARTISTIC_PARAMS_WGSL}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> other: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

${ARTISTIC_HELPERS_WGSL}

fn ink_tap(dx: i32, dy: i32) -> f32 {
  if (dx == 0 && dy == 0) {
    return 30.0;
  }
  if (dx == 0 && dy == -2) {
    return -5.0;
  }
  return -1.0;
}

fn convolve(x: i32, y: i32, c: u32) -> f32 {
  var acc = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let sx = mirror_index(x + dx, i32(p.width));
      let sy = mirror_index(y + dy, i32(p.height));
      acc = acc + ink_tap(dx, dy) * channel(src[u32(sy) * p.width + u32(sx)], c);
    }
  }
  return acc;
}

fn screen_channel(word: u32, c: u32, lifted: f32, a: f32) -> u32 {
  let dst_value = channel(word, c) * a;
  let glow = lifted * a;
  let screened = 1.0 - (1.0 - dst_value) * (1.0 - glow);
  var straight = 0.0;
  if (a > 0.0) {
    straight = screened / a;
  }
  return to_u8(straight);
}

fn darken_channel(glow: u32, ink: u32, c: u32, share: f32) -> u32 {
  let base_value = channel(glow, c);
  let top = channel(ink, c);
  return to_u8(base_value * (1.0 - share) + share * min(base_value, top));
}

@compute @workgroup_size(8, 8)
fn ink_lines(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let a = src[i] >> 24u;
  if (a == 0u) {
    dst[i] = 0u;
    return;
  }
  let x = i32(id.x);
  let y = i32(id.y);
  let rgb = vec3<f32>(
    clamp(convolve(x, y, 0u), 0.0, 1.0),
    clamp(convolve(x, y, 1u), 0.0, 1.0),
    clamp(convolve(x, y, 2u), 0.0, 1.0),
  );
  let ink = select(0u, 255u, luma(rgb) > p.f0);
  dst[i] = pack_rgba(ink, ink, ink, a);
}

@compute @workgroup_size(8, 8)
fn glow_screen(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let s = src[i];
  let b = other[i];
  let a = channel(s, 3u);
  let lifted = brightness_contrast(
    vec3<f32>(channel(b, 0u), channel(b, 1u), channel(b, 2u)),
    p.f0,
    p.f1,
    p.f2,
  );
  dst[i] = pack_rgba(
    screen_channel(s, 0u, lifted.x, a),
    screen_channel(s, 1u, lifted.y, a),
    screen_channel(s, 2u, lifted.z, a),
    s >> 24u,
  );
}

@compute @workgroup_size(8, 8)
fn ink_darken(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let g = src[i];
  let k = other[i];
  let share = channel(k, 3u);
  dst[i] = pack_rgba(
    darken_channel(g, k, 0u, share),
    darken_channel(g, k, 1u, share),
    darken_channel(g, k, 2u, share),
    g >> 24u,
  );
}
`;
