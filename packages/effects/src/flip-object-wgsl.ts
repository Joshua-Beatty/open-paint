/** Bytes of the `Params` uniform of the Flip shader (four 4-byte fields). */
export const FLIP_OBJECT_PARAMS_BYTES = 16;

/**
 * WGSL twin of `flip::flip_object_rgba8` (FX-OBJ-FLIP-04). Pixel `i` mirrors pixel `j` across the
 * image's vertical (`vertical` 0) or horizontal (`vertical` 1) centre line. Without a mask it takes
 * pixel `j` as it is. With one, pixel `i` loses the alpha its coverage `c` lifts out (a fully lifted
 * pixel becomes (0, 0, 0, 0)), and pixel `j` is placed over it by the mirrored coverage `m`,
 * `lerp(base, src[j], m / 255)` per channel rounded half up. Every step is integer arithmetic, so
 * the output matches the Rust reference exactly. Bindings: 0 `Params`, 1 the source, 2 the
 * coverage (four bytes per word, read only when `has_mask` is 1), 3 the output.
 */
export const FLIP_OBJECT_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  vertical: u32,
  has_mask: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> mask: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

fn coverage(i: u32) -> u32 {
  return (mask[i / 4u] >> ((i % 4u) * 8u)) & 255u;
}

fn channel(word: u32, k: u32) -> u32 {
  return (word >> (k * 8u)) & 255u;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  var j = id.y * p.width + (p.width - 1u - id.x);
  if (p.vertical == 1u) {
    j = (p.height - 1u - id.y) * p.width + id.x;
  }
  let mirrored = src[j];
  if (p.has_mask == 0u) {
    dst[i] = mirrored;
    return;
  }
  let c = coverage(i);
  let m = coverage(j);
  var base = src[i];
  if (c == 255u) {
    base = 0u;
  } else if (c > 0u) {
    let alpha = base >> 24u;
    let lifted = (alpha * c + 127u) / 255u;
    base = (base & 0x00ffffffu) | ((alpha - lifted) << 24u);
  }
  if (m == 0u) {
    dst[i] = base;
    return;
  }
  if (m == 255u) {
    dst[i] = mirrored;
    return;
  }
  let keep = 255u - m;
  var out = 0u;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let value = (channel(base, k) * keep + channel(mirrored, k) * m + 127u) / 255u;
    out = out | (value << (k * 8u));
  }
  dst[i] = out;
}
`;
