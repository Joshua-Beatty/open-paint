/** Bytes of the `Params` uniform of the Motion Blur shader. */
export const MOTION_BLUR_PARAMS_BYTES = 16;

/**
 * WGSL twin of `motion_blur_rgba8` in `crates/opaint-cpu/src/directional_blur.rs` (FX-BLUR-MOTION-03).
 * Each pixel sums the premultiplied bilinear samples along the kernel, then writes straight-alpha
 * RGBA8. The kernel comes from `motion_plan`, as `dx, dy, weight` triples in one `array<f32>`, so the
 * shader and the reference read the same numbers. Samples outside the image follow the edge mode
 * (0 Clamp, 1 Wrap, 2 Reflect, 3 Transparent), as in `distort.rs`.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the plan, 3 the output
 * as packed RGBA8 `u32` words.
 */
export const MOTION_BLUR_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  count: u32,
  edge: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> plan: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

fn unpack_texel(index: u32) -> vec4<f32> {
  let word = src[index];
  let alpha = f32(word >> 24u) / 255.0;
  return vec4<f32>(
    f32(word & 0xffu) / 255.0 * alpha,
    f32((word >> 8u) & 0xffu) / 255.0 * alpha,
    f32((word >> 16u) & 0xffu) / 255.0 * alpha,
    alpha,
  );
}

// The index a coordinate reads under the edge mode, or -1 for transparent black.
fn edge_index(index: i32, len: i32, edge: u32) -> i32 {
  if (edge == 0u) {
    return clamp(index, 0, len - 1);
  }
  if (edge == 1u) {
    return ((index % len) + len) % len;
  }
  if (edge == 2u) {
    let period = 2 * len;
    let m = ((index % period) + period) % period;
    if (m >= len) {
      return period - 1 - m;
    }
    return m;
  }
  if (index < 0 || index >= len) {
    return -1;
  }
  return index;
}

fn tap(x: i32, y: i32) -> vec4<f32> {
  let ix = edge_index(x, i32(params.width), params.edge);
  let iy = edge_index(y, i32(params.height), params.edge);
  if (ix < 0 || iy < 0) {
    return vec4<f32>(0.0);
  }
  return unpack_texel(u32(iy) * params.width + u32(ix));
}

fn sample_bilinear(s: vec2<f32>) -> vec4<f32> {
  let u = s - vec2<f32>(0.5);
  let base = floor(u);
  let t = u - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);
  return tap(x0, y0) * ((1.0 - t.x) * (1.0 - t.y))
    + tap(x0 + 1, y0) * (t.x * (1.0 - t.y))
    + tap(x0, y0 + 1) * ((1.0 - t.x) * t.y)
    + tap(x0 + 1, y0 + 1) * (t.x * t.y);
}

fn straight_channel(channel: f32, alpha: f32) -> f32 {
  if (alpha > 0.0) {
    return clamp(channel / alpha, 0.0, 1.0);
  }
  return 0.0;
}

fn to_byte(value: f32) -> u32 {
  return u32(clamp(floor(value * 255.0 + 0.5), 0.0, 255.0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  var acc = vec4<f32>(0.0);
  for (var i = 0u; i < params.count; i = i + 1u) {
    let k = 3u * i;
    let s = vec2<f32>(f32(id.x) + 0.5 + plan[k], f32(id.y) + 0.5 + plan[k + 1u]);
    acc = acc + sample_bilinear(s) * plan[k + 2u];
  }
  let alpha = clamp(acc.w, 0.0, 1.0);
  dst[id.y * params.width + id.x] = to_byte(straight_channel(acc.x, alpha))
    | (to_byte(straight_channel(acc.y, alpha)) << 8u)
    | (to_byte(straight_channel(acc.z, alpha)) << 16u)
    | (to_byte(alpha) << 24u);
}
`;
