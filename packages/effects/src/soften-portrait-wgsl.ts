import { ARTISTIC_HELPERS_WGSL, ARTISTIC_PARAMS_WGSL } from "./artistic-wgsl-common";

/**
 * WGSL twin of `soften_portrait_rgba8` (FX-PHOTO-SOFTEN), one entry point over the clamped Gaussian
 * of the source, which runs in its own pass before this one. `f0` to `f2` are the Brightness /
 * Contrast plan of the source branch, and `i0` is Warmth (divided by 100 here, as in Rust).
 */
export const SOFTEN_PORTRAIT_WGSL = /* wgsl */ `
${ARTISTIC_PARAMS_WGSL}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> blurred: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

${ARTISTIC_HELPERS_WGSL}

fn overlay(base: f32, source: f32) -> f32 {
  if (base <= 0.5) {
    return 2.0 * base * source;
  }
  return 1.0 - 2.0 * (1.0 - base) * (1.0 - source);
}

@compute @workgroup_size(8, 8)
fn soften_portrait(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let s = src[i];
  let b = blurred[i];
  let tint = f32(p.i0) / 100.0;
  let gray = luma(vec3<f32>(channel(s, 0u), channel(s, 1u), channel(s, 2u)));
  let warm = vec3<f32>(
    clamp(gray * (1.0 + tint), 0.0, 1.0),
    gray,
    clamp(gray * (1.0 - tint), 0.0, 1.0),
  );
  let lifted = brightness_contrast(
    vec3<f32>(channel(b, 0u), channel(b, 1u), channel(b, 2u)),
    p.f0,
    p.f1,
    p.f2,
  );
  dst[i] = pack_rgba(
    to_u8(overlay(warm.x, lifted.x)),
    to_u8(overlay(warm.y, lifted.y)),
    to_u8(overlay(warm.z, lifted.z)),
    s >> 24u,
  );
}
`;
