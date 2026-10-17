import { ARTISTIC_HELPERS_WGSL } from "./artistic-wgsl-common";

/** Bytes of the `Params` uniform of the Vignette shader (eight 4-byte fields). */
export const VIGNETTE_PARAMS_BYTES = 32;

/**
 * WGSL twin of `vignette_rgba8` in `crates/opaint-cpu/src/photo.rs` (FX-PHOTO-VIGNETTE). Each pixel's
 * colors are decoded to linear light, multiplied by the falloff factor, and encoded again. Alpha is
 * kept. The center and the falloff `k` come from the Rust plan (`vignette_plan`), so both backends
 * agree on them. Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the
 * output as packed RGBA8 `u32` words.
 */
export const VIGNETTE_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  cx: f32,
  cy: f32,
  k: f32,
  strength: f32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

${ARTISTIC_HELPERS_WGSL}

fn vignette_factor(d: f32) -> f32 {
  let strength = params.strength;
  if (d >= 3.1415927) {
    return 1.0 - strength;
  }
  let c = cos(d);
  if (c <= 0.0) {
    return 1.0 - strength;
  }
  let c2 = c * c;
  return (1.0 - strength) + strength * (c2 * c2);
}

@compute @workgroup_size(8, 8)
fn vignette(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  let index = id.y * params.width + id.x;
  let word = src[index];
  let dx = f32(id.x) + 0.5 - params.cx;
  let dy = f32(id.y) + 0.5 - params.cy;
  let factor = vignette_factor((dx * dx + dy * dy) * params.k);
  let r = to_u8(to_srgb(clamp(to_linear(channel(word, 0u)) * factor, 0.0, 1.0)));
  let g = to_u8(to_srgb(clamp(to_linear(channel(word, 1u)) * factor, 0.0, 1.0)));
  let b = to_u8(to_srgb(clamp(to_linear(channel(word, 2u)) * factor, 0.0, 1.0)));
  dst[index] = pack_rgba(r, g, b, word >> 24u);
}
`;
