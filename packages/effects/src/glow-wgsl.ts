import { ARTISTIC_HELPERS_WGSL, ARTISTIC_PARAMS_WGSL } from "./artistic-wgsl-common";

/**
 * WGSL twin of `glow_rgba8` (FX-PHOTO-GLOW), one entry point over the clamped Gaussian. `glow_screen`
 * applies Brightness / Contrast to the blurred image and screens it over the source. `f0` to `f2` are
 * the Brightness / Contrast plan. The blur runs in its own pass before this one (`GpuGaussianBlur`).
 */
export const GLOW_WGSL = /* wgsl */ `
${ARTISTIC_PARAMS_WGSL}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> blurred: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

${ARTISTIC_HELPERS_WGSL}

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

@compute @workgroup_size(8, 8)
fn glow_screen(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let s = src[i];
  let b = blurred[i];
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
`;
