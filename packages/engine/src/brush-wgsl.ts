import { BLEND_WGSL } from "./composite-wgsl";

/**
 * WGSL twin of the tip coverage in `crates/opaint-cpu/src/brush.rs` (`sweep_ratio`, `tip_falloff`
 * and `sweep_coverage`), with the same operations in the same order. `sweep_cover` gives the 8-bit
 * coverage at pixel centre `p` (image pixels) of the tip swept from `a` to `b`, each its centre
 * and reach (`xy`, `z`). A single dab is the segment from it to itself.
 */
export const SWEEP_WGSL = /* wgsl */ `
fn square_ratio(e: vec2f, d: vec2f, ra: f32, dr: f32, t: f32) -> vec2f {
  let q = e - t * d;
  let r = ra + t * dr;
  return vec2f(max(abs(q.x), abs(q.y)) / r, r);
}

fn better_square(best: vec2f, e: vec2f, d: vec2f, ra: f32, dr: f32, t: f32) -> vec2f {
  if (t > 0.0 && t <= 1.0) {
    let candidate = square_ratio(e, d, ra, dr, t);
    if (candidate.x < best.x) {
      return candidate;
    }
  }
  return best;
}

// The smallest distance / reach from p to the swept tip, and the reach there.
fn sweep_ratio(p: vec2f, a: vec3f, b: vec3f, square: bool) -> vec2f {
  let e = p - a.xy;
  let d = b.xy - a.xy;
  let dr = b.z - a.z;
  if (square) {
    var best = square_ratio(e, d, a.z, dr, 0.0);
    best = better_square(best, e, d, a.z, dr, 1.0);
    if (d.x != 0.0) {
      best = better_square(best, e, d, a.z, dr, e.x / d.x);
    }
    if (d.y != 0.0) {
      best = better_square(best, e, d, a.z, dr, e.y / d.y);
    }
    if (d.x != d.y) {
      best = better_square(best, e, d, a.z, dr, (e.x - e.y) / (d.x - d.y));
    }
    if (d.x != -d.y) {
      best = better_square(best, e, d, a.z, dr, (e.x + e.y) / (d.x + d.y));
    }
    return best;
  }
  let ee = e.x * e.x + e.y * e.y;
  var best = vec2f(ee / (a.z * a.z), a.z);
  let f = p - b.xy;
  let at_b = (f.x * f.x + f.y * f.y) / (b.z * b.z);
  if (at_b < best.x) {
    best = vec2f(at_b, b.z);
  }
  let dd = d.x * d.x + d.y * d.y;
  let ed = e.x * d.x + e.y * d.y;
  let den = dd * a.z + ed * dr;
  if (den != 0.0) {
    let t = (ed * a.z + ee * dr) / den;
    if (t > 0.0 && t < 1.0) {
      let q = e - t * d;
      let r = a.z + t * dr;
      let inner = (q.x * q.x + q.y * q.y) / (r * r);
      if (inner < best.x) {
        best = vec2f(inner, r);
      }
    }
  }
  return vec2f(sqrt(best.x), best.y);
}

// (1 - x^2)^4 past the hard core, times a 1 px ramp at the reach (brush.rs tip_falloff).
fn tip_falloff(rho: f32, reach: f32, hardness: f32, antialias: bool) -> f32 {
  if (rho >= 1.0) {
    return 0.0;
  }
  if (!antialias) {
    return 1.0;
  }
  let rim = min((1.0 - rho) * reach, 1.0);
  if (rho <= hardness) {
    return rim;
  }
  let x = (rho - hardness) / (1.0 - hardness);
  let u = 1.0 - x * x;
  let u2 = u * u;
  return u2 * u2 * rim;
}

fn sweep_cover(p: vec2f, a: vec3f, b: vec3f, hardness: f32, square: bool, antialias: bool) -> u32 {
  let low = min(a.xy - a.z, b.xy - b.z);
  let high = max(a.xy + a.z, b.xy + b.z);
  if (any(p < floor(low)) || any(p > ceil(high))) {
    return 0u;
  }
  let ratio = sweep_ratio(p, a, b, square);
  let h = select(1.0, hardness, antialias);
  return u32(floor(tip_falloff(ratio.x, ratio.y, h, antialias) * 255.0 + 0.5));
}
`;

/**
 * WGSL twin of the stroke in `crates/opaint-cpu/src/brush.rs` (TL-BRUSH-01). One `stamp` dispatch
 * raises the stroke's coverage buffer to one segment's swept tip coverage over its bounding box
 * (the largest over the stroke, as `stroke_coverage`). One `apply` dispatch over the stroke's
 * bounding box then paints each covered pixel once with its coverage. The dab list comes from the
 * Rust kernels. Pixels are packed RGBA8 words in a storage buffer.
 */
export const BRUSH_WGSL = /* wgsl */ `
struct Segment {
  a: vec4f,
  b: vec4f,
  origin_x: u32,
  origin_y: u32,
  extent_x: u32,
  extent_y: u32,
  canvas_w: u32,
  paint_mode: u32,
  blend_mode: u32,
  antialias: u32,
  color_r: u32,
  color_g: u32,
  color_b: u32,
  color_a: u32,
  hardness: f32,
  square: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> seg: Segment;
@group(0) @binding(2) var<storage, read_write> pixels: array<u32>;
@group(0) @binding(3) var<storage, read_write> cover: array<atomic<u32>>;

${BLEND_WGSL}
${SWEEP_WGSL}
fn overwrite_channel(d: u32, s: u32, c: u32) -> u32 {
  return min(255u, mul(d, 255u - c) + mul(s, c));
}

@compute @workgroup_size(8, 8)
fn stamp(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= seg.extent_x || id.y >= seg.extent_y) {
    return;
  }
  let x = seg.origin_x + id.x;
  let y = seg.origin_y + id.y;
  let p = vec2f(f32(x) + 0.5, f32(y) + 0.5);
  let c = sweep_cover(p, seg.a.xyz, seg.b.xyz, seg.hardness, seg.square != 0u, seg.antialias != 0u);
  if (c == 0u) {
    return;
  }
  atomicMax(&cover[y * seg.canvas_w + x], c);
}

// Paints the stroke's coverage over its bounding box (origin and extent of the uniform).
@compute @workgroup_size(8, 8)
fn apply(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= seg.extent_x || id.y >= seg.extent_y) {
    return;
  }
  let x = seg.origin_x + id.x;
  let y = seg.origin_y + id.y;
  let index = y * seg.canvas_w + x;
  let c = atomicLoad(&cover[index]);
  if (c == 0u) {
    return;
  }
  let word = pixels[index];
  let d = vec4u(word & 255u, (word >> 8u) & 255u, (word >> 16u) & 255u, word >> 24u);
  var out: vec4u;
  if (seg.paint_mode == 1u) {
    out = vec4u(d.x, d.y, d.z, mul(d.w, 255u - c));
  } else if (seg.paint_mode == 2u) {
    out = vec4u(
      overwrite_channel(d.x, seg.color_r, c),
      overwrite_channel(d.y, seg.color_g, c),
      overwrite_channel(d.z, seg.color_b, c),
      overwrite_channel(d.w, seg.color_a, c),
    );
  } else {
    let s = vec4u(seg.color_r, seg.color_g, seg.color_b, mul(seg.color_a, c));
    out = composite_pixel(d, s, seg.blend_mode, 255u);
  }
  pixels[index] = out.x | (out.y << 8u) | (out.z << 16u) | (out.w << 24u);
}
`;
