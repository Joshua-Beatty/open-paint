/**
 * Canvas view shaders (ARC-03-02). `CHROME_WGSL` draws the transparency checkerboard, the drop
 * shadow and the border. `TILE_WGSL` draws display tiles (premultiplied RGBA8) into their device
 * pixel rectangles with nearest or bilinear sampling. Both write premultiplied output.
 */

export const CHROME_WGSL = /* wgsl */ `
struct Chrome {
  rect: vec4<f32>,
  viewport: vec4<f32>,
  checker: vec4<f32>,
  shadow: vec4<f32>,
  border: vec4<f32>,
}

@group(0) @binding(0) var<uniform> chrome: Chrome;

@vertex
fn chrome_vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let x = f32(i32(index & 1u) * 4 - 1);
  let y = f32(i32(index >> 1u) * 4 - 1);
  return vec4<f32>(x, y, 0.0, 1.0);
}

// Abramowitz and Stegun 7.1.26, absolute error below 1.5e-7.
fn erf(x: f32) -> f32 {
  let a = abs(x);
  let t = 1.0 / (1.0 + 0.3275911 * a);
  let poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  let y = 1.0 - poly * exp(-a * a);
  return select(-y, y, x >= 0.0);
}

// Share of a Gaussian (sigma) blur of the interval [a, b] that lies at x.
fn cover(x: f32, a: f32, b: f32, sigma: f32) -> f32 {
  let cdf_a = 0.5 * (1.0 + erf((x - a) / (sigma * 1.41421356)));
  let cdf_b = 0.5 * (1.0 + erf((x - b) / (sigma * 1.41421356)));
  return cdf_a - cdf_b;
}

@fragment
fn chrome_fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  let r = chrome.rect;
  let inside = p.x >= r.x && p.x < r.x + r.z && p.y >= r.y && p.y < r.y + r.w;
  if (inside) {
    let size = chrome.viewport.z;
    let cx = i32(floor((p.x - r.x) / size));
    let cy = i32(floor((p.y - r.y) / size));
    let gray = select(chrome.checker.y, chrome.checker.x, ((cx + cy) & 1) == 0) / 255.0;
    return vec4<f32>(gray, gray, gray, 1.0);
  }
  let border_alpha = chrome.border.w;
  if (border_alpha > 0.0 && p.x >= r.x - 1.0 && p.x < r.x + r.z + 1.0 && p.y >= r.y - 1.0 && p.y < r.y + r.w + 1.0) {
    return vec4<f32>(chrome.border.xyz * border_alpha, border_alpha);
  }
  let sigma = chrome.viewport.w;
  let alpha = chrome.shadow.w * cover(p.x, r.x, r.x + r.z, sigma) * cover(p.y, r.y, r.y + r.w, sigma);
  return vec4<f32>(chrome.shadow.xyz * alpha, alpha);
}
`;

export const TILE_WGSL = /* wgsl */ `
struct Frame {
  size: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
// Per draw: [dst.x, dst.y, dst.w, dst.h] then [uv0.x, uv0.y, uv1.x, uv1.y].
@group(0) @binding(1) var<storage, read> quads: array<vec4<f32>>;
@group(1) @binding(0) var tile: texture_2d<f32>;
@group(1) @binding(1) var tile_sampler: sampler;

struct TileOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

const CORNERS = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(0.0, 1.0),
  vec2<f32>(0.0, 1.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(1.0, 1.0),
);

@vertex
fn tile_vs(@builtin(vertex_index) index: u32, @builtin(instance_index) draw: u32) -> TileOut {
  let dst = quads[draw * 2u];
  let uv = quads[draw * 2u + 1u];
  let corner = CORNERS[index];
  let px = dst.xy + corner * dst.zw;
  var out: TileOut;
  out.position = vec4<f32>(px.x / frame.size.x * 2.0 - 1.0, 1.0 - px.y / frame.size.y * 2.0, 0.0, 1.0);
  out.uv = mix(uv.xy, uv.zw, corner);
  return out;
}

@fragment
fn tile_fs(in: TileOut) -> @location(0) vec4<f32> {
  return textureSample(tile, tile_sampler, in.uv);
}
`;
