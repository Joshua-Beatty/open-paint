import { BLEND_WGSL } from "./composite-wgsl";

/**
 * WGSL twin of the brush coverage in `crates/opaint-cpu/src/brush.rs` and `brush_field.rs`, with
 * the same operations in the same order. A round tip's parts add two fixed-point integrals per
 * pixel (`field_term`); a square tip's sweeps keep the largest 8-bit coverage (`square_cover`).
 * `stroke_coverage` turns a pixel's two words into its coverage. Dabs are `xy` centre and `z`
 * reach in image pixels; term kinds are 0 segment, 1 cap, 2 point, 3 square sweep.
 */
export const BRUSH_COVERAGE_WGSL = /* wgsl */ `
const FIELD_SIGMA: f32 = 0.3;
const FIELD_INFLUENCE: f32 = 1.45;
const FIELD_ONE: f32 = 4194304.0;

fn tip_falloff(rho: f32, reach: f32, core: f32, antialias: bool) -> f32 {
  if (rho >= 1.0) {
    return 0.0;
  }
  if (!antialias) {
    return 1.0;
  }
  let rim = min((1.0 - rho) * reach, 1.0);
  if (rho <= core) {
    return rim;
  }
  let x = (rho - core) / (1.0 - core);
  let u = 1.0 - x * x;
  return u * u * rim;
}

fn square_ratio_at(e: vec2f, d: vec2f, ra: f32, dr: f32, t: f32) -> vec2f {
  let q = e - t * d;
  let r = ra + t * dr;
  return vec2f(max(abs(q.x), abs(q.y)) / r, r);
}

fn better_square(best: vec2f, e: vec2f, d: vec2f, ra: f32, dr: f32, t: f32) -> vec2f {
  if (t > 0.0 && t <= 1.0) {
    let candidate = square_ratio_at(e, d, ra, dr, t);
    if (candidate.x < best.x) {
      return candidate;
    }
  }
  return best;
}

// The coverage of a square tip swept from a to b (brush.rs square_ratio).
fn square_cover(p: vec2f, a: vec3f, b: vec3f, core: f32, antialias: bool) -> u32 {
  let low = min(a.xy - a.z, b.xy - b.z);
  let high = max(a.xy + a.z, b.xy + b.z);
  if (any(p < floor(low)) || any(p > ceil(high))) {
    return 0u;
  }
  let e = p - a.xy;
  let d = b.xy - a.xy;
  let dr = b.z - a.z;
  var best = square_ratio_at(e, d, a.z, dr, 0.0);
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
  return u32(floor(tip_falloff(best.x, best.y, core, antialias) * 255.0 + 0.5));
}

// exp(x) for x <= 0 (brush_field.rs exp_neg): 2^n e^t with t = x - n ln 2 and a Taylor polynomial.
fn exp_neg(x: f32) -> f32 {
  let n = floor(x * 1.442695 + 0.5);
  if (n < -126.0) {
    return 0.0;
  }
  let t = (x - n * 0.69314575) - n * 1.4286068e-6;
  let p = 1.0 + t * (1.0 + t * (0.5 + t * (0.16666667 + t * (0.041666668 + t * (0.008333334 + t * 0.0013888889)))));
  return ldexp(p, i32(n));
}

// erfc(x) * exp(x^2) for x >= 0 (Abramowitz and Stegun 7.1.26).
fn erfc_scaled(x: f32) -> f32 {
  let t = 1.0 / (1.0 + 0.3275911 * x);
  return t * (0.2548296 + t * (-0.28449674 + t * (1.4214138 + t * (-1.453152 + t * 1.0614054))));
}

// The weight and weighted squared-distance integrals of a round tip's term (brush_field.rs
// Prepared::value), in units of the term's reach.
fn field_term(kind: u32, p: vec2f, a: vec3f, b: vec3f) -> vec2f {
  let s2 = FIELD_SIGMA * FIELD_SIGMA;
  let k = 0.5 / s2;
  let boundary = FIELD_SIGMA * 0.70710677 * 0.5 * 1.1283792;
  let inv_scale = 1.0 / (1.4142135 * FIELD_SIGMA);
  if (kind != 0u) {
    let inv_r = 1.0 / a.z;
    let v = (p - a.xy) * inv_r;
    let r2 = v.x * v.x + v.y * v.y;
    if (r2 > FIELD_INFLUENCE * FIELD_INFLUENCE) {
      return vec2f(0.0);
    }
    let e = exp_neg(-r2 * k);
    if (kind == 2u) {
      return vec2f(e, (r2 + s2) * e);
    }
    let dd = a.xy - b.xy;
    let inv_len = 1.0 / sqrt(dd.x * dd.x + dd.y * dd.y);
    let u = v.x * (dd.x * inv_len) + v.y * (dd.y * inv_len);
    let y2 = r2 - u * u;
    let half = 0.5 * erfc_scaled(abs(u) * inv_scale);
    if (u <= 0.0) {
      let d = half * e;
      return vec2f(d, (y2 + s2) * d - boundary * u * e);
    }
    let n_end = (r2 + s2) - (y2 + s2) * half - boundary * u;
    return vec2f(e * (1.0 - half), e * n_end);
  }
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let ll = dx * dx + dy * dy;
  let len = sqrt(ll);
  let inv_len = 1.0 / len;
  let ex = p.x - a.x;
  let ey = p.y - a.y;
  let along = ex * dx + ey * dy;
  let t = clamp(along * (1.0 / ll), 0.0, 1.0);
  let reach = a.z + t * (b.z - a.z);
  let qx = ex - t * dx;
  let qy = ey - t * dy;
  let limit = FIELD_INFLUENCE * reach;
  if (qx * qx + qy * qy > limit * limit) {
    return vec2f(0.0);
  }
  let inv_r = 1.0 / reach;
  let u = along * inv_len * inv_r;
  let h = (ex * dy - ey * dx) * inv_len * inv_r;
  let t0 = -u;
  let t1 = len * inv_r - u;
  let h2 = h * h;
  let ea = exp_neg(-(h2 + t0 * t0) * k);
  let eb = exp_neg(-(h2 + t1 * t1) * k);
  let z0 = t0 * inv_scale;
  let z1 = t1 * inv_scale;
  var d: f32;
  if (z0 >= 0.0) {
    d = 0.5 * (erfc_scaled(z0) * ea - erfc_scaled(z1) * eb);
  } else if (z1 <= 0.0) {
    d = 0.5 * (erfc_scaled(-z1) * eb - erfc_scaled(-z0) * ea);
  } else {
    d = exp_neg(-h2 * k) - 0.5 * (erfc_scaled(-z0) * ea + erfc_scaled(z1) * eb);
  }
  return vec2f(d, (h2 + s2) * d - boundary * (t1 * eb - t0 * ea));
}
fn field_units(kind: u32, p: vec2f, a: vec3f, b: vec3f) -> vec2u {
  let v = field_term(kind, p, a, b);
  return vec2u(floor(max(v, vec2f(0.0)) * FIELD_ONE + 0.5));
}

fn saturating_add(a: u32, b: u32) -> u32 {
  let sum = a + b;
  return select(sum, 0xffffffffu, sum < a);
}

// The 8-bit coverage of a pixel's two words (brush.rs coverage_of).
fn stroke_coverage(value: vec2u, square: bool, reach: f32, core: f32, antialias: bool) -> u32 {
  if (square) {
    return min(value.x, 255u);
  }
  if (value.x == 0u) {
    return 0u;
  }
  let rho2 = f32(value.y) / f32(value.x) - FIELD_SIGMA * FIELD_SIGMA;
  return u32(floor(tip_falloff(sqrt(max(rho2, 0.0)), reach, core, antialias) * 255.0 + 0.5));
}
`;

/**
 * WGSL twin of the stroke in `crates/opaint-cpu/src/brush.rs` (TL-BRUSH-01). One `stamp` dispatch
 * adds one part of the stroke to its per-pixel values over the part's bounding box: two words per
 * pixel, added for a round tip's field term, raised to the coverage for a square sweep. One
 * `apply` dispatch over the stroke's bounding box then paints each covered pixel once with its
 * coverage. The dab list comes from the Rust kernels. Pixels are packed RGBA8 words in a storage
 * buffer.
 */
export const BRUSH_WGSL = /* wgsl */ `
struct Part {
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
  kind: u32,
  reach: f32,
}

@group(0) @binding(0) var<uniform> part: Part;
@group(0) @binding(2) var<storage, read_write> pixels: array<u32>;
@group(0) @binding(3) var<storage, read_write> values: array<atomic<u32>>;

${BLEND_WGSL}
${BRUSH_COVERAGE_WGSL}
fn overwrite_channel(d: u32, s: u32, c: u32) -> u32 {
  return min(255u, mul(d, 255u - c) + mul(s, c));
}

fn core_of() -> f32 {
  return select(1.0, part.hardness * part.hardness, part.antialias != 0u);
}

@compute @workgroup_size(8, 8)
fn stamp(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= part.extent_x || id.y >= part.extent_y) {
    return;
  }
  let x = part.origin_x + id.x;
  let y = part.origin_y + id.y;
  let p = vec2f(f32(x) + 0.5, f32(y) + 0.5);
  let index = (y * part.canvas_w + x) * 2u;
  if (part.kind == 3u) {
    let c = square_cover(p, part.a.xyz, part.b.xyz, core_of(), part.antialias != 0u);
    if (c != 0u) {
      atomicMax(&values[index], c);
    }
    return;
  }
  let units = field_units(part.kind, p, part.a.xyz, part.b.xyz);
  if (units.x != 0u || units.y != 0u) {
    atomicAdd(&values[index], units.x);
    atomicAdd(&values[index + 1u], units.y);
  }
}

// Paints the stroke's coverage over its bounding box (origin and extent of the uniform).
@compute @workgroup_size(8, 8)
fn apply(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= part.extent_x || id.y >= part.extent_y) {
    return;
  }
  let x = part.origin_x + id.x;
  let y = part.origin_y + id.y;
  let index = y * part.canvas_w + x;
  let value = vec2u(atomicLoad(&values[index * 2u]), atomicLoad(&values[index * 2u + 1u]));
  let c = stroke_coverage(value, part.square != 0u, part.reach, core_of(), part.antialias != 0u);
  if (c == 0u) {
    return;
  }
  let word = pixels[index];
  let d = vec4u(word & 255u, (word >> 8u) & 255u, (word >> 16u) & 255u, word >> 24u);
  var out: vec4u;
  if (part.paint_mode == 1u) {
    out = vec4u(d.x, d.y, d.z, mul(d.w, 255u - c));
  } else if (part.paint_mode == 2u) {
    out = vec4u(
      overwrite_channel(d.x, part.color_r, c),
      overwrite_channel(d.y, part.color_g, c),
      overwrite_channel(d.z, part.color_b, c),
      overwrite_channel(d.w, part.color_a, c),
    );
  } else {
    let s = vec4u(part.color_r, part.color_g, part.color_b, mul(part.color_a, c));
    out = composite_pixel(d, s, part.blend_mode, 255u);
  }
  pixels[index] = out.x | (out.y << 8u) | (out.z << 16u) | (out.w << 24u);
}
`;
