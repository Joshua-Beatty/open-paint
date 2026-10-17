import { ARTISTIC_HELPERS_WGSL, ARTISTIC_PARAMS_WGSL } from "./artistic-wgsl-common";

/**
 * WGSL twin of `sharpen_rgba8` (FX-PHOTO-SHARPEN), one entry point. Each premultiplied channel is
 * compared with its 3x3 blur, whose taps clamp to the image edge. `f0` is Amount and `f1` the
 * Threshold. The input is the whole image, since every output pixel reads its neighbours.
 */
export const SHARPEN_WGSL = /* wgsl */ `
${ARTISTIC_PARAMS_WGSL}

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

${ARTISTIC_HELPERS_WGSL}

fn premultiplied(x: i32, y: i32, c: u32) -> f32 {
  let cx = clamp(x, 0, i32(p.width) - 1);
  let cy = clamp(y, 0, i32(p.height) - 1);
  let word = src[u32(cy) * p.width + u32(cx)];
  return channel(word, c) * channel(word, 3u);
}

fn sharpen_channel(x: i32, y: i32, c: u32, alpha: f32) -> u32 {
  var blur = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let weight = f32((2 - abs(dx)) * (2 - abs(dy))) / 16.0;
      blur += weight * premultiplied(x + dx, y + dy, c);
    }
  }
  let original = premultiplied(x, y, c);
  let difference = original - blur;
  var sharpened = original;
  if (abs(difference) >= p.f1) {
    sharpened = original + p.f0 * difference;
  }
  var straight = 0.0;
  if (alpha > 0.0) {
    straight = clamp(sharpened, 0.0, 1.0) / alpha;
  }
  return to_u8(straight);
}

@compute @workgroup_size(8, 8)
fn sharpen(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let s = src[i];
  let a = channel(s, 3u);
  let x = i32(id.x);
  let y = i32(id.y);
  dst[i] = pack_rgba(
    sharpen_channel(x, y, 0u, a),
    sharpen_channel(x, y, 1u, a),
    sharpen_channel(x, y, 2u, a),
    s >> 24u,
  );
}
`;
