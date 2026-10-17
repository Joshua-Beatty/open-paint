import { MIX_WGSL } from "./mix-wgsl";

/** Bytes of the `Params` uniform of the Clouds shader. */
export const CLOUDS_PARAMS_BYTES = 80;

/**
 * WGSL twin of `crates/opaint-cpu/src/clouds.rs` (FX-RENDER-CLOUDS-01): one pass that evaluates the
 * summed Perlin noise of each pixel, maps it between the two colors, and composites it onto the source
 * with the blend mode. The permutation table comes from Rust, and the blend from `mix-wgsl.ts`.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed
 * RGBA8 `u32` words, 3 the permutation table as `u32` values. `doc_width` and `doc_height` are the
 * document size, and `origin_x` and `origin_y` place the region in the document.
 */
export const CLOUDS_WGSL = /* wgsl */ `
${MIX_WGSL}

struct Params {
  width: u32,
  height: u32,
  origin_x: u32,
  origin_y: u32,
  doc_width: i32,
  doc_height: i32,
  scale: i32,
  seed: i32,
  roughness: f32,
  mode: u32,
  pad0: u32,
  pad1: u32,
  color1: vec4<f32>,
  color2: vec4<f32>,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> permutation: array<u32>;

fn perm_at(i: i32) -> i32 {
  return i32(permutation[u32(i & 255)]);
}

fn lattice_hash(ix: i32, iy: i32, seed: i32) -> i32 {
  return perm_at((perm_at((ix ^ seed) & 255) + iy) & 255);
}

fn gradient_dot(h: i32, x: f32, y: f32) -> f32 {
  let h4 = h & 15;
  var u = y;
  if (h4 < 8) {
    u = x;
  }
  var v = 0.0;
  if (h4 < 4) {
    v = y;
  } else if (h4 == 12 || h4 == 14) {
    v = x;
  }
  var a = u;
  if ((h & 1) != 0) {
    a = -u;
  }
  var b = v;
  if ((h & 2) != 0) {
    b = -v;
  }
  return a + b;
}

fn clouds_fade(t: f32) -> f32 {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn clouds_lerp(t: f32, a: f32, b: f32) -> f32 {
  return a + t * (b - a);
}

fn cloud_noise(ix: i32, iy: i32, fx: f32, fy: f32, seed: i32) -> f32 {
  let u = clouds_fade(fx);
  let v = clouds_fade(fy);
  let g00 = gradient_dot(lattice_hash(ix, iy, seed), fx, fy);
  let g10 = gradient_dot(lattice_hash(ix + 1, iy, seed), fx - 1.0, fy);
  let g01 = gradient_dot(lattice_hash(ix, iy + 1, seed), fx, fy - 1.0);
  let g11 = gradient_dot(lattice_hash(ix + 1, iy + 1, seed), fx - 1.0, fy - 1.0);
  return clouds_lerp(v, clouds_lerp(u, g00, g10), clouds_lerp(u, g01, g11));
}

fn floor_div(a: i32, b: i32) -> i32 {
  let q = a / b;
  if (a % b != 0 && a < 0) {
    return q - 1;
  }
  return q;
}

fn euclid_rem(a: i32, b: i32) -> i32 {
  let r = a % b;
  if (r < 0) {
    return r + b;
  }
  return r;
}

fn cloud_value(dx: i32, dy: i32) -> f32 {
  var value = 0.0;
  var mult = 1.0;
  var div = p.scale;
  for (var i = 0; i < 12; i++) {
    if (!(mult > 0.03 && div > 0)) {
      break;
    }
    let qx = floor_div(dx, div);
    let qy = floor_div(dy, div);
    let fx = f32(euclid_rem(dx, div)) / f32(div);
    let fy = f32(euclid_rem(dy, div)) / f32(div);
    value = value + cloud_noise(qx & 255, qy & 255, fx, fy, (p.seed + i) & 255) * mult;
    div = div / 2;
    mult = mult * p.roughness;
  }
  return value;
}

@compute @workgroup_size(8, 8)
fn clouds(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let dx = 2 * i32(p.origin_x + id.x) - p.doc_width;
  let dy = 2 * i32(p.origin_y + id.y) - p.doc_height;
  let t = clamp((cloud_value(dx, dy) + 1.0) / 2.0, 0.0, 1.0);
  let generated = p.color1 + (p.color2 - p.color1) * t;
  dst[i] = mix_pack(mix_pixel(p.mode, mix_unpack(src[i]), generated, id.x, id.y));
}
`;
