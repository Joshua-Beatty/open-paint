import { ARTISTIC_HELPERS_WGSL } from "./artistic-wgsl-common";

/** Bytes of the `Params` uniform of Emboss (four 4-byte fields). */
export const EMBOSS_PARAMS_BYTES = 16;

/**
 * WGSL twin of `stylize::emboss_rgba8` (FX-STYL-EMBOSS), one entry point. Each tap is the premultiplied
 * gray of a clamped pixel, convolved with the 3x3 `weights` from the Rust `emboss_kernel`. The
 * result is shifted by 128 / 255 and written as opaque gray.
 */
export const EMBOSS_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> weights: array<f32>;

${ARTISTIC_HELPERS_WGSL}

fn gray_at(x: i32, y: i32) -> f32 {
  let cx = u32(clamp(x, 0, i32(p.width) - 1));
  let cy = u32(clamp(y, 0, i32(p.height) - 1));
  let s = src[cy * p.width + cx];
  let a = channel(s, 3u);
  return luma(vec3<f32>(channel(s, 0u) * a, channel(s, 1u) * a, channel(s, 2u) * a));
}

@compute @workgroup_size(8, 8)
fn emboss(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  var acc = 0.0;
  for (var row = 0; row < 3; row++) {
    for (var col = 0; col < 3; col++) {
      acc = acc + weights[u32(row * 3 + col)] * gray_at(i32(id.x) + col - 1, i32(id.y) + row - 1);
    }
  }
  let level = to_u8(acc + 128.0 / 255.0);
  dst[id.y * p.width + id.x] = pack_rgba(level, level, level, 255u);
}
`;
