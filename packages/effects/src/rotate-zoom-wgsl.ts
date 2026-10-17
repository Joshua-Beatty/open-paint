/**
 * WGSL twin of `rotate_zoom_rgba8` in `crates/opaint-cpu/src/rotate_zoom.rs` (FX-NOSUB-ROTZOOM-01).
 * Each output pixel casts one ray per rotated-grid offset through the plan from `rotate_zoom_plan`,
 * reads the source where the ray meets the layer (bilinear or nearest, under the tiling mode),
 * averages, and returns straight alpha. The operations match the Rust reference in order.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed
 * RGBA8 `u32` words, 3 the offsets as `vec2<f32>` (from `rgss_offsets`).
 */

/** Bytes of the `Params` uniform: five `u32` fields, three padding words, then the plan as four `vec4<f32>`. */
export const ROTATE_ZOOM_PARAMS_BYTES = 96;
/** Byte offset of the plan in the `Params` uniform. */
export const ROTATE_ZOOM_PLAN_OFFSET = 32;

export const ROTATE_ZOOM_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  sampling: u32,
  tiling: u32,
  count: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
  plan: array<vec4<f32>, 4>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> offsets: array<vec2<f32>>;

fn plan_at(i: u32) -> f32 {
  let v = params.plan[i >> 2u];
  let k = i & 3u;
  if (k == 0u) {
    return v.x;
  }
  if (k == 1u) {
    return v.y;
  }
  if (k == 2u) {
    return v.z;
  }
  return v.w;
}

// The continuous source position the ray through \`scene\` meets, with z = 1 on a hit and 0 on a miss.
fn source_at(scene: vec2<f32>, size: vec2<f32>) -> vec3<f32> {
  let focal = plan_at(9u);
  let qx = (scene.x - size.x / 2.0 - plan_at(10u)) / plan_at(12u);
  let qy = (scene.y - size.y / 2.0 - plan_at(11u)) / plan_at(12u);
  let rx = qx / focal;
  let ry = qy / focal;
  let denom = plan_at(2u) * rx + plan_at(5u) * ry + plan_at(8u);
  if (abs(denom) < 1e-7) {
    return vec3<f32>(0.0);
  }
  let t = plan_at(8u) * focal / denom;
  if (!(t > 0.0)) {
    return vec3<f32>(0.0);
  }
  let x = t * rx;
  let y = t * ry;
  let z = t - focal;
  let u = plan_at(0u) * x + plan_at(3u) * y + plan_at(6u) * z + size.x / 2.0;
  let v = plan_at(1u) * x + plan_at(4u) * y + plan_at(7u) * z + size.y / 2.0;
  if (!(abs(u) <= 1e6 && abs(v) <= 1e6)) {
    return vec3<f32>(0.0);
  }
  return vec3<f32>(u, v, 1.0);
}

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

// The index a coordinate reads under the tiling mode (0 None, 1 Repeat, 2 Mirror), or -1 for transparent.
fn edge_index(index: i32, len: i32) -> i32 {
  if (params.tiling == 0u) {
    if (index < 0 || index >= len) {
      return -1;
    }
    return index;
  }
  if (params.tiling == 1u) {
    return ((index % len) + len) % len;
  }
  let period = 2 * len;
  let m = ((index % period) + period) % period;
  if (m >= len) {
    return period - 1 - m;
  }
  return m;
}

fn tap(x: i32, y: i32) -> vec4<f32> {
  let ix = edge_index(x, i32(params.width));
  let iy = edge_index(y, i32(params.height));
  if (ix < 0 || iy < 0) {
    return vec4<f32>(0.0);
  }
  return unpack_texel(u32(iy) * params.width + u32(ix));
}

fn sample_bilinear(s: vec2<f32>) -> vec4<f32> {
  let u = s - vec2<f32>(0.5);
  let base = floor(u);
  let frac = u - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);
  return tap(x0, y0) * ((1.0 - frac.x) * (1.0 - frac.y))
    + tap(x0 + 1, y0) * (frac.x * (1.0 - frac.y))
    + tap(x0, y0 + 1) * ((1.0 - frac.x) * frac.y)
    + tap(x0 + 1, y0 + 1) * (frac.x * frac.y);
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
fn rotate_zoom(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  let size = vec2<f32>(f32(params.width), f32(params.height));
  var acc = vec4<f32>(0.0);
  for (var s = 0u; s < params.count; s = s + 1u) {
    let shift = offsets[s];
    let scene = vec2<f32>(f32(id.x) + 0.5 + shift.x, f32(id.y) + 0.5 + shift.y);
    let hit = source_at(scene, size);
    if (hit.z > 0.0) {
      if (params.sampling == 0u) {
        acc = acc + sample_bilinear(hit.xy);
      } else {
        acc = acc + tap(i32(floor(hit.x)), i32(floor(hit.y)));
      }
    }
  }
  let avg = acc / f32(params.count);
  let alpha = clamp(avg.w, 0.0, 1.0);
  let word = to_byte(straight_channel(avg.x, alpha))
    | (to_byte(straight_channel(avg.y, alpha)) << 8u)
    | (to_byte(straight_channel(avg.z, alpha)) << 16u)
    | (to_byte(alpha) << 24u);
  dst[id.y * params.width + id.x] = word;
}
`;
