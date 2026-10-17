/** Bytes of the Red Eye `Params` uniform. */
export const RED_EYE_PARAMS_BYTES = 32;

/**
 * WGSL twin of `red_eye_rgba8` in `crates/opaint-cpu/src/photo.rs` (FX-PHOTO-REDEYE-01). The
 * reference groups the selection into clusters and corrects each selected pixel of a cluster once,
 * so the result is the same per-pixel correction over every selected pixel, which runs here as one
 * pass.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed
 * RGBA8 `u32` words, 3 the selection coverage (one byte per pixel, four to a word), 4 the 256 values
 * `i / 255` as Rust divides them (a WGSL division is approximate, and the thresholds compare them).
 * `ratio` (`1.9 - 0.1 · strength`) and `correction` (`strength / 5`) are computed by the host as the
 * reference computes them. `zero` is always 0.
 */
export const RED_EYE_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  ratio: f32,
  correction: f32,
  zero: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> coverage: array<u32>;
@group(0) @binding(4) var<storage, read> unit: array<f32, 256>;

// A product that is then added or compared is rounded on its own, as Rust rounds it: the bits pass
// an XOR with a zero the compiler cannot know, so no fused multiply-add moves a threshold.
fn rounded(x: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(x) ^ p.zero);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let word = src[i];
  dst[i] = word;
  let c = (coverage[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
  if (c == 0u) {
    return;
  }
  let original = word & 0xffu;
  let r = unit[original];
  let g = unit[(word >> 8u) & 0xffu];
  let b = unit[(word >> 16u) & 0xffu];
  let green_blue = max(g, b);
  if (r <= 0.25 || r <= rounded(p.ratio * green_blue)) {
    return;
  }
  var redness = 1.0;
  if (green_blue > 0.0) {
    redness = clamp(r / green_blue - p.ratio, 0.0, 1.0);
  }
  let corrected = r + rounded(((g + b) / 2.0 - r) * rounded(redness * p.correction));
  let effected = u32(floor(rounded(255.0 * clamp(corrected, 0.0, 1.0)) + 0.5));
  let mixed = (original * (255u - c) + effected * c + 127u) / 255u;
  dst[i] = (word & 0xffffff00u) | mixed;
}
`;
