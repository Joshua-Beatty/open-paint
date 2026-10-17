import { MIX_WGSL } from "./mix-wgsl";

/** Bytes of the `Params` uniform of the fractal shaders. */
export const FRACTAL_PARAMS_BYTES = 64;

/**
 * WGSL twin of `crates/opaint-cpu/src/fractal.rs` (FX-RENDER-JULIA-01, FX-RENDER-MANDEL-01): one
 * compute entry point per fractal. Each pixel averages its rotated-grid samples in premultiplied form,
 * rounds the average to 16-bit steps as the Rust intermediate target does, unpremultiplies it and
 * composites it onto the source with the blend mode.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed
 * RGBA8 `u32` words, 3 the sample offsets from Rust as pairs of `f32`. `doc_width` and `doc_height` are
 * the document size, and `origin_x` and `origin_y` place the region in the document. `invert` is 1 for
 * Mandelbrot's Invert Colors and is ignored by Julia.
 */
export const FRACTAL_WGSL = /* wgsl */ `
${MIX_WGSL}

struct Params {
  width: u32,
  height: u32,
  origin_x: u32,
  origin_y: u32,
  doc_width: f32,
  doc_height: f32,
  factor: f32,
  cos_angle: f32,
  sin_angle: f32,
  inv_height: f32,
  aspect: f32,
  inv_zoom: f32,
  samples: u32,
  mode: u32,
  invert: u32,
  /** Always 0: keeps products from fusing with the adds after them (see \`products2\`). */
  zero: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> sample_offsets: array<f32>;

// Products that are then added, and the first sum of three terms, go through these, so that each is
// rounded on its own as in Rust. A shader compiler may otherwise fuse a * b + c into one
// multiply-add, which rounds once, or reorder a sum; an orbit amplifies that last bit into a
// different escape count. Each value passes through its bits and an XOR with the uniform's 0, which
// the compiler cannot see through, so it must be rounded to f32 first.
fn products2(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return bitcast<vec2<f32>>(bitcast<vec2<u32>>(a * b) ^ vec2<u32>(p.zero));
}

fn rounded(x: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(x) ^ p.zero);
}

fn products4(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return bitcast<vec4<f32>>(bitcast<vec4<u32>>(a * b) ^ vec4<u32>(p.zero));
}

// z.x * z.x, z.y * z.y and 2 * z.x * z.y, each rounded as Rust rounds them.
fn orbit_terms(z: vec2<f32>) -> vec4<f32> {
  return products4(vec4<f32>(z.x, z.y, 2.0 * z.x, 0.0), vec4<f32>(z.x, z.y, z.y, 0.0));
}

fn fractal_view(pos: vec2<f32>) -> vec2<f32> {
  let uv = vec2<f32>((2.0 * pos.x - p.doc_width) * p.inv_height, (2.0 * pos.y - p.doc_height) * p.inv_height);
  let t = products4(uv.xyxy, vec4<f32>(p.cos_angle, p.sin_angle, p.sin_angle, p.cos_angle));
  return vec2<f32>(t.x - t.y, t.z + t.w);
}

fn julia_color(pos: vec2<f32>) -> vec4<f32> {
  let uv = fractal_view(pos);
  let skew = products2(uv.yx, vec2<f32>(p.aspect));
  var z = vec2<f32>((uv.x - skew.x) * p.inv_zoom, (uv.y + skew.y) * p.inv_zoom);
  var n = 0u;
  var t = orbit_terms(z);
  while (n < 256u && t.x + t.y < 10000.0) {
    z = vec2<f32>(rounded(t.x - t.y) + 0.3125, t.z + 0.03);
    t = orbit_terms(z);
    n = n + 1u;
  }
  let r2 = t.x + t.y;
  var ln_r2 = 0.0;
  if (r2 > 0.0) {
    ln_r2 = log(r2);
  }
  var smoothed = f32(n);
  if (ln_r2 != 0.0) {
    smoothed = f32(n) - (2.0 - 2.0 * 9.21034 / ln_r2);
  }
  let v = p.factor * smoothed / 256.0;
  return clamp(vec4<f32>(v - 1.0, v - 2.0, v - 3.0, v), vec4<f32>(0.0), vec4<f32>(1.0));
}

fn mandelbrot_color(pos: vec2<f32>) -> vec4<f32> {
  let uv = fractal_view(pos);
  let c = products2(uv, vec2<f32>(p.inv_zoom)) + vec2<f32>(-0.7, -0.29);
  var z = vec2<f32>(0.0, 0.0);
  var n = 0u;
  var t = orbit_terms(z);
  while (f32(n) * p.factor < 1024.0 && t.x + t.y < 100000.0) {
    z = vec2<f32>(rounded(t.x - t.y) + c.x, t.z + c.y);
    t = orbit_terms(z);
    n = n + 1u;
  }
  let r2 = t.x + t.y;
  var ln_r2 = 0.0;
  if (r2 > 0.0) {
    ln_r2 = log(r2);
  }
  let m = f32(n) - ln_r2 / 11.512925;
  let v = (64.0 + p.factor * m) / 256.0;
  var rgba = clamp(vec4<f32>(v - 3.0, v - 2.0, v - 1.0, v), vec4<f32>(0.0), vec4<f32>(1.0));
  if (p.invert == 1u) {
    rgba = vec4<f32>(1.0 - rgba.x, 1.0 - rgba.y, 1.0 - rgba.z, rgba.w);
  }
  return rgba;
}

fn fractal_pixel(id: vec3<u32>, kind: u32) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  var sum = vec4<f32>(0.0);
  for (var s = 0u; s < p.samples; s = s + 1u) {
    let pos = vec2<f32>(
      rounded(rounded(f32(p.origin_x + id.x) + 0.5) + sample_offsets[2u * s]),
      rounded(rounded(f32(p.origin_y + id.y) + 0.5) + sample_offsets[2u * s + 1u]),
    );
    var c = vec4<f32>(0.0);
    if (kind == 0u) {
      c = julia_color(pos);
    } else {
      c = mandelbrot_color(pos);
    }
    sum = sum + vec4<f32>(c.x * c.w, c.y * c.w, c.z * c.w, c.w);
  }
  let avg = sum / f32(p.samples);
  let q = vec4<u32>(floor(clamp(avg, vec4<f32>(0.0), vec4<f32>(1.0)) * 65535.0 + vec4<f32>(0.5)));
  let alpha = f32(q.w) / 65535.0;
  var straight = vec4<f32>(0.0);
  if (q.w != 0u) {
    straight = vec4<f32>(
      clamp((f32(q.x) / 65535.0) / alpha, 0.0, 1.0),
      clamp((f32(q.y) / 65535.0) / alpha, 0.0, 1.0),
      clamp((f32(q.z) / 65535.0) / alpha, 0.0, 1.0),
      alpha,
    );
  }
  let i = id.y * p.width + id.x;
  dst[i] = mix_pack(mix_pixel(p.mode, mix_unpack(src[i]), straight, id.x, id.y));
}

@compute @workgroup_size(8, 8)
fn julia(@builtin(global_invocation_id) id: vec3<u32>) {
  fractal_pixel(id, 0u);
}

@compute @workgroup_size(8, 8)
fn mandelbrot(@builtin(global_invocation_id) id: vec3<u32>) {
  fractal_pixel(id, 1u);
}
`;
