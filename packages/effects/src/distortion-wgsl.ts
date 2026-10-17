/**
 * WGSL twin of the distortion engine in `crates/opaint-cpu/src/distort.rs` (FX-A-00-04).
 *
 * The engine is a template. `distortionWgsl(sampleMap)` inserts one `sample_map` function, which
 * takes an output pixel's scene position and returns the source position to read. The engine
 * evaluates it at each rotated-grid offset, samples the premultiplied source bilinearly, averages,
 * and returns straight alpha, with the same f32 operations in the same order as the reference.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the offsets as
 * `vec2<f32>` (from `rgss_offsets`), 3 the output as packed RGBA8 `u32` words.
 */

import { distort_permutations } from "@openpaint/cpu";

/** Bytes of the `Params` uniform: four `u32` fields, then three `vec4<f32>` map parameters. */
export const DISTORTION_PARAMS_BYTES = 64;
/** Map parameters per dispatch (`Params.map`), as f32 values. */
export const DISTORTION_MAP_FLOATS = 12;

/**
 * The affine sample map `x' = a x + c y + e`, `y' = b x + d y + f`, read from the map parameters
 * `[a, b, c, d, e, f]`. This is the same convention as `affine_map` in the Rust reference.
 */
export const AFFINE_SAMPLE_MAP_WGSL = /* wgsl */ `
fn sample_map(p: vec2<f32>) -> vec2<f32> {
  let m0 = params.map[0];
  let m1 = params.map[1];
  return vec2<f32>(m0.x * p.x + m0.z * p.y + m1.x, m0.y * p.x + m0.w * p.y + m1.y);
}
`;

/**
 * The Bulge sample map (FX-DIST-BULGE-03), as the plan `[cx, cy, radius, strength]` in
 * `params.map[0]` from `bulge_plan`. The same operations as `bulge_map` in the Rust reference.
 */
export const BULGE_SAMPLE_MAP_WGSL = /* wgsl */ `
fn sample_map(p: vec2<f32>) -> vec2<f32> {
  let plan = params.map[0];
  let d = p - plan.xy;
  let t = 1.0 - sqrt(d.x * d.x + d.y * d.y) / plan.z;
  if (t > 0.0) {
    let k = 1.0 - plan.w * t * t;
    return plan.xy + d * k;
  }
  return p;
}
`;

/**
 * The Twist sample map (FX-DIST-TWIST-03), as the plan `[cx, cy, limit, gain]` in `params.map[0]`
 * from `twist_plan`. The same operations as `twist_map` in the Rust reference.
 */
export const TWIST_SAMPLE_MAP_WGSL = /* wgsl */ `
fn sample_map(p: vec2<f32>) -> vec2<f32> {
  let plan = params.map[0];
  let d = p - plan.xy;
  let r = sqrt(d.x * d.x + d.y * d.y);
  let u = clamp(1.0 - r / plan.z, 0.0, 1.0);
  let angle = atan2(d.y, d.x) + u * u * u * plan.w;
  return plan.xy + vec2<f32>(r * cos(angle), r * sin(angle));
}
`;

/**
 * The Polar Inversion sample map (FX-DIST-POLAR-03), as the plan `[cx, cy, radius, scale]` in
 * `params.map[0]` from `polar_plan`. The same operations as `polar_map` in the Rust reference.
 */
export const POLAR_SAMPLE_MAP_WGSL = /* wgsl */ `
fn sample_map(p: vec2<f32>) -> vec2<f32> {
  let plan = params.map[0];
  let d = p - plan.xy;
  let r2 = d.x * d.x + d.y * d.y;
  if (r2 == 0.0) {
    return plan.xy;
  }
  let k = 1.0 + plan.w * (plan.z * plan.z / r2 - 1.0);
  return plan.xy + d * k;
}
`;

/**
 * The Tile Reflection sample map (FX-DIST-TILE-03), as the plan `[ox, oy, cos, sin]` in
 * `params.map[0]` and `[k, lambda]` in `params.map[1]`, from `tile_plan`. The same operations as
 * `tile_map` in the Rust reference.
 */
export const TILE_SAMPLE_MAP_WGSL = /* wgsl */ `
// Products that are then added, and the first sum of three terms, go through \`rounded\`: near a
// pole of the tangent a fused multiply-add or a reordered sum moves the sample to another tile.
// \`tile_reciprocal\` and \`tile_tan\` in the Rust reference, operation for operation. WGSL's \`tan\` and
// division are approximate, and near a pole any last-bit difference moves the sample to another tile.
fn tile_reciprocal(b: f32) -> f32 {
  let a = abs(b);
  var y = bitcast<f32>(0x7EF311C3u - bitcast<u32>(a));
  for (var i = 0; i < 3; i = i + 1) {
    y = y * (2.0 - rounded(a * y));
  }
  return select(y, -y, b < 0.0);
}

fn tile_tan(x: f32) -> f32 {
  let n = floor(rounded(x * 0.636619772367581343) + 0.5);
  let r = rounded(rounded(x - rounded(n * 1.5703125)) - rounded(n * 4.837513e-4)) - rounded(n * 7.54979e-8);
  let z = rounded(r * r);
  let s = r + rounded(rounded(r * z) * (-1.6666655e-1 + rounded(z * (8.332161e-3 + rounded(z * -1.9515296e-4)))));
  let c = rounded(1.0 - rounded(0.5 * z))
    + rounded(rounded(z * z) * (4.1666646e-2 + rounded(z * (-1.3887316e-3 + rounded(z * 2.4433157e-5)))));
  var t: f32;
  if ((i32(n) & 1) == 0) {
    t = s * tile_reciprocal(c);
  } else {
    t = -c * tile_reciprocal(s);
  }
  return clamp(t, -1e5, 1e5);
}

fn sample_map(p: vec2<f32>) -> vec2<f32> {
  let plan = params.map[0];
  let rest = params.map[1];
  let d = p - plan.xy;
  let a = rounded2(plan.zw * d.x);
  let b = rounded2(plan.wz * d.y);
  let st = vec2<f32>(a.x - b.x, a.y + b.y);
  let k = rounded2(rest.x * st);
  let t = st + rounded2(rest.y * vec2<f32>(tile_tan(k.x), tile_tan(k.y)));
  let e = rounded2(plan.zw * t.x);
  let f = rounded2(plan.wz * t.y);
  return rounded2(vec2<f32>(plan.x + e.x, plan.y - e.y)) + f;
}
`;

/**
 * The two fixed permutation tables (FX-DIST-CRYSTAL-03), read from the Rust reference so the WGSL
 * tables cannot drift from it. Requires the WASM kernels to be initialized.
 */
export function permutationTablesWgsl(): string {
  const tables = distort_permutations();
  return [
    permutationWgsl("PERM_A", tables.subarray(0, 256)),
    permutationWgsl("PERM_B", tables.subarray(256, 512)),
  ].join("\n");
}

function permutationWgsl(name: string, values: Uint8Array): string {
  return `var<private> ${name}: array<u32, 256> = array<u32, 256>(${Array.from(values).join(", ")});`;
}

/**
 * The Crystalize sample map (FX-DIST-CRYSTAL-03), with the plan `[cell, s0, s1, s2]` in
 * `params.map[0]` and `s3` in `params.map[1].x` from `crystal_plan`. The same operations as
 * `crystal_map` in the Rust reference. Build it with `crystalizeSampleMapWgsl`.
 */
const CRYSTAL_SAMPLE_MAP_WGSL = /* wgsl */ `
fn feature_offset(i: i32, j: i32, salt: vec4<u32>) -> vec2<f32> {
  let ui = bitcast<u32>(i);
  let uj = bitcast<u32>(j);
  let a = PERM_A[(ui + salt.x) & 255u];
  let b = PERM_B[(a + uj + salt.y) & 255u];
  let c = PERM_B[(ui + salt.z) & 255u];
  let d = PERM_A[(c + uj + salt.w) & 255u];
  return vec2<f32>(f32(b), f32(d)) / 256.0;
}

fn sample_map(p: vec2<f32>) -> vec2<f32> {
  let plan = params.map[0];
  let cell = plan.x;
  let salt = vec4<u32>(u32(plan.y), u32(plan.z), u32(plan.w), u32(params.map[1].x));
  let u = p / cell;
  let base = vec2<i32>(floor(u));
  var best = 3.4e38;
  var feature = vec2<f32>(0.0);
  for (var di = -1; di <= 1; di = di + 1) {
    for (var dj = -1; dj <= 1; dj = dj + 1) {
      let c = base + vec2<i32>(di, dj);
      let f = vec2<f32>(c) + feature_offset(c.x, c.y, salt);
      let d = u - f;
      let dd = d.x * d.x + d.y * d.y;
      if (dd < best) {
        best = dd;
        feature = f;
      }
    }
  }
  return vec2<f32>(0.5) + feature * cell;
}
`;

/**
 * The Dents sample map (FX-DIST-DENTS-03), with `[cx, cy, frequency, magnitude]` in `params.map[0]`,
 * `[gain, persistence, octaves, cos]` in `params.map[1]` and `[sin, seed]` in `params.map[2]`, from
 * `dents_plan`. The same operations as `dents_map` in the Rust reference. Build it with
 * `dentsSampleMapWgsl`.
 */
const DENTS_SAMPLE_MAP_WGSL = /* wgsl */ `
// Products that are then added, and products of three factors, go through \`rounded\`: doubled over
// the octaves, a fused multiply-add's last bit moves a noise lookup to another lattice cell.
fn perm_at(i: u32, seed: u32) -> u32 {
  return PERM_A[(i + seed) & 255u];
}

fn fade(t: f32) -> f32 {
  return rounded(rounded(t * t) * t) * (rounded(t * (rounded(t * 6.0) - 15.0)) + 10.0);
}

fn lerp_f(a: f32, b: f32, t: f32) -> f32 {
  return a + rounded(t * (b - a));
}

fn grad2(h: u32, x: f32, y: f32) -> f32 {
  let k = h & 3u;
  if (k == 0u) {
    return x + y;
  }
  if (k == 1u) {
    return -x + y;
  }
  if (k == 2u) {
    return x - y;
  }
  return -x - y;
}

fn perlin(p: vec2<f32>, seed: u32) -> f32 {
  let fl = floor(p);
  let f = p - fl;
  let xi = bitcast<u32>(i32(fl.x)) & 255u;
  let yi = bitcast<u32>(i32(fl.y)) & 255u;
  let x1 = (xi + 1u) & 255u;
  let aa = perm_at((perm_at(xi, seed) + yi) & 255u, seed);
  let ab = perm_at((perm_at(xi, seed) + yi + 1u) & 255u, seed);
  let ba = perm_at((perm_at(x1, seed) + yi) & 255u, seed);
  let bb = perm_at((perm_at(x1, seed) + yi + 1u) & 255u, seed);
  let u = fade(f.x);
  let v = fade(f.y);
  let lower = lerp_f(grad2(aa, f.x, f.y), grad2(ba, f.x - 1.0, f.y), u);
  let upper = lerp_f(grad2(ab, f.x, f.y - 1.0), grad2(bb, f.x - 1.0, f.y - 1.0), u);
  return lerp_f(lower, upper, v);
}

fn rotate2(v: vec2<f32>, c: f32, s: f32) -> vec2<f32> {
  let a = rounded2(vec2<f32>(c, s) * v.x);
  let b = rounded2(vec2<f32>(s, c) * v.y);
  return vec2<f32>(a.x - b.x, a.y + b.y);
}

fn turbulence(v: vec2<f32>, c: f32, s: f32, octaves: f32, persistence: f32, seed: u32) -> f32 {
  var q = rotate2(v, c, s);
  var amplitude = 1.0;
  var sum = 0.0;
  var k = 0.0;
  loop {
    let remaining = octaves - k;
    if (remaining <= 0.0) {
      break;
    }
    sum = sum + rounded(rounded(amplitude * min(remaining, 1.0)) * perlin(q, seed));
    amplitude = amplitude * persistence;
    if (amplitude < 0.001) {
      break;
    }
    let r = rotate2(q, c, s);
    q = vec2<f32>(2.0 * r.x + 499.0, 2.0 * r.y + 506.0);
    k = k + 1.0;
  }
  return sum;
}

fn sample_map(p: vec2<f32>) -> vec2<f32> {
  let a = params.map[0];
  let b = params.map[1];
  let c = params.map[2];
  let v = (p - a.xy) * a.z;
  let phi = b.x * turbulence(v, b.w, c.x, b.z, b.y, u32(c.y));
  return p + rounded2(a.w * vec2<f32>(-sin(phi), cos(phi)));
}
`;

/** The Crystalize shader's sample map, with its permutation tables. */
export function crystalizeSampleMapWgsl(): string {
  return `${permutationTablesWgsl()}\n${CRYSTAL_SAMPLE_MAP_WGSL}`;
}

/** The Dents shader's sample map, with its permutation tables. */
export function dentsSampleMapWgsl(): string {
  return `${permutationTablesWgsl()}\n${DENTS_SAMPLE_MAP_WGSL}`;
}

const ENGINE_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  samples: u32,
  edge: u32,
  map: array<vec4<f32>, 3>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> offsets: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

// \`rounded\` returns its argument rounded to f32 on its own, as Rust rounds every operation. Without
// it, a shader compiler may fuse a * b + c into one multiply-add or reorder a sum, which can change
// the last bit; sample maps that amplify that bit (a tangent pole, doubled noise coordinates) use it.
// The scene position going in and the sample position coming out are rounded, so no sum is reordered
// across the sample map.
// The bits pass an XOR with a zero the compiler cannot know: Edge Behavior codes are 0 to 3.
fn opaque_zero() -> u32 {
  return params.edge >> 8u;
}

fn rounded(x: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(x) ^ opaque_zero());
}

fn rounded2(x: vec2<f32>) -> vec2<f32> {
  return bitcast<vec2<f32>>(bitcast<vec2<u32>>(x) ^ vec2<u32>(opaque_zero()));
}

fn unpack_texel(index: u32) -> vec4<f32> {
  let word = src[index];
  let alpha = f32(word >> 24u) / 255.0;
  return vec4<f32>(
    f32(word & 0xffu) / 255.0 * alpha,
    f32((word >> 8u) & 0xffu) / 255.0 * alpha,
    f32((word >> 16u) & 0xffu) / 255.0 * alpha,
    alpha,
  );
}

// The index a coordinate reads under the edge mode, or -1 for transparent black.
fn edge_index(index: i32, len: i32, edge: u32) -> i32 {
  if (edge == 0u) {
    return clamp(index, 0, len - 1);
  }
  if (edge == 1u) {
    return ((index % len) + len) % len;
  }
  if (edge == 2u) {
    let period = 2 * len;
    let m = ((index % period) + period) % period;
    if (m >= len) {
      return period - 1 - m;
    }
    return m;
  }
  if (index < 0 || index >= len) {
    return -1;
  }
  return index;
}

fn tap(x: i32, y: i32) -> vec4<f32> {
  let ix = edge_index(x, i32(params.width), params.edge);
  let iy = edge_index(y, i32(params.height), params.edge);
  if (ix < 0 || iy < 0) {
    return vec4<f32>(0.0);
  }
  return unpack_texel(u32(iy) * params.width + u32(ix));
}

fn sample_bilinear(s: vec2<f32>) -> vec4<f32> {
  let u = rounded2(s) - vec2<f32>(0.5);
  let base = floor(u);
  let frac = u - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);
  return tap(x0, y0) * ((1.0 - frac.x) * (1.0 - frac.y))
    + tap(x0 + 1, y0) * (frac.x * (1.0 - frac.y))
    + tap(x0, y0 + 1) * ((1.0 - frac.x) * frac.y)
    + tap(x0 + 1, y0 + 1) * (frac.x * frac.y);
}

fn straight_channel(channel: f32, alpha: f32) -> f32 {
  if (alpha > 0.0) {
    return clamp(channel / alpha, 0.0, 1.0);
  }
  return 0.0;
}

fn to_byte(value: f32) -> u32 {
  return u32(clamp(floor(value * 255.0 + 0.5), 0.0, 255.0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  var acc = vec4<f32>(0.0);
  for (var s = 0u; s < params.samples; s = s + 1u) {
    let shift = offsets[s];
    let scene = rounded2(rounded2(vec2<f32>(f32(id.x), f32(id.y)) + 0.5) + shift);
    acc = acc + sample_bilinear(sample_map(scene));
  }
  let avg = acc / f32(params.samples);
  let alpha = clamp(avg.w, 0.0, 1.0);
  let word = to_byte(straight_channel(avg.x, alpha))
    | (to_byte(straight_channel(avg.y, alpha)) << 8u)
    | (to_byte(straight_channel(avg.z, alpha)) << 16u)
    | (to_byte(alpha) << 24u);
  dst[id.y * params.width + id.x] = word;
}
`;

/**
 * The full distortion shader for one sample map. `sampleMapWgsl` must define
 * `fn sample_map(p: vec2<f32>) -> vec2<f32>` and may read `params.map`.
 */
export function distortionWgsl(sampleMapWgsl: string): string {
  return `${ENGINE_WGSL}\n${sampleMapWgsl}`;
}
