import { ARTISTIC_HELPERS_WGSL } from "./artistic-wgsl-common";

/** Bytes of the `Params` uniform of the Drop Shadow shader (twelve 4-byte fields). */
export const DROP_SHADOW_PARAMS_BYTES = 48;

/**
 * WGSL twin of `object::drop_shadow_rgba8` (FX-OBJ-DROPSHADOW). The stages are the entry points,
 * run in order: `blur_h` and `blur_v` write the Gaussian of the alpha through `plane_a` and
 * `plane_b` (zeros outside the image), and `composite` shifts the blurred alpha with bilinear
 * sampling, applies the shadow color and Opacity, and writes the packed output over (or instead
 * of) the layer. `weights` holds the blur kernel and the rest of `Params` the plan from Rust
 * (`drop_shadow_plan`). Bindings: 0 `Params`, 1 the source, 2 and 3 the planes, 4 the weights, 5 the
 * output, all as packed RGBA8 `u32` words or `f32` values.
 */
export const DROP_SHADOW_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  radius: i32,
  only_shadow: u32,
  dx: f32,
  dy: f32,
  r: f32,
  g: f32,
  b: f32,
  opacity: f32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> plane_a: array<f32>;
@group(0) @binding(3) var<storage, read_write> plane_b: array<f32>;
@group(0) @binding(4) var<storage, read> weights: array<f32>;
@group(0) @binding(5) var<storage, read_write> dst: array<u32>;

${ARTISTIC_HELPERS_WGSL}

fn blurred_at(x: i32, y: i32) -> f32 {
  if (x < 0 || y < 0 || x >= i32(p.width) || y >= i32(p.height)) {
    return 0.0;
  }
  return plane_b[u32(y) * p.width + u32(x)];
}

fn sample_blurred(x: f32, y: f32) -> f32 {
  let x0 = floor(x);
  let y0 = floor(y);
  let tx = x - x0;
  let ty = y - y0;
  let ix = i32(x0);
  let iy = i32(y0);
  let top = blurred_at(ix, iy) + (blurred_at(ix + 1, iy) - blurred_at(ix, iy)) * tx;
  let bottom = blurred_at(ix, iy + 1) + (blurred_at(ix + 1, iy + 1) - blurred_at(ix, iy + 1)) * tx;
  return top + (bottom - top) * ty;
}

@compute @workgroup_size(8, 8)
fn blur_h(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  var acc = 0.0;
  let taps = 2 * p.radius + 1;
  for (var k = 0; k < taps; k++) {
    let sx = i32(id.x) + k - p.radius;
    if (sx >= 0 && sx < i32(p.width)) {
      acc = acc + weights[u32(k)] * channel(src[id.y * p.width + u32(sx)], 3u);
    }
  }
  plane_a[id.y * p.width + id.x] = acc;
}

@compute @workgroup_size(8, 8)
fn blur_v(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  var acc = 0.0;
  let taps = 2 * p.radius + 1;
  for (var k = 0; k < taps; k++) {
    let sy = i32(id.y) + k - p.radius;
    if (sy >= 0 && sy < i32(p.height)) {
      acc = acc + weights[u32(k)] * plane_a[u32(sy) * p.width + id.x];
    }
  }
  plane_b[id.y * p.width + id.x] = acc;
}

@compute @workgroup_size(8, 8)
fn composite(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let s = src[i];
  let a = channel(s, 3u);
  let shadow_alpha = p.opacity * sample_blurred(f32(id.x) - p.dx, f32(id.y) - p.dy);
  let shadow = vec3<f32>(p.r, p.g, p.b) * shadow_alpha;
  var premultiplied = shadow;
  var alpha_out = shadow_alpha;
  if (p.only_shadow == 0u) {
    let source = vec3<f32>(
      to_linear(channel(s, 0u)),
      to_linear(channel(s, 1u)),
      to_linear(channel(s, 2u)),
    ) * a;
    premultiplied = source + shadow * (1.0 - a);
    alpha_out = a + shadow_alpha * (1.0 - a);
  }
  var straight = vec3<f32>(0.0);
  if (alpha_out > 0.0) {
    straight = clamp(premultiplied / alpha_out, vec3<f32>(0.0), vec3<f32>(1.0));
  }
  dst[i] = pack_rgba(
    to_u8(to_srgb(straight.x)),
    to_u8(to_srgb(straight.y)),
    to_u8(to_srgb(straight.z)),
    to_u8(alpha_out),
  );
}
`;
