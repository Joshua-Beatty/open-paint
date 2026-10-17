/**
 * WGSL twins of `crates/opaint-cpu/src/blend.rs` (DOC-BLD-02). The integer formulas are ported
 * one for one on `u32` values, so the GPU result equals the Rust reference exactly (WEB-GPU-03
 * allows ±1). Channel values are read from and written to rgba8unorm textures as 0-255 integers.
 */
/** The integer blend functions of DOC-BLD-02, shared by every WGSL shader that composites. */
export const BLEND_WGSL = /* wgsl */ `
fn mul(a: u32, b: u32) -> u32 {
  return (a * b + 127u) / 255u;
}

fn blend_channel(mode: u32, d: u32, s: u32) -> u32 {
  switch mode {
    case 1u: {
      return mul(d, s);
    }
    case 2u: {
      return min(255u, d + s);
    }
    case 3u: {
      if (s == 0u) {
        return 0u;
      }
      let t = (255u - d) * 255u / s;
      if (t >= 255u) {
        return 0u;
      }
      return 255u - t;
    }
    case 4u: {
      if (s == 255u) {
        return 255u;
      }
      return min(255u, d * 255u / (255u - s));
    }
    case 5u: {
      if (s == 255u) {
        return 255u;
      }
      return min(255u, d * d / (255u - s));
    }
    case 6u: {
      if (d == 255u) {
        return 255u;
      }
      return min(255u, s * s / (255u - d));
    }
    case 7u: {
      if (d < 128u) {
        return mul(2u * d, s);
      }
      return 255u - mul(2u * (255u - d), 255u - s);
    }
    case 8u: {
      if (d > s) {
        return d - s;
      }
      return s - d;
    }
    case 9u: {
      let t = d + s;
      if (t >= 255u) {
        return 510u - t;
      }
      return t;
    }
    case 10u: {
      return max(d, s);
    }
    case 11u: {
      return min(d, s);
    }
    case 12u: {
      return s + d - mul(s, d);
    }
    case 13u: {
      return d ^ s;
    }
    default: {
      return s;
    }
  }
}

fn mix_channel(dc: u32, sc: u32, mode: u32, y: u32, k: u32, j: u32, ra: u32) -> u32 {
  let n = dc * y + sc * k + blend_channel(mode, dc, sc) * j;
  return (n + ra / 2u) / ra;
}

fn composite_pixel(d: vec4u, s: vec4u, mode: u32, opacity: u32) -> vec4u {
  if (opacity == 0u) {
    return d;
  }
  var sa = s.a;
  if (opacity != 255u) {
    sa = mul(s.a, opacity);
  }
  if (sa == 0u) {
    return d;
  }
  let da = d.a;
  let y = mul(da, 255u - sa);
  let ra = y + sa;
  let j = mul(da, sa);
  let k = sa - j;
  return vec4u(
    mix_channel(d.r, s.r, mode, y, k, j, ra),
    mix_channel(d.g, s.g, mode, y, k, j, ra),
    mix_channel(d.b, s.b, mode, y, k, j, ra),
    ra,
  );
}

`;

export const COMPOSITE_WGSL = /* wgsl */ `
struct Layer {
  mode: u32,
  opacity: u32,
}

@group(0) @binding(0) var<uniform> layer: Layer;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var base: texture_2d<f32>;
@group(0) @binding(3) var dst: texture_storage_2d<rgba8unorm, write>;

${BLEND_WGSL}
fn to_u8(t: vec4f) -> vec4u {
  return vec4u(round(t * 255.0));
}

@compute @workgroup_size(8, 8)
fn clear(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  textureStore(dst, vec2i(id.xy), vec4f(0.0));
}

@compute @workgroup_size(8, 8)
fn composite(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let p = vec2i(id.xy);
  let d = to_u8(textureLoad(base, p, 0));
  let s = to_u8(textureLoad(src, p, 0));
  let r = composite_pixel(d, s, layer.mode, layer.opacity);
  textureStore(dst, p, vec4f(r) / 255.0);
}
`;

/**
 * Draws one composited tile at its canvas position. The quad covers `rect` (canvas pixels, top
 * left origin); the fragment shader fetches the matching texel, so no sampler is needed. Output
 * is premultiplied because the WebGPU canvas is configured with `alphaMode: "premultiplied"`.
 */
export const PRESENT_WGSL = /* wgsl */ `
struct Frame {
  rect: vec4f,
  canvas: vec2f,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var tile: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let px = frame.rect.xy + corners[i] * frame.rect.zw;
  let ndc = px / frame.canvas * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  return vec4f(ndc, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let texel = vec2i(floor(pos.xy)) - vec2i(frame.rect.xy);
  let c = textureLoad(tile, texel, 0);
  return vec4f(c.rgb * c.a, c.a);
}
`;
