/** Bytes of the `Params` uniform of the Align Object shader (twelve 4-byte fields). */
export const ALIGN_OBJECT_PARAMS_BYTES = 48;

/**
 * WGSL twin of `align::align_object_translate_rgba8` (FX-OBJ-ALIGN-05). Each output pixel inside
 * the selection takes the object pixel `(dx, dy)` before it, when that pixel lies in the object
 * box, is selected and has an alpha above 0, and is transparent (0, 0, 0, 0) otherwise. Pixels
 * outside the selection keep their value. With `faint`, moved pixels are drawn opaque. The pixels
 * are copied as packed words, so the output matches the Rust reference exactly. Bindings: 0
 * `Params`, 1 the source, 2 the coverage (four bytes per word, read only when `has_mask` is 1),
 * 3 the output.
 */
export const ALIGN_OBJECT_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  dx: i32,
  dy: i32,
  x1: i32,
  y1: i32,
  x2: i32,
  y2: i32,
  has_mask: u32,
  faint: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> mask: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

fn selected(i: u32) -> bool {
  if (p.has_mask == 0u) {
    return true;
  }
  return ((mask[i / 4u] >> ((i % 4u) * 8u)) & 255u) != 0u;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  if (!selected(i)) {
    dst[i] = src[i];
    return;
  }
  let sx = i32(id.x) - p.dx;
  let sy = i32(id.y) - p.dy;
  var moved = 0u;
  if (sx >= p.x1 && sx < p.x2 && sy >= p.y1 && sy < p.y2) {
    let j = u32(sy) * p.width + u32(sx);
    let s = src[j];
    if ((s >> 24u) != 0u && selected(j)) {
      moved = s;
      if (p.faint == 1u) {
        moved = s | 0xff000000u;
      }
    }
  }
  dst[i] = moved;
}
`;
