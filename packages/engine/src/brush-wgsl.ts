import { BLEND_WGSL } from "./composite-wgsl";

/**
 * WGSL twin of the stroke in `crates/opaint-cpu/src/brush.rs` (TL-BRUSH-01). One `stamp` dispatch
 * raises the stroke's coverage buffer to one dab's tip coverage over its bounding box (the largest
 * of any dab, as `stroke_coverage`). One `apply` dispatch over the stroke's bounding box then
 * paints each covered pixel once with its coverage. The dab list and the tip sprite come from the
 * Rust kernels. Pixels are packed RGBA8 words in a storage buffer.
 */
export const BRUSH_WGSL = /* wgsl */ `
struct Dab {
  center_x: f32,
  center_y: f32,
  radius: f32,
  sprite_n: u32,
  origin_x: u32,
  origin_y: u32,
  extent_x: u32,
  extent_y: u32,
  canvas_w: u32,
  paint_mode: u32,
  blend_mode: u32,
  antialias: u32,
  color_r: u32,
  color_g: u32,
  color_b: u32,
  color_a: u32,
}

@group(0) @binding(0) var<uniform> dab: Dab;
@group(0) @binding(1) var<storage, read> tip: array<f32>;
@group(0) @binding(2) var<storage, read_write> pixels: array<u32>;
@group(0) @binding(3) var<storage, read_write> cover: array<atomic<u32>>;

${BLEND_WGSL}
fn overwrite_channel(d: u32, s: u32, c: u32) -> u32 {
  return min(255u, mul(d, 255u - c) + mul(s, c));
}

fn tip_at(x: f32, y: f32) -> f32 {
  let max_index = f32(dab.sprite_n - 1u);
  let cx = u32(clamp(x, 0.0, max_index));
  let cy = u32(clamp(y, 0.0, max_index));
  return tip[cy * dab.sprite_n + cx];
}

fn tip_coverage(lx: f32, ly: f32) -> f32 {
  let n = f32(dab.sprite_n);
  let u = (lx + 1.0) * 0.5 * n;
  let v = (ly + 1.0) * 0.5 * n;
  if (dab.antialias != 0u) {
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

@compute @workgroup_size(8, 8)
fn stamp(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= dab.extent_x || id.y >= dab.extent_y) {
    return;
  }
  let x = dab.origin_x + id.x;
  let y = dab.origin_y + id.y;
  let lx = (f32(x) + 0.5 - dab.center_x) / dab.radius;
  let ly = (f32(y) + 0.5 - dab.center_y) / dab.radius;
  if (abs(lx) >= 1.0 || abs(ly) >= 1.0) {
    return;
  }
  let c = u32(floor(tip_coverage(lx, ly) * 255.0 + 0.5));
  if (c == 0u) {
    return;
  }
  atomicMax(&cover[y * dab.canvas_w + x], c);
}

// Paints the stroke's coverage over its bounding box (origin and extent of the uniform).
@compute @workgroup_size(8, 8)
fn apply(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= dab.extent_x || id.y >= dab.extent_y) {
    return;
  }
  let x = dab.origin_x + id.x;
  let y = dab.origin_y + id.y;
  let index = y * dab.canvas_w + x;
  let c = atomicLoad(&cover[index]);
  if (c == 0u) {
    return;
  }
  let word = pixels[index];
  let d = vec4u(word & 255u, (word >> 8u) & 255u, (word >> 16u) & 255u, word >> 24u);
  var out: vec4u;
  if (dab.paint_mode == 1u) {
    out = vec4u(d.x, d.y, d.z, mul(d.w, 255u - c));
  } else if (dab.paint_mode == 2u) {
    out = vec4u(
      overwrite_channel(d.x, dab.color_r, c),
      overwrite_channel(d.y, dab.color_g, c),
      overwrite_channel(d.z, dab.color_b, c),
      overwrite_channel(d.w, dab.color_a, c),
    );
  } else {
    let s = vec4u(dab.color_r, dab.color_g, dab.color_b, mul(dab.color_a, c));
    out = composite_pixel(d, s, dab.blend_mode, 255u);
  }
  pixels[index] = out.x | (out.y << 8u) | (out.z << 16u) | (out.w << 24u);
}
`;
