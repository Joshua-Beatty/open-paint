import { MIX_WGSL } from "./mix-wgsl";

/** Bytes of the `Params` uniform of the Turbulence shader. */
export const TURBULENCE_PARAMS_BYTES = 64;

/**
 * WGSL twin of `crates/opaint-cpu/src/turbulence.rs` (FX-RENDER-TURB-01): the SVG `feTurbulence`
 * noise of each pixel, with stitched tiles, composited onto the source with the blend mode. The lattice
 * and gradient tables and the base frequencies and stitch values come from Rust, so only the octave
 * arithmetic runs here, in the same order as the reference.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed
 * RGBA8 `u32` words, 3 the lattice selector (`u32`, 514 entries), 4 the gradients (`f32`, 4 channels x
 * 514 entries x 2 components).
 */
export const TURBULENCE_WGSL = /* wgsl */ `
${MIX_WGSL}

struct Params {
  width: u32,
  height: u32,
  origin_x: u32,
  origin_y: u32,
  tile: u32,
  octaves: u32,
  fractal: u32,
  mode: u32,
  freq_x: f32,
  freq_y: f32,
  stitch_width: i32,
  stitch_wrap_x: i32,
  stitch_height: i32,
  stitch_wrap_y: i32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> lattice: array<u32>;
@group(0) @binding(4) var<storage, read> gradients: array<f32>;

fn turb_s_curve(t: f32) -> f32 {
  return t * t * (3.0 - 2.0 * t);
}

fn turb_lerp(t: f32, a: f32, b: f32) -> f32 {
  return a + t * (b - a);
}

fn turb_gradient(channel: u32, b: u32) -> vec2<f32> {
  let k = (channel * 514u + b) * 2u;
  return vec2<f32>(gradients[k], gradients[k + 1u]);
}

fn turb_noise(channel: u32, vx: f32, vy: f32, st_w: i32, st_wrap_x: i32, st_h: i32, st_wrap_y: i32) -> f32 {
  let tx = vx + 4096.0;
  let ty = vy + 4096.0;
  var bx0 = i32(tx);
  var bx1 = bx0 + 1;
  let rx0 = tx - f32(bx0);
  let rx1 = rx0 - 1.0;
  var by0 = i32(ty);
  var by1 = by0 + 1;
  let ry0 = ty - f32(by0);
  let ry1 = ry0 - 1.0;
  if (bx0 >= st_wrap_x) {
    bx0 = bx0 - st_w;
  }
  if (bx1 >= st_wrap_x) {
    bx1 = bx1 - st_w;
  }
  if (by0 >= st_wrap_y) {
    by0 = by0 - st_h;
  }
  if (by1 >= st_wrap_y) {
    by1 = by1 - st_h;
  }
  let i = lattice[u32(bx0 & 255)];
  let j = lattice[u32(bx1 & 255)];
  let ay0 = u32(by0 & 255);
  let ay1 = u32(by1 & 255);
  let b00 = lattice[i + ay0];
  let b10 = lattice[j + ay0];
  let b01 = lattice[i + ay1];
  let b11 = lattice[j + ay1];
  let sx = turb_s_curve(rx0);
  let sy = turb_s_curve(ry0);
  let q00 = turb_gradient(channel, b00);
  let u0 = rx0 * q00.x + ry0 * q00.y;
  let q10 = turb_gradient(channel, b10);
  let v0 = rx1 * q10.x + ry0 * q10.y;
  let top = turb_lerp(sx, u0, v0);
  let q01 = turb_gradient(channel, b01);
  let u1 = rx0 * q01.x + ry1 * q01.y;
  let q11 = turb_gradient(channel, b11);
  let v1 = rx1 * q11.x + ry1 * q11.y;
  let bottom = turb_lerp(sx, u1, v1);
  return turb_lerp(sy, top, bottom);
}

fn turb_sum(channel: u32, px: f32, py: f32) -> f32 {
  var vx = px * p.freq_x;
  var vy = py * p.freq_y;
  var st_w = p.stitch_width;
  var st_wx = p.stitch_wrap_x;
  var st_h = p.stitch_height;
  var st_wy = p.stitch_wrap_y;
  var sum = 0.0;
  var ratio = 1.0;
  for (var o = 0u; o < p.octaves; o++) {
    let n = turb_noise(channel, vx, vy, st_w, st_wx, st_h, st_wy);
    if (p.fractal == 1u) {
      sum = sum + n / ratio;
    } else {
      sum = sum + abs(n) / ratio;
    }
    vx = vx * 2.0;
    vy = vy * 2.0;
    ratio = ratio * 2.0;
    st_w = st_w * 2;
    st_wx = 2 * st_wx - 4096;
    st_h = st_h * 2;
    st_wy = 2 * st_wy - 4096;
  }
  return sum;
}

fn turb_channel(channel: u32, px: f32, py: f32) -> f32 {
  let sum = turb_sum(channel, px, py);
  var v = sum;
  if (p.fractal == 1u) {
    v = (sum + 1.0) / 2.0;
  }
  return clamp(v, 0.0, 1.0);
}

@compute @workgroup_size(8, 8)
fn turbulence(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let px = f32((p.origin_x + id.x) % p.tile);
  let py = f32((p.origin_y + id.y) % p.tile);
  let generated = vec4<f32>(
    turb_channel(0u, px, py),
    turb_channel(1u, px, py),
    turb_channel(2u, px, py),
    turb_channel(3u, px, py),
  );
  dst[i] = mix_pack(mix_pixel(p.mode, mix_unpack(src[i]), generated, id.x, id.y));
}
`;
