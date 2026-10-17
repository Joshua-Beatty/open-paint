import { CENTERED_BLUR_WGSL } from "./centered-blur-wgsl";

/** Bytes of the `Params` uniform of the Zoom Blur shader. */
export const ZOOM_BLUR_PARAMS_BYTES = 32;

/**
 * WGSL twin of `zoom_blur_rgba8` in `crates/opaint-cpu/src/radial_zoom_blur.rs` (FX-BLUR-ZOOM-03).
 * Each pixel reads the clamped, premultiplied source at `center + (p - center) / scale` for every
 * `scale, weight` pair of the plan, sums the weighted samples, and writes straight-alpha RGBA8. The
 * plan comes from `zoom_plan`, so the shader and the reference read the same numbers.
 */
export const ZOOM_BLUR_WGSL = /* wgsl */ `
${CENTERED_BLUR_WGSL}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  let p = vec2<f32>(f32(id.x) + 0.5, f32(id.y) + 0.5);
  let d = p - params.center;
  var acc = vec4<f32>(0.0);
  for (var i = 0u; i < params.count; i = i + 1u) {
    let entry = plan[i];
    let s = params.center + d / entry.x;
    acc = acc + sample_clamped(s) * entry.y;
  }
  dst[id.y * params.width + id.x] = pack_straight(acc);
}
`;
