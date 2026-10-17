/** Bytes of the `Params` uniform of the Pixelate shaders. */
export const PIXELATE_PARAMS_BYTES = 48;

/**
 * WGSL twin of `pixelate_rgba8` in `crates/opaint-cpu/src/pixelate.rs` (FX-DIST-PIXELATE-03), in two
 * entry points. `scale_down` writes one premultiplied RGBA8 cell per grid cell, and `scale_up` maps
 * each output pixel into the cells and writes straight-alpha RGBA8. Dispatch the two in order, in
 * separate compute passes, so the second reads the cells the first wrote.
 *
 * Bindings: 0 `Params` (uniform), 1 the source as packed RGBA8 `u32` words, 2 the cells (packed
 * premultiplied RGBA8, one `u32` each), 3 the output as packed RGBA8 `u32` words. The grid and the
 * plan come from the Rust reference (`pixelate_grid`, `pixelate_plan`), so both backends agree.
 */
export const PIXELATE_WGSL = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  cols: u32,
  rows: u32,
  origin: vec2<i32>,
  down: u32,
  up: u32,
  plan: vec4<f32>,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> cells: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

fn unpack_source(word: u32) -> vec4<f32> {
  let alpha = f32(word >> 24u) / 255.0;
  return vec4<f32>(
    f32(word & 0xffu) / 255.0 * alpha,
    f32((word >> 8u) & 0xffu) / 255.0 * alpha,
    f32((word >> 16u) & 0xffu) / 255.0 * alpha,
    alpha,
  );
}

fn unpack_cell(word: u32) -> vec4<f32> {
  return vec4<f32>(
    f32(word & 0xffu) / 255.0,
    f32((word >> 8u) & 0xffu) / 255.0,
    f32((word >> 16u) & 0xffu) / 255.0,
    f32(word >> 24u) / 255.0,
  );
}

// A texel of the source (premultiplied) or the cells, with the coordinates clamped to the plane.
fn fetch(from_src: bool, x: i32, y: i32, w: i32, h: i32) -> vec4<f32> {
  let cx = clamp(x, 0, w - 1);
  let cy = clamp(y, 0, h - 1);
  let index = u32(cy) * u32(w) + u32(cx);
  if (from_src) {
    return unpack_source(src[index]);
  }
  return unpack_cell(cells[index]);
}

fn sample_bilinear(from_src: bool, s: vec2<f32>, w: i32, h: i32) -> vec4<f32> {
  let u = s - vec2<f32>(0.5);
  let base = floor(u);
  let frac = u - base;
  let x0 = i32(base.x);
  let y0 = i32(base.y);
  return fetch(from_src, x0, y0, w, h) * ((1.0 - frac.x) * (1.0 - frac.y))
    + fetch(from_src, x0 + 1, y0, w, h) * (frac.x * (1.0 - frac.y))
    + fetch(from_src, x0, y0 + 1, w, h) * ((1.0 - frac.x) * frac.y)
    + fetch(from_src, x0 + 1, y0 + 1, w, h) * (frac.x * frac.y);
}

fn catmull_weights(t: f32) -> vec4<f32> {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4<f32>(
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2,
  );
}

fn sample_bicubic(from_src: bool, s: vec2<f32>, w: i32, h: i32) -> vec4<f32> {
  let u = s - vec2<f32>(0.5);
  let base = floor(u);
  let t = u - base;
  let wx = catmull_weights(t.x);
  let wy = catmull_weights(t.y);
  let x0 = i32(base.x) - 1;
  let y0 = i32(base.y) - 1;
  var acc = vec4<f32>(0.0);
  for (var j = 0; j < 4; j = j + 1) {
    for (var i = 0; i < 4; i = i + 1) {
      acc = acc + fetch(from_src, x0 + i, y0 + j, w, h) * (wx[i] * wy[j]);
    }
  }
  return acc;
}

fn multisample(lo: vec2<f32>, cell: f32, cubic: bool) -> vec4<f32> {
  let w = i32(params.width);
  let h = i32(params.height);
  let grid = clamp(u32(ceil(cell)), 1u, 8u);
  let pitch = cell / f32(grid);
  var acc = vec4<f32>(0.0);
  for (var b = 0u; b < grid; b = b + 1u) {
    for (var a = 0u; a < grid; a = a + 1u) {
      let s = lo + (vec2<f32>(f32(a), f32(b)) + vec2<f32>(0.5)) * pitch;
      if (cubic) {
        acc = acc + sample_bicubic(true, s, w, h);
      } else {
        acc = acc + sample_bilinear(true, s, w, h);
      }
    }
  }
  return acc / f32(grid * grid);
}

fn area(lo: vec2<f32>, hi: vec2<f32>) -> vec4<f32> {
  let w = i32(params.width);
  let h = i32(params.height);
  let x0 = i32(floor(lo.x));
  let x1 = i32(ceil(hi.x)) - 1;
  let y0 = i32(floor(lo.y));
  let y1 = i32(ceil(hi.y)) - 1;
  var acc = vec4<f32>(0.0);
  var total = 0.0;
  for (var y = y0; y <= y1; y = y + 1) {
    let wy = min(f32(y) + 1.0, hi.y) - max(f32(y), lo.y);
    for (var x = x0; x <= x1; x = x + 1) {
      let wx = min(f32(x) + 1.0, hi.x) - max(f32(x), lo.x);
      let weight = wx * wy;
      acc = acc + fetch(true, x, y, w, h) * weight;
      total = total + weight;
    }
  }
  return acc / total;
}

fn down_texel(lo: vec2<f32>, cell: f32) -> vec4<f32> {
  let center = lo + vec2<f32>(cell * 0.5);
  let w = i32(params.width);
  let h = i32(params.height);
  if (params.down == 0u) {
    return fetch(true, i32(floor(center.x)), i32(floor(center.y)), w, h);
  }
  if (params.down == 1u) {
    return sample_bilinear(true, center, w, h);
  }
  if (params.down == 2u) {
    return sample_bicubic(true, center, w, h);
  }
  if (params.down == 5u) {
    return area(lo, lo + vec2<f32>(cell));
  }
  return multisample(lo, cell, params.down == 4u);
}

fn to_byte(value: f32) -> u32 {
  return u32(clamp(floor(value * 255.0 + 0.5), 0.0, 255.0));
}

fn straight_channel(channel: f32, alpha: f32) -> f32 {
  if (alpha > 0.0) {
    return clamp(channel / alpha, 0.0, 1.0);
  }
  return 0.0;
}

@compute @workgroup_size(8, 8)
fn scale_down(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.cols || id.y >= params.rows) {
    return;
  }
  let k = params.origin + vec2<i32>(i32(id.x), i32(id.y));
  let lo = params.plan.xy + vec2<f32>(f32(k.x), f32(k.y)) * params.plan.z;
  let texel = down_texel(lo, params.plan.z);
  cells[id.y * params.cols + id.x] = to_byte(texel.x)
    | (to_byte(texel.y) << 8u)
    | (to_byte(texel.z) << 16u)
    | (to_byte(texel.w) << 24u);
}

@compute @workgroup_size(8, 8)
fn scale_up(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) {
    return;
  }
  let p = vec2<f32>(f32(id.x) + 0.5, f32(id.y) + 0.5);
  let s = (p - params.plan.xy) / params.plan.z - vec2<f32>(f32(params.origin.x), f32(params.origin.y));
  let cols = i32(params.cols);
  let rows = i32(params.rows);
  var texel = vec4<f32>(0.0);
  if (params.up == 0u) {
    texel = fetch(false, i32(floor(s.x)), i32(floor(s.y)), cols, rows);
  } else if (params.up == 1u) {
    texel = sample_bilinear(false, s, cols, rows);
  } else {
    texel = sample_bicubic(false, s, cols, rows);
  }
  let alpha = clamp(texel.w, 0.0, 1.0);
  let word = to_byte(straight_channel(texel.x, alpha))
    | (to_byte(straight_channel(texel.y, alpha)) << 8u)
    | (to_byte(straight_channel(texel.z, alpha)) << 16u)
    | (to_byte(alpha) << 24u);
  dst[id.y * params.width + id.x] = word;
}
`;
