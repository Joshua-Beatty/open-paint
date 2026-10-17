import { ARTISTIC_HELPERS_WGSL, ARTISTIC_PARAMS_WGSL } from "./artistic-wgsl-common";

/**
 * WGSL twin of the color dodge in `pencil_sketch_rgba8` (FX-ART-PENCIL-03). The Gaussian blur runs
 * first, as its own pass, and this entry point takes the source and the blurred image. `f0` to `f2`
 * are the Brightness / Contrast plan of the blurred image.
 */
export const PENCIL_SKETCH_WGSL = /* wgsl */ `
${ARTISTIC_PARAMS_WGSL}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> other: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

${ARTISTIC_HELPERS_WGSL}

@compute @workgroup_size(8, 8)
fn pencil_sketch(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let s = src[i];
  let b = other[i];
  let base = luma(vec3<f32>(channel(s, 0u), channel(s, 1u), channel(s, 2u)));
  let adjusted = brightness_contrast(
    vec3<f32>(channel(b, 0u), channel(b, 1u), channel(b, 2u)),
    p.f0,
    p.f1,
    p.f2,
  );
  let top = luma(vec3<f32>(1.0) - adjusted);
  var dodge = 1.0;
  if (top < 1.0) {
    dodge = min(1.0, base / (1.0 - top));
  }
  let gray = to_u8(dodge);
  dst[i] = pack_rgba(gray, gray, gray, s >> 24u);
}
`;
