import { ARTISTIC_HELPERS_WGSL, ARTISTIC_PARAMS_WGSL } from "./artistic-wgsl-common";

/**
 * WGSL twin of `oil_painting_rgba8` (FX-ART-OIL), one pixel per invocation. The shader reads the
 * linear, premultiplied color of each kernel pixel, bins it by luma, then takes the average of the
 * most populated bin. `f0` is the disc limit, `i0` the brush radius, `u0` the bin count and `u1`
 * 1 for a square kernel. The histograms live in private memory, sized for the 256 bins at most.
 */
export const OIL_PAINTING_WGSL = /* wgsl */ `
${ARTISTIC_PARAMS_WGSL}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

${ARTISTIC_HELPERS_WGSL}

var<private> counts: array<u32, 256>;
var<private> sums: array<vec4<f32>, 256>;

fn lift(i: u32) -> vec4<f32> {
  let w = src[i];
  let a = channel(w, 3u);
  return vec4<f32>(
    to_linear(channel(w, 0u)) * a,
    to_linear(channel(w, 1u)) * a,
    to_linear(channel(w, 2u)) * a,
    a,
  );
}

fn bin_of(v: vec4<f32>) -> u32 {
  let y = clamp(0.299 * v.x + 0.587 * v.y + 0.114 * v.z, 0.0, 1.0);
  return u32(floor(y * f32(p.u0 - 1u)));
}

fn straight_channel(c: f32, a: f32) -> u32 {
  var straight = 0.0;
  if (a > 0.0) {
    straight = clamp(c / a, 0.0, 1.0);
  }
  return to_u8(to_srgb(straight));
}

@compute @workgroup_size(8, 8)
fn oil_painting(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let radius = p.i0;
  for (var b = 0u; b < p.u0; b++) {
    counts[b] = 0u;
    sums[b] = vec4<f32>(0.0);
  }
  let x = i32(id.x);
  let y = i32(id.y);
  let w = i32(p.width);
  let h = i32(p.height);
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      if (p.u1 == 1u || f32(dx * dx + dy * dy) <= p.f0) {
        let sx = clamp(x + dx, 0, w - 1);
        let sy = clamp(y + dy, 0, h - 1);
        let index = u32(sy) * p.width + u32(sx);
        let v = lift(index);
        let bin = bin_of(v);
        counts[bin] = counts[bin] + 1u;
        sums[bin] = sums[bin] + v;
      }
    }
  }
  var best = 0u;
  for (var b = 1u; b < p.u0; b++) {
    if (counts[b] > counts[best]) {
      best = b;
    }
  }
  let avg = sums[best] / f32(counts[best]);
  let a = clamp(avg.w, 0.0, 1.0);
  let i = id.y * p.width + id.x;
  dst[i] = pack_rgba(
    straight_channel(avg.x, a),
    straight_channel(avg.y, a),
    straight_channel(avg.z, a),
    to_u8(a),
  );
}
`;
