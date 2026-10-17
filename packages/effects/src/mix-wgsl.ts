/**
 * WGSL twin of `crates/opaint-cpu/src/mix.rs` (FX-SHARED-MIXMODE): the 46 render blend modes, as a snippet
 * that a render shader includes. `mix_pixel` composites one generated pixel onto the layer pixel with
 * the mode code, in the same expression order as the Rust reference, so the two agree to within one
 * 8-bit step. Mode codes are the `MIX_MODE_KEYS` indices. The snippet has no bindings of its own.
 */
export const MIX_WGSL = /* wgsl */ `
fn mix_unpack(word: u32) -> vec4<f32> {
  return vec4<f32>(
    f32(word & 0xffu),
    f32((word >> 8u) & 0xffu),
    f32((word >> 16u) & 0xffu),
    f32(word >> 24u),
  ) / 255.0;
}

fn mix_pack(c: vec4<f32>) -> u32 {
  let v = floor(clamp(c, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0 + vec4<f32>(0.5));
  return u32(v.x) | (u32(v.y) << 8u) | (u32(v.z) << 16u) | (u32(v.w) << 24u);
}

fn dissolve_threshold(x: u32, y: u32) -> f32 {
  var h = (x * 0x9E3779B1u) ^ ((y * 0x85EBCA77u) + 0x632BE5ABu);
  h = h ^ (h >> 16u);
  h = h * 0x7FEB352Du;
  h = h ^ (h >> 15u);
  h = h * 0x846CA68Bu;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}

fn mix_screen(d: f32, s: f32) -> f32 {
  return d + s - d * s;
}

fn mix_hard_light(d: f32, s: f32) -> f32 {
  if (s <= 0.5) {
    return d * 2.0 * s;
  }
  return mix_screen(d, 2.0 * s - 1.0);
}

fn mix_soft_light(d: f32, s: f32) -> f32 {
  if (s <= 0.5) {
    return d - (1.0 - 2.0 * s) * d * (1.0 - d);
  }
  var g = sqrt(d);
  if (d <= 0.25) {
    g = ((16.0 * d - 12.0) * d + 4.0) * d;
  }
  return d + (2.0 * s - 1.0) * (g - d);
}

fn mix_color_burn(d: f32, s: f32) -> f32 {
  if (d >= 1.0) {
    return 1.0;
  }
  if (s <= 0.0) {
    return 0.0;
  }
  return 1.0 - min(1.0, (1.0 - d) / s);
}

fn mix_color_dodge(d: f32, s: f32) -> f32 {
  if (d <= 0.0) {
    return 0.0;
  }
  if (s >= 1.0) {
    return 1.0;
  }
  return min(1.0, d / (1.0 - s));
}

fn mix_vivid_light(d: f32, s: f32) -> f32 {
  if (s <= 0.5) {
    return mix_color_burn(d, 2.0 * s);
  }
  return mix_color_dodge(d, 2.0 * s - 1.0);
}

fn mix_separable(mode: u32, d: f32, s: f32) -> f32 {
  switch mode {
    case 3u: { return d * s; }
    case 4u: { return mix_screen(d, s); }
    case 5u, 33u: { return min(d, s); }
    case 6u, 34u: { return max(d, s); }
    case 8u: { return mix_color_burn(d, s); }
    case 9u: { return max(d + s - 1.0, 0.0); }
    case 12u: { return mix_color_dodge(d, s); }
    case 13u, 29u: { return min(d + s, 1.0); }
    case 14u: { return mix_hard_light(s, d); }
    case 15u: { return mix_soft_light(d, s); }
    case 16u: { return mix_hard_light(d, s); }
    case 17u: { return mix_vivid_light(d, s); }
    case 18u: { return clamp(d + 2.0 * s - 1.0, 0.0, 1.0); }
    case 19u: {
      if (s <= 0.5) {
        return min(d, 2.0 * s);
      }
      return max(d, 2.0 * s - 1.0);
    }
    case 20u: {
      if (d + s >= 1.0) {
        return 1.0;
      }
      return 0.0;
    }
    case 21u: { return abs(d - s); }
    case 22u: { return d + s - 2.0 * d * s; }
    case 27u: { return max(d - s, 0.0); }
    case 28u: {
      if (s <= 0.0) {
        return 1.0;
      }
      return min(d / s, 1.0);
    }
    case 30u: {
      if (s >= 1.0) {
        return 1.0;
      }
      return min(d * d / (1.0 - s), 1.0);
    }
    case 31u: {
      if (d >= 1.0) {
        return 1.0;
      }
      return min(s * s / (1.0 - d), 1.0);
    }
    case 32u: { return 1.0 - abs(1.0 - d - s); }
    default: { return d; }
  }
}

fn mix_lum(c: vec3<f32>) -> f32 {
  return 0.3 * c.x + 0.59 * c.y + 0.11 * c.z;
}

fn mix_sat(c: vec3<f32>) -> f32 {
  return max(c.x, max(c.y, c.z)) - min(c.x, min(c.y, c.z));
}

fn mix_clip_color(c_in: vec3<f32>) -> vec3<f32> {
  let l = mix_lum(c_in);
  let n = min(c_in.x, min(c_in.y, c_in.z));
  let x = max(c_in.x, max(c_in.y, c_in.z));
  var c = c_in;
  if (n < 0.0 && l - n > 0.0) {
    c = l + (c - l) * l / (l - n);
  }
  if (x > 1.0 && x - l > 0.0) {
    c = l + (c - l) * (1.0 - l) / (x - l);
  }
  return c;
}

fn mix_set_lum(c: vec3<f32>, l: f32) -> vec3<f32> {
  let d = l - mix_lum(c);
  return mix_clip_color(c + vec3<f32>(d, d, d));
}

fn mix_set_sat(c: vec3<f32>, s: f32) -> vec3<f32> {
  let mx = max(c.x, max(c.y, c.z));
  let mn = min(c.x, min(c.y, c.z));
  if (mx > mn) {
    return (c - vec3<f32>(mn, mn, mn)) * s / (mx - mn);
  }
  return vec3<f32>(0.0);
}

fn mix_non_separable(mode: u32, d: vec3<f32>, s: vec3<f32>) -> vec3<f32> {
  switch mode {
    case 10u: {
      if (mix_lum(s) < mix_lum(d)) {
        return s;
      }
      return d;
    }
    case 11u: {
      if (mix_lum(s) > mix_lum(d)) {
        return s;
      }
      return d;
    }
    case 23u: { return mix_set_lum(mix_set_sat(s, mix_sat(d)), mix_lum(d)); }
    case 24u: { return mix_set_lum(mix_set_sat(d, mix_sat(s)), mix_lum(d)); }
    case 25u: { return mix_set_lum(s, mix_lum(d)); }
    case 26u: { return mix_set_lum(d, mix_lum(s)); }
    default: { return d; }
  }
}

fn mix_xor(d: f32, s: f32, levels: f32) -> f32 {
  let a = u32(floor(d * levels + 0.5));
  let b = u32(floor(s * levels + 0.5));
  return f32(a ^ b) / levels;
}

fn mix_blend(d: vec4<f32>, s: vec4<f32>, bl: vec3<f32>) -> vec4<f32> {
  let sa = s.w;
  let da = d.w;
  let ra = sa + da - sa * da;
  if (ra <= 0.0) {
    return vec4<f32>(0.0);
  }
  let rgb = clamp(((1.0 - sa) * da * d.xyz + (1.0 - da) * sa * s.xyz + sa * da * bl) / ra, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(rgb, clamp(ra, 0.0, 1.0));
}

fn mix_unpremultiply(cp: vec3<f32>, ra: f32) -> vec4<f32> {
  if (ra <= 0.0) {
    return vec4<f32>(0.0);
  }
  return vec4<f32>(clamp(cp / ra, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(ra, 0.0, 1.0));
}

fn mix_under(d: vec4<f32>, s: vec4<f32>) -> vec4<f32> {
  let sa = s.w;
  let da = d.w;
  let ra = da + sa * (1.0 - da);
  if (ra <= 0.0) {
    return vec4<f32>(0.0);
  }
  let rgb = clamp((d.xyz * da + s.xyz * sa * (1.0 - da)) / ra, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(rgb, clamp(ra, 0.0, 1.0));
}

fn mix_porter(mode: u32, d: vec4<f32>, s: vec4<f32>) -> vec4<f32> {
  let sa = s.w;
  let da = d.w;
  let dp = d.xyz * da;
  let sp = s.xyz * sa;
  var cp = dp;
  var ra = da;
  switch mode {
    case 35u: {
      cp = sp * da;
      ra = sa * da;
    }
    case 36u: {
      cp = dp * sa;
      ra = da * sa;
    }
    case 37u: {
      cp = sp * (1.0 - da);
      ra = sa * (1.0 - da);
    }
    case 38u, 42u: {
      cp = dp * (1.0 - sa);
      ra = da * (1.0 - sa);
    }
    case 39u: {
      cp = sp * da + dp * (1.0 - sa);
      ra = sa * da + da * (1.0 - sa);
    }
    case 40u: {
      cp = dp * sa + sp * (1.0 - da);
      ra = da * sa + sa * (1.0 - da);
    }
    case 41u: {
      cp = min(sp + dp, vec3<f32>(1.0));
      ra = min(sa + da, 1.0);
    }
    case 45u: {
      cp = sp * (1.0 - da) + dp * (1.0 - sa);
      ra = sa * (1.0 - da) + da * (1.0 - sa);
    }
    default: {}
  }
  return mix_unpremultiply(cp, ra);
}

fn mix_pixel(mode: u32, d: vec4<f32>, s: vec4<f32>, x: u32, y: u32) -> vec4<f32> {
  if (mode == 0u) {
    return mix_blend(d, s, s.xyz);
  }
  if (mode == 1u) {
    return mix_under(d, s);
  }
  if (mode == 2u) {
    return s;
  }
  if (mode == 7u) {
    var kept = 0.0;
    if (s.w > dissolve_threshold(x, y)) {
      kept = 1.0;
    }
    return mix_blend(d, vec4<f32>(s.xyz, kept), s.xyz);
  }
  if (mode == 10u || mode == 11u || (mode >= 23u && mode <= 26u)) {
    return mix_blend(d, s, mix_non_separable(mode, d.xyz, s.xyz));
  }
  if ((mode >= 35u && mode <= 42u) || mode == 45u) {
    return mix_porter(mode, d, s);
  }
  if (mode == 43u) {
    return mix_blend(d, s, vec3<f32>(mix_xor(d.x, s.x, 255.0), mix_xor(d.y, s.y, 255.0), mix_xor(d.z, s.z, 255.0)));
  }
  if (mode == 44u) {
    return mix_blend(d, s, vec3<f32>(mix_xor(d.x, s.x, 65535.0), mix_xor(d.y, s.y, 65535.0), mix_xor(d.z, s.z, 65535.0)));
  }
  return mix_blend(d, s, vec3<f32>(mix_separable(mode, d.x, s.x), mix_separable(mode, d.y, s.y), mix_separable(mode, d.z, s.z)));
}
`;
