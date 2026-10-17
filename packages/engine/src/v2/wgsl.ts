import { ADJUST_PIXEL_WGSL } from "@openpaint/effects";
import { BLEND_WGSL } from "../composite-wgsl";

/**
 * Shaders of engine v2. Layer tiles are straight-alpha `rgba8unorm` slices
 * of texture arrays with a full mip chain. Blending reuses the WGSL twin of the Rust reference
 * (`BLEND_WGSL`), and stamping reproduces `crates/opaint-cpu/src/brush.rs` per pixel.
 */

/**
 * Builds mip level L+1 of the listed slices from level L: a 2×2 box filter weighted by alpha,
 * so transparent pixels do not darken the colors of straight-alpha tiles.
 */
export const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(2) var<storage, read> slices: array<u32>;

@compute @workgroup_size(8, 8)
fn mip(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let slice = slices[id.z];
  let p = vec2i(id.xy) * 2;
  let a = textureLoad(src, p, slice, 0);
  let b = textureLoad(src, p + vec2i(1, 0), slice, 0);
  let c = textureLoad(src, p + vec2i(0, 1), slice, 0);
  let d = textureLoad(src, p + vec2i(1, 1), slice, 0);
  let alpha = a.a + b.a + c.a + d.a;
  var rgb = vec3f(0.0);
  if (alpha > 0.0) {
    rgb = (a.rgb * a.a + b.rgb * b.a + c.rgb * c.a + d.rgb * d.a) / alpha;
  }
  textureStore(dst, vec2i(id.xy), slice, vec4f(rgb, alpha * 0.25));
}
`;

/** Texture arrays one composite dispatch can read. More pages split the stack into chunks. */
export const COMPOSITE_PAGES = 8;

/**
 * Blends one 256 px composite tile at mip level `level` from a run of layers, bottom to top, in
 * one dispatch. Each layer's tile is found in the slot table and read
 * from the page bound for it. A chunk after the first starts from the previous chunk's result
 * (`flags & 1`), and the last chunk writes premultiplied pixels for presentation (`flags & 2`).
 */
export const COMPOSITE_V2_WGSL = /* wgsl */ `
struct Params {
  origin: vec2u,
  level: u32,
  layer_start: u32,
  layer_count: u32,
  tiles_x: u32,
  flags: u32,
  pad0: u32,
  extent: vec2u,
  pad1: vec2u,
  pages: array<vec4u, 2>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> layers: array<vec4u>;
@group(0) @binding(2) var<storage, read> table: array<u32>;
@group(0) @binding(3) var base: texture_2d<f32>;
@group(0) @binding(4) var out_tile: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var page0: texture_2d_array<f32>;
@group(0) @binding(6) var page1: texture_2d_array<f32>;
@group(0) @binding(7) var page2: texture_2d_array<f32>;
@group(0) @binding(8) var page3: texture_2d_array<f32>;
@group(0) @binding(9) var page4: texture_2d_array<f32>;
@group(0) @binding(10) var page5: texture_2d_array<f32>;
@group(0) @binding(11) var page6: texture_2d_array<f32>;
@group(0) @binding(12) var page7: texture_2d_array<f32>;

${ADJUST_PIXEL_WGSL}
// The live filter (FX-FW-PREVIEW-01): the adjustment, its region in image pixels and whether a
// selection coverage (4 bytes per word, row-major over the region) limits it.
struct Live {
  region: vec4u,
  flags: vec4u,
}
@group(0) @binding(13) var<uniform> p: AdjustParams;
@group(0) @binding(14) var<uniform> live: Live;
@group(0) @binding(15) var<storage, read> live_coverage: array<u32>;

${BLEND_WGSL}
fn to_u8(t: vec4f) -> vec4u {
  return vec4u(round(t * 255.0));
}

// A layer pixel through the live filter, at image pixel \`at\`: adjusted inside the region and
// mixed with the original by the selection coverage, as the effect's output is clipped.
fn live_pixel(s: vec4u, at: vec2u) -> vec4u {
  let r = live.region;
  if (at.x < r.x || at.y < r.y || at.x >= r.x + r.z || at.y >= r.y + r.w) {
    return s;
  }
  var c = 255u;
  if (live.flags.x != 0u) {
    let i = (at.y - r.y) * r.z + (at.x - r.x);
    c = (live_coverage[i >> 2u] >> ((i & 3u) * 8u)) & 255u;
  }
  if (c == 0u) {
    return s;
  }
  let a = adjust_rgba(s, 0.0);
  return (s * (255u - c) + a * c + vec4u(127u)) / 255u;
}

fn load_page(k: u32, p: vec2i, slice: u32, level: u32) -> vec4f {
  switch k {
    case 0u: { return textureLoad(page0, p, slice, level); }
    case 1u: { return textureLoad(page1, p, slice, level); }
    case 2u: { return textureLoad(page2, p, slice, level); }
    case 3u: { return textureLoad(page3, p, slice, level); }
    case 4u: { return textureLoad(page4, p, slice, level); }
    case 5u: { return textureLoad(page5, p, slice, level); }
    case 6u: { return textureLoad(page6, p, slice, level); }
    default: { return textureLoad(page7, p, slice, level); }
  }
}

@compute @workgroup_size(8, 8)
fn composite(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 256u || id.y >= 256u) {
    return;
  }
  var d = vec4u(0u);
  if ((params.flags & 1u) != 0u) {
    d = to_u8(textureLoad(base, vec2i(id.xy), 0));
  }
  // Past the image's covered pixels (extent), its last column and row repeat: the frame never
  // shows them, but filtering at the image's edge samples them and must not find transparency.
  let lp = min(params.origin + id.xy, params.extent - vec2u(1u));
  let size = 256u >> params.level;
  let tile = lp / size;
  let local = vec2i(lp - tile * size);
  let cell = tile.y * params.tiles_x + tile.x;
  for (var i = 0u; i < params.layer_count; i++) {
    let layer = layers[params.layer_start + i];
    let code = table[layer.x + cell];
    if (code == 0xffffffffu) {
      continue;
    }
    let page = code >> 16u;
    var k = 0u;
    loop {
      if (k >= 8u || params.pages[k / 4u][k % 4u] == page) {
        break;
      }
      k++;
    }
    if (k >= 8u) {
      continue;
    }
    var s = to_u8(load_page(k, local, code & 0xffffu, params.level));
    if (layer.w != 0u) {
      // A mip pixel stands for a block of image pixels; the filter reads the block's center.
      let scale = 1u << params.level;
      s = live_pixel(s, lp * scale + vec2u(scale >> 1u));
    }
    d = composite_pixel(d, s, layer.y, layer.z);
  }
  var o = vec4f(d) / 255.0;
  if ((params.flags & 2u) != 0u) {
    o = vec4f(o.rgb * o.a, o.a);
  }
  textureStore(out_tile, vec2i(id.xy), o);
}
`;

/** The 8 × 8 hatch tiles of TL-OPT-FILL, the Rust `HATCH_PATTERNS` table, one row per word. */
const HATCH_ROWS = [
  [0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00],
  [0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88],
  [0x88, 0x11, 0x22, 0x44, 0x88, 0x11, 0x22, 0x44],
  [0x88, 0x44, 0x22, 0x11, 0x88, 0x44, 0x22, 0x11],
  [0xff, 0x88, 0x88, 0x88, 0xff, 0x88, 0x88, 0x88],
  [0x88, 0x55, 0x22, 0x55, 0x88, 0x55, 0x22, 0x55],
  [0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55],
  [0x88, 0x00, 0x00, 0x00, 0x88, 0x00, 0x00, 0x00],
].flat();

/**
 * Stamps a batch of dabs into one stroke tile: 256 × 256 packed RGBA8 words in a storage buffer.
 * The stroke's coverage is the largest tip coverage of any dab (`brush.rs` `stamp_dabs`): each
 * pixel takes the largest coverage of the dabs that touch its tile and of the tile's coverage
 * slot, and where that rises it paints the pixel from the original slot with the new coverage,
 * with the hatch and paint rules of `brush.rs` (`dab_coverage`, `source_at`, `paint_pixel`).
 * Final dabs store the new coverage (`write_cover`); provisional ones only paint. Positions are
 * image pixels, so hatch patterns repeat from the image origin.
 */
export const STAMP_WGSL = /* wgsl */ `
struct Stroke {
  sprite_n: u32,
  paint_mode: u32,
  blend_mode: u32,
  antialias: u32,
  color: vec4u,
  back: vec4u,
  hatch: u32,
  doc_w: u32,
  doc_h: u32,
  pad0: u32,
}

struct Tile {
  slot_offset: u32,
  origin_x: u32,
  origin_y: u32,
  dab_start: u32,
  bounds: vec4u,
  dab_count: u32,
  original_offset: u32,
  cover_offset: u32,
  write_cover: u32,
}

@group(0) @binding(0) var<uniform> stroke: Stroke;
@group(0) @binding(1) var<uniform> tile: Tile;
@group(0) @binding(2) var<storage, read> tip: array<f32>;
@group(0) @binding(3) var<storage, read> dabs: array<vec4f>;
@group(0) @binding(4) var<storage, read> indices: array<u32>;
@group(0) @binding(5) var<storage, read_write> pixels: array<u32>;

const HATCH = array<u32, 64>(${HATCH_ROWS.map((row) => `${row}u`).join(", ")});

${BLEND_WGSL}
fn overwrite_channel(d: u32, s: u32, c: u32) -> u32 {
  return min(255u, mul(d, 255u - c) + mul(s, c));
}

fn tip_at(x: f32, y: f32) -> f32 {
  let max_index = f32(stroke.sprite_n - 1u);
  let cx = u32(clamp(x, 0.0, max_index));
  let cy = u32(clamp(y, 0.0, max_index));
  return tip[cy * stroke.sprite_n + cx];
}

fn tip_coverage(lx: f32, ly: f32) -> f32 {
  let n = f32(stroke.sprite_n);
  let u = (lx + 1.0) * 0.5 * n;
  let v = (ly + 1.0) * 0.5 * n;
  if (stroke.antialias != 0u) {
    let fx = u - 0.5;
    let fy = v - 0.5;
    let x0 = floor(fx);
    let y0 = floor(fy);
    let tx = fx - x0;
    let ty = fy - y0;
    let top = tip_at(x0, y0) * (1.0 - tx) + tip_at(x0 + 1.0, y0) * tx;
    let bottom = tip_at(x0, y0 + 1.0) * (1.0 - tx) + tip_at(x0 + 1.0, y0 + 1.0) * tx;
    return top * (1.0 - ty) + bottom * ty;
  }
  return tip_at(floor(u), floor(v));
}

fn source_at(x: u32, y: u32) -> vec4u {
  if (stroke.hatch == 0u) {
    return stroke.color;
  }
  let row = HATCH[(stroke.hatch - 1u) * 8u + y % 8u];
  if (((row >> (7u - x % 8u)) & 1u) == 1u) {
    return stroke.color;
  }
  return stroke.back;
}

fn paint(d: vec4u, c: u32, s: vec4u) -> vec4u {
  if (stroke.paint_mode == 1u) {
    return vec4u(d.x, d.y, d.z, mul(d.w, 255u - c));
  }
  if (stroke.paint_mode == 2u) {
    return vec4u(
      overwrite_channel(d.x, s.x, c),
      overwrite_channel(d.y, s.y, c),
      overwrite_channel(d.z, s.z, c),
      overwrite_channel(d.w, s.w, c),
    );
  }
  return composite_pixel(d, vec4u(s.x, s.y, s.z, mul(s.w, c)), stroke.blend_mode, 255u);
}

@compute @workgroup_size(8, 8)
fn stamp(@builtin(global_invocation_id) id: vec3u) {
  let lx = tile.bounds.x + id.x;
  let ly = tile.bounds.y + id.y;
  if (lx >= tile.bounds.z || ly >= tile.bounds.w) {
    return;
  }
  let x = tile.origin_x + lx;
  let y = tile.origin_y + ly;
  if (x >= stroke.doc_w || y >= stroke.doc_h) {
    return;
  }
  let local = ly * 256u + lx;
  let before = pixels[tile.cover_offset + local];
  var cover = before;
  let fx = f32(x) + 0.5;
  let fy = f32(y) + 0.5;
  for (var i = 0u; i < tile.dab_count; i++) {
    let dab = dabs[indices[tile.dab_start + i]];
    let px = (fx - dab.x) / dab.z;
    let py = (fy - dab.y) / dab.z;
    if (abs(px) >= 1.0 || abs(py) >= 1.0) {
      continue;
    }
    cover = max(cover, u32(floor(tip_coverage(px, py) * 255.0 + 0.5)));
  }
  if (cover <= before) {
    return;
  }
  if (tile.write_cover != 0u) {
    pixels[tile.cover_offset + local] = cover;
  }
  let word = pixels[tile.original_offset + local];
  let o = vec4u(word & 255u, (word >> 8u) & 255u, (word >> 16u) & 255u, word >> 24u);
  let d = paint(o, cover, source_at(x, y));
  pixels[tile.slot_offset + local] = d.x | (d.y << 8u) | (d.z << 16u) | (d.w << 24u);
}
`;

/**
 * Clips a stroke tile to the selection coverage (TL-FRAME-04), as `clipToCoverage` does on the
 * CPU: each channel is `(o × (255 − c) + p × c + 127) / 255` from the original and painted
 * pixels. All three inputs and the output are 256 × 256 word slots of one buffer.
 */
export const RESOLVE_WGSL = /* wgsl */ `
struct Slots {
  original: u32,
  painted: u32,
  mask: u32,
  out: u32,
}

@group(0) @binding(0) var<uniform> slots: Slots;
@group(0) @binding(1) var<storage, read_write> pixels: array<u32>;

fn clip(o: u32, p: u32, c: u32) -> u32 {
  return (o * (255u - c) + p * c + 127u) / 255u;
}

@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 256u || id.y >= 256u) {
    return;
  }
  let i = id.y * 256u + id.x;
  let o = pixels[slots.original + i];
  let p = pixels[slots.painted + i];
  let c = pixels[slots.mask + i];
  var out = 0u;
  for (var shift = 0u; shift < 32u; shift += 8u) {
    out |= clip((o >> shift) & 255u, (p >> shift) & 255u, c) << shift;
  }
  pixels[slots.out + i] = out;
}

// Copies the \`painted\` slot into \`out\`: a buffer copy within one buffer, which WebGPU's
// copyBufferToBuffer does not allow.
@compute @workgroup_size(8, 8)
fn copy(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 256u || id.y >= 256u) {
    return;
  }
  let i = id.y * 256u + id.x;
  pixels[slots.out + i] = pixels[slots.painted + i];
}
`;

/**
 * Draws composite tiles (premultiplied slices of one texture array) into their device-pixel
 * rectangles, with nearest or linear sampling for the whole frame (ARC-03-05).
 */
export const PRESENT_V2_WGSL = /* wgsl */ `
struct Frame {
  size: vec4f,
}

@group(0) @binding(0) var<uniform> frame: Frame;
// Per draw: [dst.x, dst.y, dst.w, dst.h] then [slot, cover.x, cover.y, 0]: the share of the
// tile the image covers, which dst shows.
@group(0) @binding(1) var<storage, read> quads: array<vec4f>;
@group(0) @binding(2) var tiles: texture_2d_array<f32>;
@group(0) @binding(3) var tile_sampler: sampler;

struct TileOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) slot: u32,
}

const CORNERS = array<vec2f, 6>(
  vec2f(0.0, 0.0),
  vec2f(1.0, 0.0),
  vec2f(0.0, 1.0),
  vec2f(0.0, 1.0),
  vec2f(1.0, 0.0),
  vec2f(1.0, 1.0),
);

@vertex
fn tile_vs(@builtin(vertex_index) index: u32, @builtin(instance_index) draw: u32) -> TileOut {
  let dst = quads[draw * 2u];
  let extra = quads[draw * 2u + 1u];
  let corner = CORNERS[index];
  let px = dst.xy + corner * dst.zw;
  var out: TileOut;
  out.position = vec4f(px.x / frame.size.x * 2.0 - 1.0, 1.0 - px.y / frame.size.y * 2.0, 0.0, 1.0);
  out.uv = corner * extra.yz;
  out.slot = u32(extra.x);
  return out;
}

@fragment
fn tile_fs(in: TileOut) -> @location(0) vec4f {
  return textureSample(tiles, tile_sampler, in.uv, in.slot);
}
`;
