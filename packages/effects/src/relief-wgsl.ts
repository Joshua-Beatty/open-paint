import { ARTISTIC_HELPERS_WGSL } from "./artistic-wgsl-common";

/** Bytes of the `Params` uniform of Relief (four 4-byte fields). */
export const RELIEF_PARAMS_BYTES = 16;

/**
 * WGSL twin of `stylize::relief_rgba8` (FX-STYL-RELIEF), one entry point. Each of the four straight
 * channels (alpha included) is convolved with the 3x3 `weights` from the Rust `relief_kernel`, with
 * clamped taps, and clamped to 0..1.
 */
export const RELIEF_WGSL = /* wgsl */ `
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

fn tap(x: i32, y: i32, c: u32) -> f32 {
  let cx = u32(clamp(x, 0, i32(p.width) - 1));
  let cy = u32(clamp(y, 0, i32(p.height) - 1));
  return channel(src[cy * p.width + cx], c);
}

fn convolved(x: i32, y: i32, c: u32) -> f32 {
  var acc = 0.0;
  for (var row = 0; row < 3; row++) {
    for (var col = 0; col < 3; col++) {
      acc = acc + weights[u32(row * 3 + col)] * tap(x + col - 1, y + row - 1, c);
    }
  }
  return acc;
}

@compute @workgroup_size(8, 8)
fn relief(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let x = i32(id.x);
  let y = i32(id.y);
  dst[id.y * p.width + id.x] = pack_rgba(
    to_u8(convolved(x, y, 0u)),
    to_u8(convolved(x, y, 1u)),
    to_u8(convolved(x, y, 2u)),
    to_u8(convolved(x, y, 3u)),
  );
}
`;
