/**
 * The WGSL pieces that the artistic shaders share (FX-ART-INK, FX-ART-OIL, FX-ART-PENCIL). Each
 * helper mirrors one step of `crates/opaint-cpu/src/artistic.rs` or `blur.rs`, so the GPU and the
 * Rust reference compute the same numbers in the same order.
 */

/** Bytes of the `Params` uniform shared by the artistic shaders (eight 4-byte fields). */
export const ARTISTIC_PARAMS_BYTES = 32;

/**
 * The `Params` uniform. `width` and `height` give the image size. `f0` to `f2`, `i0` and `u0` to `u1`
 * are per-effect values, documented in the shader that reads them.
 */
export const ARTISTIC_PARAMS_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  f0: f32,
  f1: f32,
  f2: f32,
  i0: i32,
  u0: u32,
  u1: u32,
};
`;

/** The shared functions: channel unpacking, 8-bit rounding, the sRGB transfer, mirror and Brightness / Contrast. */
export const ARTISTIC_HELPERS_WGSL = /* wgsl */ `
fn channel(word: u32, c: u32) -> f32 {
  return f32((word >> (8u * c)) & 255u) / 255.0;
}

fn to_u8(v: f32) -> u32 {
  return u32(floor(255.0 * clamp(v, 0.0, 1.0) + 0.5));
}

fn pack_rgba(r: u32, g: u32, b: u32, a: u32) -> u32 {
  return r | (g << 8u) | (b << 16u) | (a << 24u);
}

fn luma(rgb: vec3<f32>) -> f32 {
  return 0.299 * rgb.x + 0.587 * rgb.y + 0.114 * rgb.z;
}

fn mirror_index(i: i32, n: i32) -> i32 {
  let period = 2 * n;
  var m = i % period;
  if (m < 0) {
    m = m + period;
  }
  if (m >= n) {
    m = period - 1 - m;
  }
  return m;
}

fn to_linear(c: f32) -> f32 {
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return pow((c + 0.055) / 1.055, 2.4);
}

fn to_srgb(v: f32) -> f32 {
  if (v <= 0.0031308) {
    return v * 12.92;
  }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

fn brightness_contrast(rgb: vec3<f32>, bright: f32, mul: f32, div: f32) -> vec3<f32> {
  let y = luma(rgb);
  if (div == 0.0) {
    var gray = 0.0;
    if (y + bright >= 0.5) {
      gray = 1.0;
    }
    return vec3<f32>(gray, gray, gray);
  }
  var pre = bright;
  var post = 0.0;
  if (div == 100.0) {
    pre = 0.0;
    post = bright;
  }
  let shift = ((y - 0.5 + pre) * mul / div) + (0.5 - y + post);
  return clamp(rgb + vec3<f32>(shift, shift, shift), vec3<f32>(0.0), vec3<f32>(1.0));
}
`;
