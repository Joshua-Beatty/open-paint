import { ARTISTIC_HELPERS_WGSL } from "./artistic-wgsl-common";

/** Bytes of the `Params` uniform of the Straighten shader (a 16-byte-aligned struct). */
export const STRAIGHTEN_PARAMS_BYTES = 48;

/**
 * WGSL twin of `straighten_rgba8` in `crates/opaint-cpu/src/photo.rs`, which resamples through
 * `transform_rgba8` in linear light. One entry point maps each destination pixel through the matrix
 * from `straighten_matrix` and samples the premultiplied linear source. Bindings: 0 `Params`
 * (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed RGBA8 `u32` words.
 * The sampling codes are Bicubic (0, Catmull-Rom), Bilinear (1) and Nearest Neighbor (2).
 */
export const STRAIGHTEN_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  sampling: u32,
  pad: u32,
  m: vec4<f32>,
  t: vec2<f32>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

${ARTISTIC_HELPERS_WGSL}

fn unpack_linear(word: u32) -> vec4<f32> {
  let alpha = f32(word >> 24u) / 255.0;
  return vec4<f32>(
    to_linear(channel(word, 0u)) * alpha,
    to_linear(channel(word, 1u)) * alpha,
    to_linear(channel(word, 2u)) * alpha,
    alpha,
  );
}

// A premultiplied linear texel of the source, zero outside the image.
fn texel(x: i32, y: i32) -> vec4<f32> {
  if (x < 0 || y < 0 || x >= i32(params.width) || y >= i32(params.height)) {
    return vec4<f32>(0.0);
  }
  return unpack_linear(src[u32(y) * params.width + u32(x)]);
}

fn catmull_weights(t: f32) -> vec4<f32> {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4<f32>(
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2,
  );
}

fn sample_nearest(p: vec2<f32>) -> vec4<f32> {
  return texel(i32(floor(p.x)), i32(floor(p.y)));
}

fn sample_linear(p: vec2<f32>) -> vec4<f32> {
  let f = p - vec2<f32>(0.5);
  let base = floor(f);
  let t = f - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);
  var acc = texel(x0, y0) * ((1.0 - t.x) * (1.0 - t.y));
  acc = acc + texel(x0 + 1, y0) * (t.x * (1.0 - t.y));
  acc = acc + texel(x0, y0 + 1) * ((1.0 - t.x) * t.y);
  acc = acc + texel(x0 + 1, y0 + 1) * (t.x * t.y);
  return acc;
}

fn sample_cubic(p: vec2<f32>) -> vec4<f32> {
  let f = p - vec2<f32>(0.5);
  let base = floor(f);
  let t = f - base;
  let wx = catmull_weights(t.x);
  let wy = catmull_weights(t.y);
  let x0 = i32(base.x) - 1;
  let y0 = i32(base.y) - 1;
  var acc = vec4<f32>(0.0);
  for (var j = 0; j < 4; j = j + 1) {
    for (var i = 0; i < 4; i = i + 1) {
      acc = acc + texel(x0 + i, y0 + j) * (wx[i] * wy[j]);
    }
  }
  // Catmull-Rom overshoots: an alpha above one is scaled down with the color, and each
  // premultiplied channel is kept inside [0, alpha].
  if (acc.w <= 0.0) {
    return vec4<f32>(0.0);
  }
  if (acc.w > 1.0) {
    acc = acc / acc.w;
  }
  let alpha = acc.w;
  return vec4<f32>(clamp(acc.xyz, vec3<f32>(0.0), vec3<f32>(alpha)), alpha);
}

// Unpremultiplies, encodes the color as sRGB and rounds to 8 bits, as transform::encode does.
fn encode_pixel(color: vec4<f32>) -> u32 {
  let alpha = clamp(color.w, 0.0, 1.0);
  if (alpha <= 0.0) {
    return 0u;
  }
  return pack_rgba(
    to_u8(to_srgb(clamp(color.x / alpha, 0.0, 1.0))),
    to_u8(to_srgb(clamp(color.y / alpha, 0.0, 1.0))),
    to_u8(to_srgb(clamp(color.z / alpha, 0.0, 1.0))),
    to_u8(alpha),
  );
}

@compute @workgroup_size(8, 8)
fn straighten(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  let cx = f32(id.x) + 0.5;
  let cy = f32(id.y) + 0.5;
  let s = vec2<f32>(
    params.m.x * cx + params.m.z * cy + params.t.x,
    params.m.y * cx + params.m.w * cy + params.t.y,
  );
  var color = vec4<f32>(0.0);
  if (params.sampling == 0u) {
    color = sample_cubic(s);
  } else if (params.sampling == 1u) {
    color = sample_linear(s);
  } else {
    color = sample_nearest(s);
  }
  dst[id.y * params.width + id.x] = encode_pixel(color);
}
`;
