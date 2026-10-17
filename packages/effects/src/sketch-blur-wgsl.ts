/** Bytes of the `Params` uniform of the Sketch Blur shader. */
export const SKETCH_BLUR_PARAMS_BYTES = 72;

/**
 * WGSL twin of `sketch_blur_rgba8` in `crates/opaint-cpu/src/neighborhood_blur.rs` (FX-BLUR-SKETCH-03).
 * One invocation computes one pixel. Each channel runs the same P² estimator as the Rust reference, in the
 * same integer arithmetic (heights in 1/64 level, positions in 1/200 count, truncating division), so the
 * two backends agree bit for bit. The scan offsets come from `sketch_offsets` and the constants from
 * `sketch_plan`. The GPU runs it once per tile, and `origin` places the tile in the image.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the output as packed
 * RGBA8 `u32` words, 3 the scan offsets as `dx, dy` pairs.
 */
export const SKETCH_BLUR_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  origin_x: u32,
  origin_y: u32,
  iterations: u32,
  rank: u32,
  pad0: u32,
  pad1: u32,
  init0: i32,
  init1: i32,
  init2: i32,
  init3: i32,
  init4: i32,
  increment0: i32,
  increment1: i32,
  increment2: i32,
  increment3: i32,
  increment4: i32,
};

const SAMPLES: u32 = 16u;
const HEIGHT_UNITS: i32 = 64;
const POSITION_UNITS: i32 = 200;

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read> scan: array<i32>;

fn mirror_index(i: i32, n: i32) -> i32 {
  let period = 2 * n;
  let m = ((i % period) + period) % period;
  if (m >= n) {
    return period - 1 - m;
  }
  return m;
}

fn tap(t: u32, x: i32, y: i32, channel: u32) -> i32 {
  let mx = mirror_index(x + scan[2u * t], i32(params.width));
  let my = mirror_index(y + scan[2u * t + 1u], i32(params.height));
  let word = src[u32(my) * params.width + u32(mx)];
  return i32((word >> (8u * channel)) & 0xffu) * HEIGHT_UNITS;
}

fn sketch_estimate(x: i32, y: i32, channel: u32) -> i32 {
  var prev = 0;
  for (var pass_index = 0u; pass_index < params.iterations; pass_index = pass_index + 1u) {
    var values = array<i32, 16>();
    for (var j = 0u; j < SAMPLES; j = j + 1u) {
      values[j] = tap(pass_index * SAMPLES + j, x, y, channel);
    }
    if (pass_index == 0u) {
      var picked = 1000000;
      for (var j = 0u; j < SAMPLES; j = j + 1u) {
        var below = 0u;
        for (var k = 0u; k < SAMPLES; k = k + 1u) {
          if (values[k] <= values[j]) {
            below = below + 1u;
          }
        }
        if (below > params.rank && values[j] < picked) {
          picked = values[j];
        }
      }
      prev = picked;
    }
    var lo = 1000000;
    var hi = -1000000;
    for (var j = 0u; j < SAMPLES; j = j + 1u) {
      lo = min(lo, values[j]);
      hi = max(hi, values[j]);
    }
    var q = array<i32, 5>(lo, (lo + prev) / 2, prev, (prev + hi) / 2, hi);
    var n = array<i32, 5>(1, 2, 3, 4, 5);
    var desired = array<i32, 5>(params.init0, params.init1, params.init2, params.init3, params.init4);
    var increment = array<i32, 5>(
      params.increment0,
      params.increment1,
      params.increment2,
      params.increment3,
      params.increment4,
    );
    for (var j = 0u; j < SAMPLES; j = j + 1u) {
      let observed = values[j];
      var k = 0u;
      for (var i = 1u; i <= 3u; i = i + 1u) {
        if (observed >= q[i]) {
          k = i;
        }
      }
      for (var i = k + 1u; i < 5u; i = i + 1u) {
        n[i] = n[i] + 1;
      }
      for (var i = 0u; i < 5u; i = i + 1u) {
        desired[i] = desired[i] + increment[i];
      }
      for (var i = 1u; i <= 3u; i = i + 1u) {
        let d = desired[i] - n[i] * POSITION_UNITS;
        if ((d >= POSITION_UNITS && n[i + 1u] - n[i] > 1) || (d <= -POSITION_UNITS && n[i - 1u] - n[i] < -1)) {
          var s = -1;
          if (d > 0) {
            s = 1;
          }
          let span = n[i + 1u] - n[i - 1u];
          let right = (n[i] - n[i - 1u] + s) * (q[i + 1u] - q[i]) / (n[i + 1u] - n[i]);
          let left = (n[i + 1u] - n[i] - s) * (q[i] - q[i - 1u]) / (n[i] - n[i - 1u]);
          let parabolic = q[i] + s * (right + left) / span;
          if (q[i - 1u] < parabolic && parabolic < q[i + 1u]) {
            q[i] = parabolic;
          } else {
            var neighbor = i - 1u;
            if (s > 0) {
              neighbor = i + 1u;
            }
            q[i] = q[i] + s * (q[neighbor] - q[i]) / (n[neighbor] - n[i]);
          }
          n[i] = n[i] + s;
        }
      }
    }
    prev = q[2];
  }
  return prev;
}

fn to_byte(height: i32) -> u32 {
  return u32(clamp((height + HEIGHT_UNITS / 2) / HEIGHT_UNITS, 0, 255));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = params.origin_x + id.x;
  let y = params.origin_y + id.y;
  if (x >= params.width || y >= params.height) {
    return;
  }
  var word = 0u;
  for (var channel = 0u; channel < 4u; channel = channel + 1u) {
    word = word | (to_byte(sketch_estimate(i32(x), i32(y), channel)) << (8u * channel));
  }
  dst[y * params.width + x] = word;
}
`;
