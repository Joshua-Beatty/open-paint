import { CENTERED_BLUR_WGSL } from "./centered-blur-wgsl";

/** Bytes of the `Params` uniform of the Radial Blur shader. */
export const RADIAL_BLUR_PARAMS_BYTES = 32;

/**
 * WGSL twin of `radial_blur_rgba8` in `crates/opaint-cpu/src/radial_zoom_blur.rs` (FX-BLUR-RADIAL-03).
 * Each pixel rotates about the center by every `cos, sin` pair of the plan, sums the premultiplied
 * bilinear samples and their coverage, and writes straight-alpha RGBA8. The plan comes from
 * `radial_plan`, so the shader and the reference read the same numbers.
 */
export const RADIAL_BLUR_WGSL = /* wgsl */ `
${CENTERED_BLUR_WGSL}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  let p = vec2<f32>(f32(id.x) + 0.5, f32(id.y) + 0.5);
  let d = p - params.center;
  var acc = vec4<f32>(0.0);
  var total = 0.0;
  for (var i = 0u; i < params.count; i = i + 1u) {
    let rot = plan[i];
    let s = params.center + vec2<f32>(rot.x * d.x - rot.y * d.y, rot.y * d.x + rot.x * d.y);
    acc = acc + sample_texel(s);
    total = total + sample_coverage(s);
  }
  var word = 0u;
  if (total > 0.0) {
    word = pack_straight(acc / total);
  }
  dst[id.y * params.width + id.x] = word;
}
`;
