/**
 * WGSL twin of `crates/opaint-cpu/src/adjust.rs` (ADJ-INVCOL, ADJ-INVALPHA, ADJ-BW, ADJ-SEPIA,
 * ADJ-AUTOLEVEL, ADJ-BC, ADJ-HUESAT and ADJ-POSTERIZE). One invocation handles one pixel. The
 * pixels stay packed RGBA8 in a `u32` buffer, so every step is the same integer or f32 math as the
 * Rust reference, in the same order. The sepia exponents, the Auto-Level points, the Brightness /
 * Contrast numbers and the Hue / Saturation numbers come from the Rust exports, so both sides use
 * the same f32 values.
 *
 * `op` selects the adjustment: 0 Invert Colors, 1 Invert Alpha, 2 Black and White, 3 Sepia,
 * 4 Levels (the Levels transform with the planned points, also used by Auto-Level), 5 Brightness / Contrast,
 * 6 Hue / Saturation, 7 Posterize, 8 Curves (luminosity), 9 Curves (RGB). The Curves tables come
 * from the Rust `curve_lut` export, and they are read from the `curves` array of `Params`.
 * 10 Exposure and 11 Temperature / Tint (both multiply the linear-light channels by `gains`), and
 * 12 Highlights / Shadows, which reads the blurred luma that the two blur entry points write
 * (`luma_blur_horizontal`, then `luma_blur_vertical`). The blur weights come from the Rust
 * `gaussian_kernel` export, and `width` and `tone.w` (the blur radius in taps) describe the layer.
 *
 * `ADJUST_PIXEL_WGSL` holds the per-pixel part: the `AdjustParams` struct and `adjust_rgba`, which
 * reads its parameters from a module-scope `p: AdjustParams` that the including shader declares.
 * The engine's compositor includes it to show a live filter over a layer (FX-FW-PREVIEW-01).
 */
export const ADJUST_PIXEL_WGSL = /* wgsl */ `
struct AdjustParams {
  pixel_count: u32,
  row_stride: u32,
  op: u32,
  width: u32,
  exponents: vec4<f32>,
  levels_low: vec4<f32>,
  levels_high: vec4<f32>,
  levels_gamma: vec4<f32>,
  levels_out_low: vec4<f32>,
  levels_out_high: vec4<f32>,
  bc: vec4<f32>,
  hue_saturation: vec4<f32>,
  posterize: vec4<f32>,
  gains: vec4<f32>,
  tone: vec4<f32>,
  weights: array<vec4<f32>, 32>,
  curves: array<vec4<f32>, 1024>,
};

fn unit_u8(v: f32) -> u32 {
  return u32(clamp(floor(255.0 * clamp(v, 0.0, 1.0) + 0.5), 0.0, 255.0));
}

fn sepia_tone(gray: f32, exponent: f32) -> u32 {
  var v = 0.0;
  if (gray > 0.0) {
    v = pow(gray, exponent);
  }
  return unit_u8(v);
}

fn levels_u8(c: u32, low: f32, high: f32, gamma: f32, out_low: f32, out_high: f32) -> u32 {
  let v = f32(c) / 255.0;
  var out = out_low;
  if (v < low) {
    out = out_low;
  } else if (v >= high) {
    out = out_high;
  } else {
    let base = (v - low) / (high - low);
    var t = 0.0;
    if (base > 0.0) {
      t = pow(base, gamma);
    }
    out = out_low + (out_high - out_low) * t;
  }
  return unit_u8(out);
}

fn posterize_u8(c: u32, levels: f32) -> u32 {
  if (levels == 0.0) {
    return c;
  }
  let steps = levels - 1.0;
  let v = f32(c) / 255.0;
  return unit_u8(floor(v * steps + 0.5) / steps);
}

fn curve_table(table: u32, v: f32) -> f32 {
  let pos = clamp(v, 0.0, 1.0) * 1023.0;
  let i = min(u32(floor(pos)), 1022u);
  let f = pos - f32(i);
  let base = table * 1024u + i;
  let a = p.curves[base >> 2u][base & 3u];
  let b = p.curves[(base + 1u) >> 2u][(base + 1u) & 3u];
  return a + (b - a) * f;
}

fn hue_channel(p: f32, q: f32, t0: f32) -> f32 {
  var t = t0;
  if (t < 0.0) {
    t = t + 1.0;
  }
  if (t > 1.0) {
    t = t - 1.0;
  }
  if (t < 1.0 / 6.0) {
    return p + (q - p) * 6.0 * t;
  }
  if (t < 0.5) {
    return q;
  }
  if (t < 2.0 / 3.0) {
    return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  }
  return p;
}

fn srgb_to_linear(v: f32) -> f32 {
  if (v <= 0.04045) {
    return v / 12.92;
  }
  return pow((v + 0.055) / 1.055, 2.4);
}

fn linear_to_srgb(v: f32) -> f32 {
  if (v <= 0.0031308) {
    return v * 12.92;
  }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

fn linear_gain_u8(c: u32, gain: f32) -> u32 {
  return unit_u8(linear_to_srgb(clamp(srgb_to_linear(f32(c) / 255.0) * gain, 0.0, 1.0)));
}

fn pull_into_range(c0: vec3<f32>, aim: f32) -> vec3<f32> {
  var c = c0;
  let lo = min(c.x, min(c.y, c.z));
  if (lo < 0.0) {
    c = aim + (c - aim) * aim / (aim - lo);
  }
  let hi = max(c.x, max(c.y, c.z));
  if (hi > 1.0) {
    c = aim + (c - aim) * (1.0 - aim) / (hi - aim);
  }
  return c;
}

fn smooth_unit(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn tone_luma(y: f32, m: f32) -> f32 {
  let s = 1.0 - smooth_unit(0.0, 0.5, m);
  let shadow_weight = s * s;
  let h = smooth_unit(0.5, 1.0, m);
  let highlight_weight = h * h;
  let highlights = p.tone.x;
  let shadows = p.tone.y;
  let clarity = p.tone.z;
  var shadow_term = y * y;
  if (shadows > 0.0) {
    shadow_term = (1.0 - y) * y;
  }
  var highlight_term = y * (1.0 - y);
  if (highlights > 0.0) {
    highlight_term = (1.0 - y) * (1.0 - y);
  }
  let y1 = y + shadows * shadow_weight * shadow_term + highlights * highlight_weight * highlight_term;
  let y2 = y1 + clarity * 0.5 * (y1 - m) * 4.0 * m * (1.0 - m);
  return clamp(y2, 0.0, 1.0);
}

fn rgb_to_hsl(c: vec3<f32>) -> vec3<f32> {
  let mx = max(c.x, max(c.y, c.z));
  let mn = min(c.x, min(c.y, c.z));
  let l = (mx + mn) * 0.5;
  let d = mx - mn;
  if (d == 0.0) {
    return vec3<f32>(0.0, 0.0, l);
  }
  var s = d / (mx + mn);
  if (l > 0.5) {
    s = d / (2.0 - mx - mn);
  }
  var h = 0.0;
  if (mx == c.x) {
    h = (c.y - c.z) / d;
    if (c.y < c.z) {
      h = h + 6.0;
    }
  } else if (mx == c.y) {
    h = (c.z - c.x) / d + 2.0;
  } else {
    h = (c.x - c.y) / d + 4.0;
  }
  return vec3<f32>(h / 6.0, s, l);
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> vec3<f32> {
  if (s == 0.0) {
    return vec3<f32>(l, l, l);
  }
  var q = l + s - l * s;
  if (l < 0.5) {
    q = l * (1.0 + s);
  }
  let p = 2.0 * l - q;
  return vec3<f32>(
    hue_channel(p, q, h + 1.0 / 3.0),
    hue_channel(p, q, h),
    hue_channel(p, q, h - 1.0 / 3.0),
  );
}

// One pixel through the adjustment \`p.op\`. \`blurred_luma\` is the blurred luma of the pixel, which
// only Highlights / Shadows (op 12) reads.
fn adjust_rgba(pixel: vec4<u32>, blurred_luma: f32) -> vec4<u32> {
  var r = pixel.x;
  var g = pixel.y;
  var b = pixel.z;
  var a = pixel.w;
  if (p.op == 0u) {
    r = 255u - r;
    g = 255u - g;
    b = 255u - b;
  } else if (p.op == 1u) {
    a = 255u - a;
  } else if (p.op == 4u) {
    r = levels_u8(r, p.levels_low.x, p.levels_high.x, p.levels_gamma.x, p.levels_out_low.x, p.levels_out_high.x);
    g = levels_u8(g, p.levels_low.y, p.levels_high.y, p.levels_gamma.y, p.levels_out_low.y, p.levels_out_high.y);
    b = levels_u8(b, p.levels_low.z, p.levels_high.z, p.levels_gamma.z, p.levels_out_low.z, p.levels_out_high.z);
  } else if (p.op == 6u) {
    let hsl = rgb_to_hsl(vec3<f32>(f32(r), f32(g), f32(b)) / 255.0);
    var h = hsl.x + p.hue_saturation.x;
    h = h - floor(h);
    let s = clamp(hsl.y * p.hue_saturation.y, 0.0, 1.0);
    let shifted = hsl_to_rgb(h, s, hsl.z);
    let weight = p.hue_saturation.z;
    let goal = p.hue_saturation.w;
    r = unit_u8(shifted.x + (goal - shifted.x) * weight);
    g = unit_u8(shifted.y + (goal - shifted.y) * weight);
    b = unit_u8(shifted.z + (goal - shifted.z) * weight);
  } else if (p.op == 7u) {
    r = posterize_u8(r, p.posterize.x);
    g = posterize_u8(g, p.posterize.y);
    b = posterize_u8(b, p.posterize.z);
    a = posterize_u8(a, p.posterize.w);
  } else if (p.op == 8u) {
    let rf = f32(r) / 255.0;
    let gf = f32(g) / 255.0;
    let bf = f32(b) / 255.0;
    let y = 0.299 * rf + 0.587 * gf + 0.114 * bf;
    let aim = curve_table(0u, y);
    let delta = aim - y;
    var cr = rf + delta;
    var cg = gf + delta;
    var cb = bf + delta;
    let lo = min(cr, min(cg, cb));
    if (lo < 0.0) {
      cr = aim + (cr - aim) * aim / (aim - lo);
      cg = aim + (cg - aim) * aim / (aim - lo);
      cb = aim + (cb - aim) * aim / (aim - lo);
    }
    let hi = max(cr, max(cg, cb));
    if (hi > 1.0) {
      cr = aim + (cr - aim) * (1.0 - aim) / (hi - aim);
      cg = aim + (cg - aim) * (1.0 - aim) / (hi - aim);
      cb = aim + (cb - aim) * (1.0 - aim) / (hi - aim);
    }
    r = unit_u8(cr);
    g = unit_u8(cg);
    b = unit_u8(cb);
  } else if (p.op == 9u) {
    r = unit_u8(curve_table(1u, f32(r) / 255.0));
    g = unit_u8(curve_table(2u, f32(g) / 255.0));
    b = unit_u8(curve_table(3u, f32(b) / 255.0));
  } else if (p.op == 10u || p.op == 11u) {
    r = linear_gain_u8(r, p.gains.x);
    g = linear_gain_u8(g, p.gains.y);
    b = linear_gain_u8(b, p.gains.z);
  } else if (p.op == 12u) {
    let rf = f32(r) / 255.0;
    let gf = f32(g) / 255.0;
    let bf = f32(b) / 255.0;
    let y = 0.299 * rf + 0.587 * gf + 0.114 * bf;
    let aim = srgb_to_linear(tone_luma(y, blurred_luma));
    let delta = aim - srgb_to_linear(y);
    let c = pull_into_range(
      vec3<f32>(srgb_to_linear(rf), srgb_to_linear(gf), srgb_to_linear(bf)) + vec3<f32>(delta),
      aim,
    );
    r = unit_u8(linear_to_srgb(clamp(c.x, 0.0, 1.0)));
    g = unit_u8(linear_to_srgb(clamp(c.y, 0.0, 1.0)));
    b = unit_u8(linear_to_srgb(clamp(c.z, 0.0, 1.0)));
  } else if (p.op == 5u) {
    let rf = f32(r) / 255.0;
    let gf = f32(g) / 255.0;
    let bf = f32(b) / 255.0;
    let y = 0.299 * rf + 0.587 * gf + 0.114 * bf;
    let bright = p.bc.x;
    let mul_factor = p.bc.y;
    let div_factor = p.bc.z;
    if (div_factor == 0.0) {
      var gray = 0u;
      if (y + bright >= 0.5) {
        gray = 255u;
      }
      r = gray;
      g = gray;
      b = gray;
    } else {
      var pre = bright;
      var post = 0.0;
      if (div_factor == 100.0) {
        pre = 0.0;
        post = bright;
      }
      let shift = ((y - 0.5 + pre) * mul_factor / div_factor) + (0.5 - y + post);
      r = unit_u8(rf + shift);
      g = unit_u8(gf + shift);
      b = unit_u8(bf + shift);
    }
  } else {
    let y = (19595u * r + 38470u * g + 7471u * b) >> 16u;
    if (p.op == 2u) {
      r = y;
      g = y;
      b = y;
    } else {
      let gray = f32(y) / 255.0;
      r = sepia_tone(gray, p.exponents.x);
      g = sepia_tone(gray, p.exponents.y);
      b = sepia_tone(gray, p.exponents.z);
    }
  }
  return vec4<u32>(r, g, b, a);
}
`;

export const ADJUSTMENTS_WGSL = /* wgsl */ `
${ADJUST_PIXEL_WGSL}
@group(0) @binding(0) var<uniform> p: AdjustParams;
@group(0) @binding(1) var<storage, read_write> pixels: array<u32>;
@group(0) @binding(2) var<storage, read_write> horizontal: array<f32>;
@group(0) @binding(3) var<storage, read_write> blurred: array<f32>;

fn mirror_index(index: i32, len: i32) -> u32 {
  let period = 2 * len;
  let m = ((index % period) + period) % period;
  if (m >= len) {
    return u32(period - 1 - m);
  }
  return u32(m);
}

fn luma_at(index: u32) -> f32 {
  let word = pixels[index];
  let r = f32(word & 255u) / 255.0;
  let g = f32((word >> 8u) & 255u) / 255.0;
  let b = f32((word >> 16u) & 255u) / 255.0;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

fn blur_weight(k: i32) -> f32 {
  let i = u32(k);
  return p.weights[i >> 2u][i & 3u];
}

@compute @workgroup_size(256)
fn luma_blur_horizontal(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = gid.x + gid.y * p.row_stride;
  if (index >= p.pixel_count) {
    return;
  }
  let width = i32(p.width);
  let x = i32(index % p.width);
  let row = index - u32(x);
  let taps = i32(p.tone.w);
  var sum = 0.0;
  for (var k = 0; k <= 2 * taps; k = k + 1) {
    let sx = mirror_index(x + k - taps, width);
    sum = sum + blur_weight(k) * luma_at(row + sx);
  }
  horizontal[index] = sum;
}

@compute @workgroup_size(256)
fn luma_blur_vertical(@builtin(global_invocation_id) gid: vec3<u32>) {
  let index = gid.x + gid.y * p.row_stride;
  if (index >= p.pixel_count) {
    return;
  }
  let width = p.width;
  let height = i32(p.pixel_count / width);
  let x = index % width;
  let y = i32(index / width);
  let taps = i32(p.tone.w);
  var sum = 0.0;
  for (var k = 0; k <= 2 * taps; k = k + 1) {
    let sy = mirror_index(y + k - taps, height);
    sum = sum + blur_weight(k) * horizontal[sy * width + x];
  }
  blurred[index] = sum;
}

@compute @workgroup_size(256)
fn adjust(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pixel_index = gid.x + gid.y * p.row_stride;
  if (pixel_index >= p.pixel_count) {
    return;
  }
  let word = pixels[pixel_index];
  var blurred_luma = 0.0;
  if (p.op == 12u) {
    blurred_luma = blurred[pixel_index];
  }
  let out = adjust_rgba(
    vec4<u32>(word & 255u, (word >> 8u) & 255u, (word >> 16u) & 255u, word >> 24u),
    blurred_luma,
  );
  pixels[pixel_index] = out.x | (out.y << 8u) | (out.z << 16u) | (out.w << 24u);
}
`;
