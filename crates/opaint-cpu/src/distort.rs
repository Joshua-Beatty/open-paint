//! The shared distortion engine (FX-A-00-04). A sample map gives the source position for each
//! output pixel. The engine evaluates it at `Quality²` rotated-grid sub-pixel offsets, samples the
//! premultiplied source bilinearly, averages the results, and returns straight alpha. Outside the
//! image, the edge mode decides the color. `packages/effects/src/distortion-wgsl.ts` is the WGSL
//! twin, and it must use the same f32 operations in the same order.

use crate::blur::mirror_index;
use crate::rng::{pcg_hash, PixelRng};
use std::f32::consts::{FRAC_2_PI, PI};

/// The highest Quality (FX-A-00-04, Quality 1-8).
pub const MAX_QUALITY: u8 = 8;

/// What the engine reads outside the source image (FX-A-00-04 step 4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeMode {
    /// Use the nearest edge pixel.
    Clamp = 0,
    /// Tile the image periodically.
    Wrap = 1,
    /// Mirror the image at each edge.
    Reflect = 2,
    /// Outside pixels are transparent black.
    Transparent = 3,
}

impl EdgeMode {
    pub fn from_code(code: u8) -> Result<Self, String> {
        match code {
            0 => Ok(Self::Clamp),
            1 => Ok(Self::Wrap),
            2 => Ok(Self::Reflect),
            3 => Ok(Self::Transparent),
            other => Err(format!("edge mode must be 0-3, got {other}")),
        }
    }
}

/// The sub-pixel offsets of the rotated-grid supersampling (FX-A-00-04 step 2), in pixels. Quality
/// `q` gives `q²` samples; quality 1 gives one sample at the pixel center.
pub fn rgss_offsets(quality: u8) -> Result<Vec<[f32; 2]>, String> {
    if !(1..=MAX_QUALITY).contains(&quality) {
        return Err(format!("quality must be 1-{MAX_QUALITY}, got {quality}"));
    }
    if quality == 1 {
        return Ok(vec![[0.0, 0.0]]);
    }
    let q = f32::from(quality);
    let n = u32::from(quality) * u32::from(quality);
    Ok((0..n)
        .map(|i| {
            let f = (i as f32 + 1.0) / (n as f32 + 1.0);
            let t = f * q;
            [t - t.floor() - 0.5, f - 0.5]
        })
        .collect())
}

/// A premultiplied RGBA texel with each channel in `0..=1`.
pub(crate) type Texel = [f32; 4];

/// The source as premultiplied texels. Each channel is `(c / 255) * (a / 255)`.
pub(crate) fn premultiply(src: &[u8]) -> Vec<Texel> {
    src.as_chunks::<4>()
        .0
        .iter()
        .map(|px| {
            let a = f32::from(px[3]) / 255.0;
            [
                f32::from(px[0]) / 255.0 * a,
                f32::from(px[1]) / 255.0 * a,
                f32::from(px[2]) / 255.0 * a,
                a,
            ]
        })
        .collect()
}

/// The texel at (`x`, `y`) under the edge mode. `None` means transparent black.
pub(crate) fn tap(
    plane: &[Texel],
    width: usize,
    height: usize,
    x: isize,
    y: isize,
    edge: EdgeMode,
) -> Option<Texel> {
    let (w, h) = (width as isize, height as isize);
    let (ix, iy) = match edge {
        EdgeMode::Clamp => (x.clamp(0, w - 1), y.clamp(0, h - 1)),
        EdgeMode::Wrap => (x.rem_euclid(w), y.rem_euclid(h)),
        EdgeMode::Reflect => (
            mirror_index(x, width) as isize,
            mirror_index(y, height) as isize,
        ),
        EdgeMode::Transparent => {
            if x < 0 || y < 0 || x >= w || y >= h {
                return None;
            }
            (x, y)
        }
    };
    Some(plane[iy as usize * width + ix as usize])
}

/// Bilinear sample of the premultiplied plane at the continuous source position `s`, where pixel
/// `i` covers `[i, i + 1)`, so its center is at `i + 0.5`.
pub(crate) fn sample(
    plane: &[Texel],
    width: usize,
    height: usize,
    s: [f32; 2],
    edge: EdgeMode,
) -> Texel {
    let u = s[0] - 0.5;
    let v = s[1] - 0.5;
    let x0 = u.floor();
    let y0 = v.floor();
    let fx = u - x0;
    let fy = v - y0;
    let (ix, iy) = (x0 as isize, y0 as isize);
    let mut out = [0.0f32; 4];
    for (dy, wy) in [(0, 1.0 - fy), (1, fy)] {
        for (dx, wx) in [(0, 1.0 - fx), (1, fx)] {
            if let Some(texel) = tap(plane, width, height, ix + dx, iy + dy, edge) {
                let weight = wx * wy;
                for (acc, value) in out.iter_mut().zip(texel) {
                    *acc += weight * value;
                }
            }
        }
    }
    out
}

pub(crate) fn to_u8(value: f32) -> u8 {
    (value * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8
}

/// Distorts a straight-alpha RGBA8 image with the sample map `map`. The map receives an output
/// pixel's scene position (its center plus the supersampling offset) and returns the source
/// position to read, in the same continuous coordinates.
pub fn distort_with<M>(
    src: &[u8],
    width: usize,
    height: usize,
    quality: u8,
    edge: EdgeMode,
    map: M,
) -> Result<Vec<u8>, String>
where
    M: Fn([f32; 2]) -> [f32; 2],
{
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    let offsets = rgss_offsets(quality)?;
    let plane = premultiply(src);
    let count = offsets.len() as f32;
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let mut acc = [0.0f32; 4];
            for offset in &offsets {
                let scene = [x as f32 + 0.5 + offset[0], y as f32 + 0.5 + offset[1]];
                let texel = sample(&plane, width, height, map(scene), edge);
                for (total, value) in acc.iter_mut().zip(texel) {
                    *total += value;
                }
            }
            push_straight(&mut out, acc.map(|total| total / count));
        }
    }
    Ok(out)
}

/// Appends one premultiplied texel as straight-alpha RGBA8 (color clamped to alpha first).
pub(crate) fn push_straight(out: &mut Vec<u8>, avg: Texel) {
    let alpha = avg[3].clamp(0.0, 1.0);
    for &channel in &avg[..3] {
        let straight = if alpha > 0.0 {
            (channel / alpha).clamp(0.0, 1.0)
        } else {
            0.0
        };
        out.push(to_u8(straight));
    }
    out.push(to_u8(alpha));
}

/// An affine sample map `x' = a x + c y + e`, `y' = b x + d y + f` with `matrix = [a, b, c, d, e, f]`
/// (the convention of `image-transform.ts`).
pub fn affine_map(matrix: [f32; 6]) -> impl Fn([f32; 2]) -> [f32; 2] {
    move |p| {
        [
            matrix[0] * p[0] + matrix[2] * p[1] + matrix[4],
            matrix[1] * p[0] + matrix[3] * p[1] + matrix[5],
        ]
    }
}

/// The center of an effect (FX-DIST-BULGE-03, FX-DIST-TWIST-03): `c = center(B) + Center ⊙ (B.w / 2,
/// B.h / 2)`. The input is the selection's bounds B, so its center is `(width / 2, height / 2)`.
fn effect_center(width: f32, height: f32, offset: [f32; 2]) -> [f32; 2] {
    [
        width / 2.0 + offset[0] * (width / 2.0),
        height / 2.0 + offset[1] * (height / 2.0),
    ]
}

/// The plan of the Bulge sample map (FX-DIST-BULGE-03) over a `width` × `height` region, as
/// `[cx, cy, radius, strength]`. The radius is `min(width, height) / 2`.
pub fn bulge_plan(width: f32, height: f32, center: [f32; 2], strength: f32) -> [f32; 4] {
    let [cx, cy] = effect_center(width, height, center);
    [cx, cy, width.min(height) / 2.0, strength]
}

/// The Bulge sample map for a plan from `bulge_plan`. Inside the radius, with `t = 1 - r / radius`,
/// the source lies at `c + d (1 - strength t²)`. Outside the circle it is the pixel itself.
pub fn bulge_map(plan: [f32; 4]) -> impl Fn([f32; 2]) -> [f32; 2] {
    move |p| {
        let [cx, cy, radius, strength] = plan;
        let (dx, dy) = (p[0] - cx, p[1] - cy);
        let t = 1.0 - (dx * dx + dy * dy).sqrt() / radius;
        if t > 0.0 {
            let k = 1.0 - strength * t * t;
            [cx + dx * k, cy + dy * k]
        } else {
            p
        }
    }
}

/// The plan of the Twist sample map (FX-DIST-TWIST-03), as `[cx, cy, limit, gain]`: `limit` is
/// `σ·Rmax` and `gain` is `τ / 100` radians. `document` is the document's `[width, height]`, which
/// scales the Size by `min(doc) / min(B)`.
pub fn twist_plan(
    width: f32,
    height: f32,
    document: [f32; 2],
    center: [f32; 2],
    amount: f32,
    size: f32,
) -> [f32; 4] {
    let [cx, cy] = effect_center(width, height, center);
    let a = -(amount / 100.0).clamp(-2.0, 2.0);
    let tau = if a == 0.0 {
        0.0
    } else {
        a.signum() * (100.0 * a) * (100.0 * a)
    };
    let diameter = width.min(height);
    let sigma = size * document[0].min(document[1]) / diameter;
    [cx, cy, sigma * diameter / 2.0, tau / 100.0]
}

/// The Twist sample map for a plan from `twist_plan`. A pixel at radius `r` from the center reads
/// the source at radius `r`, turned by `gain · t³` with `t = clamp(1 - r / limit, 0, 1)`.
pub fn twist_map(plan: [f32; 4]) -> impl Fn([f32; 2]) -> [f32; 2] {
    move |p| {
        let [cx, cy, limit, gain] = plan;
        let (dx, dy) = (p[0] - cx, p[1] - cy);
        let r = (dx * dx + dy * dy).sqrt();
        let u = (1.0 - r / limit).clamp(0.0, 1.0);
        let angle = dy.atan2(dx) + u * u * u * gain;
        [cx + r * angle.cos(), cy + r * angle.sin()]
    }
}

fn plan_of(values: &[f32]) -> Result<[f32; 4], String> {
    values
        .try_into()
        .map_err(|_| format!("a sample map plan needs 4 values, got {}", values.len()))
}

/// Bulge through the shared engine, with a plan from `bulge_plan`.
pub fn bulge_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    quality: u8,
    edge: EdgeMode,
    plan: &[f32],
) -> Result<Vec<u8>, String> {
    distort_with(src, width, height, quality, edge, bulge_map(plan_of(plan)?))
}

/// Twist through the shared engine, with a plan from `twist_plan`.
pub fn twist_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    quality: u8,
    edge: EdgeMode,
    plan: &[f32],
) -> Result<Vec<u8>, String> {
    distort_with(src, width, height, quality, edge, twist_map(plan_of(plan)?))
}

/// The plan of the Polar Inversion sample map (FX-DIST-POLAR-03), as `[cx, cy, radius, scale]`. The
/// radius is `Diameter / 2` for the smaller side of the bounds, and the scale is
/// `Scale · min(doc) / min(B)`. `document` is the document's `[width, height]`.
pub fn polar_plan(
    width: f32,
    height: f32,
    document: [f32; 2],
    center: [f32; 2],
    scale: f32,
) -> [f32; 4] {
    let [cx, cy] = effect_center(width, height, center);
    let diameter = width.min(height);
    [
        cx,
        cy,
        diameter / 2.0,
        scale * document[0].min(document[1]) / diameter,
    ]
}

/// The Polar Inversion sample map for a plan from `polar_plan`. With `d = p - c` and `k = lerp(1,
/// R² / |d|², scale)`, the source is `c + d · k`. A pixel at the center reads the center.
pub fn polar_map(plan: [f32; 4]) -> impl Fn([f32; 2]) -> [f32; 2] {
    move |p| {
        let [cx, cy, radius, scale] = plan;
        let (dx, dy) = (p[0] - cx, p[1] - cy);
        let r2 = dx * dx + dy * dy;
        if r2 == 0.0 {
            return [cx, cy];
        }
        let k = 1.0 + scale * (radius * radius / r2 - 1.0);
        [cx + dx * k, cy + dy * k]
    }
}

/// The plan of the Tile Reflection sample map (FX-DIST-TILE-03), as `[ox, oy, cos, sin, k, lambda]`.
/// `origin` is the center of the source bounds in region coordinates. The rotation is `θ = -Angle`,
/// `k = π / TileSize` and `lambda = sign(Curvature) · Curvature² / 10`.
pub fn tile_plan(origin: [f32; 2], angle: f32, tile_size: f32, curvature: f32) -> [f32; 6] {
    let theta = -angle * PI / 180.0;
    [
        origin[0],
        origin[1],
        theta.cos(),
        theta.sin(),
        PI / tile_size,
        curvature.signum() * curvature * curvature / 10.0,
    ]
}

/// `π / 2` in three parts whose multiples by a quadrant count are (nearly) exact.
const TILE_PIO2: [f32; 3] = [1.570_312_5, 4.837_513e-4, 7.549_79e-8];
/// Minimax sine and cosine polynomials on `[-π/4, π/4]`.
const TILE_SIN: [f32; 3] = [-1.666_665_5e-1, 8.332_161e-3, -1.951_529_6e-4];
const TILE_COS: [f32; 3] = [4.166_664_6e-2, -1.388_731_6e-3, 2.443_315_7e-5];
/// The largest tangent magnitude Tile Reflection uses. A pole then never gives infinity or NaN,
/// and with Curvature at most 200 every sample position stays well inside the `i32` range, where
/// both backends convert it to a pixel index exactly (a GPU's conversion of a larger float is not
/// defined).
const TILE_TAN_LIMIT: f32 = 1e5;

/// `1 / b` from the bit-level estimate and three Newton steps.
fn tile_reciprocal(b: f32) -> f32 {
    let a = b.abs();
    let mut y = f32::from_bits(0x7EF3_11C3u32.wrapping_sub(a.to_bits()));
    for _ in 0..3 {
        y = y * (2.0 - a * y);
    }
    if b < 0.0 { -y } else { y }
}

/// The tangent of Tile Reflection (FX-DIST-TILE-03), built from multiplications, additions and a
/// Newton reciprocal only. Near its poles the tangent amplifies any difference in its last bits into
/// another tile; a GPU's `tan` and division are approximate, so the WGSL twin runs these same
/// correctly rounded operations, in the same order, to give the same bits. Accurate to a few ulp.
fn tile_tan(x: f32) -> f32 {
    let n = (x * FRAC_2_PI + 0.5).floor();
    let r = ((x - n * TILE_PIO2[0]) - n * TILE_PIO2[1]) - n * TILE_PIO2[2];
    let z = r * r;
    let s = r + r * z * (TILE_SIN[0] + z * (TILE_SIN[1] + z * TILE_SIN[2]));
    let c = 1.0 - 0.5 * z + z * z * (TILE_COS[0] + z * (TILE_COS[1] + z * TILE_COS[2]));
    let t = if (n as i32) & 1 == 0 {
        s * tile_reciprocal(c)
    } else {
        -c * tile_reciprocal(s)
    };
    t.clamp(-TILE_TAN_LIMIT, TILE_TAN_LIMIT)
}

/// The Tile Reflection sample map for a plan from `tile_plan`. The offset from the origin is rotated
/// by `θ`, each component is bent by `lambda · tan(k · component)`, and the result is rotated back.
pub fn tile_map(plan: [f32; 6]) -> impl Fn([f32; 2]) -> [f32; 2] {
    move |p| {
        let [ox, oy, cos, sin, k, lambda] = plan;
        let (dx, dy) = (p[0] - ox, p[1] - oy);
        let sx = cos * dx - sin * dy;
        let sy = sin * dx + cos * dy;
        let tx = sx + lambda * tile_tan(k * sx);
        let ty = sy + lambda * tile_tan(k * sy);
        [ox + cos * tx + sin * ty, oy - sin * tx + cos * ty]
    }
}

fn tile_plan_of(values: &[f32]) -> Result<[f32; 6], String> {
    values
        .try_into()
        .map_err(|_| format!("a Tile Reflection plan needs 6 values, got {}", values.len()))
}

/// Polar Inversion through the shared engine, with a plan from `polar_plan`.
pub fn polar_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    quality: u8,
    edge: EdgeMode,
    plan: &[f32],
) -> Result<Vec<u8>, String> {
    distort_with(src, width, height, quality, edge, polar_map(plan_of(plan)?))
}

/// Tile Reflection through the shared engine, with a plan from `tile_plan`.
pub fn tile_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    quality: u8,
    edge: EdgeMode,
    plan: &[f32],
) -> Result<Vec<u8>, String> {
    distort_with(src, width, height, quality, edge, tile_map(tile_plan_of(plan)?))
}

/// The engine with an affine sample map, as a flat matrix (`[a, b, c, d, e, f]`).
pub fn distort_affine_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    quality: u8,
    edge: EdgeMode,
    matrix: &[f32],
) -> Result<Vec<u8>, String> {
    let matrix: [f32; 6] = matrix
        .try_into()
        .map_err(|_| format!("affine matrix needs 6 values, got {}", matrix.len()))?;
    distort_with(src, width, height, quality, edge, affine_map(matrix))
}

/// The first fixed permutation of 0-255 (FX-DIST-CRYSTAL-03, FX-DIST-DENTS-03). It is a Fisher-Yates
/// shuffle driven by the PCG hash, so every backend builds the same table.
pub const PERM_A: [u8; 256] = shuffled_table(1);

/// The second fixed permutation of 0-255 (FX-DIST-CRYSTAL-03).
pub const PERM_B: [u8; 256] = shuffled_table(2);

const fn shuffled_table(seed: u32) -> [u8; 256] {
    let mut table = [0u8; 256];
    let mut i = 0;
    while i < 256 {
        table[i] = i as u8;
        i += 1;
    }
    let mut state = seed;
    let mut i = 255;
    while i > 0 {
        state = pcg_hash(state);
        let j = state as usize % (i + 1);
        let held = table[i];
        table[i] = table[j];
        table[j] = held;
        i -= 1;
    }
    table
}

/// Both permutation tables, `PERM_A` then `PERM_B`, for the WGSL twins.
pub fn permutation_tables() -> Vec<u8> {
    [&PERM_A[..], &PERM_B[..]].concat()
}

/// The plan of the Crystalize sample map (FX-DIST-CRYSTAL-03) as `[cell, s0, s1, s2, s3]`: the cell
/// size in pixels, then the four bytes of the hashed effective seed, which salt the lookups.
pub fn crystal_plan(cell: f32, seed: u32) -> [f32; 5] {
    let [s0, s1, s2, s3] = pcg_hash(seed).to_le_bytes();
    [
        cell,
        f32::from(s0),
        f32::from(s1),
        f32::from(s2),
        f32::from(s3),
    ]
}

/// The feature offset of cell (`i`, `j`), each component in `[0, 1)`, from two lookups per axis.
fn feature_offset(i: i32, j: i32, salt: [u32; 4]) -> [f32; 2] {
    let (i, j) = (i as u32, j as u32);
    let a = u32::from(PERM_A[((i.wrapping_add(salt[0])) & 255) as usize]);
    let b = u32::from(PERM_B[((a.wrapping_add(j).wrapping_add(salt[1])) & 255) as usize]);
    let c = u32::from(PERM_B[((i.wrapping_add(salt[2])) & 255) as usize]);
    let d = u32::from(PERM_A[((c.wrapping_add(j).wrapping_add(salt[3])) & 255) as usize]);
    [b as f32 / 256.0, d as f32 / 256.0]
}

/// The Crystalize sample map (FX-DIST-CRYSTAL-03) for a plan from `crystal_plan`. The feature point
/// nearest the pixel, among its cell and the eight neighbors, gives the source at `0.5 + F · cell`.
pub fn crystal_map(plan: [f32; 5]) -> impl Fn([f32; 2]) -> [f32; 2] {
    move |p| {
        let cell = plan[0];
        let salt = [
            plan[1] as u32,
            plan[2] as u32,
            plan[3] as u32,
            plan[4] as u32,
        ];
        let u = [p[0] / cell, p[1] / cell];
        let (ci, cj) = (u[0].floor() as i32, u[1].floor() as i32);
        let mut best = f32::INFINITY;
        let mut feature = [0.0f32; 2];
        for di in -1..=1 {
            for dj in -1..=1 {
                let (i, j) = (ci + di, cj + dj);
                let offset = feature_offset(i, j, salt);
                let f = [i as f32 + offset[0], j as f32 + offset[1]];
                let (dx, dy) = (u[0] - f[0], u[1] - f[1]);
                let d = dx * dx + dy * dy;
                if d < best {
                    best = d;
                    feature = f;
                }
            }
        }
        [0.5 + feature[0] * cell, 0.5 + feature[1] * cell]
    }
}

/// Crystalize through the shared engine (Edge mode Clamp), with a plan from `crystal_plan`.
pub fn crystalize_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    quality: u8,
    plan: &[f32],
) -> Result<Vec<u8>, String> {
    let plan: [f32; 5] = plan
        .try_into()
        .map_err(|_| format!("a Crystalize plan needs 5 values, got {}", plan.len()))?;
    distort_with(
        src,
        width,
        height,
        quality,
        EdgeMode::Clamp,
        crystal_map(plan),
    )
}

/// The plan of the Dents sample map (FX-DIST-DENTS-03) over a `width` × `height` region, from the
/// settings `[scale, refraction, detail, turbulence, angle]` and the effective seed. The result is
/// `[cx, cy, frequency, magnitude, gain, persistence, octaves, cos, sin, seed]`.
pub fn dents_plan(width: f32, height: f32, settings: [f32; 5], seed: u32) -> [f32; 10] {
    let [scale, refraction, detail, turbulence, angle] = settings;
    let size = width.min(height);
    // A Scale of 0 would divide by zero, so it is read as the smallest positive Scale.
    let frequency = (400.0 / (size / 2.0)) / scale.max(0.01);
    let magnitude = (refraction / 100.0) / frequency;
    let gain = 2.0 * PI * turbulence / 10.0;
    let persistence = detail / 100.0;
    let mut octaves = 1.0 + detail / 10.0;
    let limit = (frequency.ln() / 0.5f32.ln()).floor();
    if limit >= 1.0 {
        octaves = octaves.min(limit);
    }
    let radians = angle * PI / 180.0;
    [
        width / 2.0,
        height / 2.0,
        frequency,
        magnitude,
        gain,
        persistence,
        octaves,
        radians.cos(),
        radians.sin(),
        seed as f32,
    ]
}

fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + t * (b - a)
}

fn gradient(hash: u32, x: f32, y: f32) -> f32 {
    match hash & 3 {
        0 => x + y,
        1 => -x + y,
        2 => x - y,
        _ => -x - y,
    }
}

/// The table value of `i` under the seed: `PERM_A` rotated by the seed.
fn seeded_perm(i: u32, seed: u32) -> u32 {
    u32::from(PERM_A[((i.wrapping_add(seed)) & 255) as usize])
}

/// 2-D improved Perlin gradient noise (FX-DIST-DENTS-03), with a quintic fade, in about `[-1, 1]`.
fn perlin(p: [f32; 2], seed: u32) -> f32 {
    let (fx, fy) = (p[0].floor(), p[1].floor());
    let (x, y) = (p[0] - fx, p[1] - fy);
    let xi = ((fx as i32) & 255) as u32;
    let yi = ((fy as i32) & 255) as u32;
    let x1 = (xi + 1) & 255;
    let aa = seeded_perm((seeded_perm(xi, seed).wrapping_add(yi)) & 255, seed);
    let ab = seeded_perm((seeded_perm(xi, seed).wrapping_add(yi + 1)) & 255, seed);
    let ba = seeded_perm((seeded_perm(x1, seed).wrapping_add(yi)) & 255, seed);
    let bb = seeded_perm((seeded_perm(x1, seed).wrapping_add(yi + 1)) & 255, seed);
    let (u, v) = (fade(x), fade(y));
    let lower = lerp(gradient(aa, x, y), gradient(ba, x - 1.0, y), u);
    let upper = lerp(gradient(ab, x, y - 1.0), gradient(bb, x - 1.0, y - 1.0), u);
    lerp(lower, upper, v)
}

fn rotate(v: [f32; 2], rotation: [f32; 2]) -> [f32; 2] {
    [
        rotation[0] * v[0] - rotation[1] * v[1],
        rotation[1] * v[0] + rotation[0] * v[1],
    ]
}

/// The fractal sum of Dents' noise (FX-DIST-DENTS-03). Each octave samples the rotated coordinates,
/// then the coordinates are rotated again, doubled and offset by (499, 506). The amplitude is
/// multiplied by `persistence` per octave, and the sum stops once it falls below 0.001. The last
/// octave is weighted by the fractional part of `octaves`.
fn turbulence(v: [f32; 2], rotation: [f32; 2], octaves: f32, persistence: f32, seed: u32) -> f32 {
    let mut q = rotate(v, rotation);
    let mut amplitude = 1.0f32;
    let mut sum = 0.0f32;
    let mut k = 0.0f32;
    loop {
        let remaining = octaves - k;
        if remaining <= 0.0 {
            break;
        }
        sum += amplitude * remaining.min(1.0) * perlin(q, seed);
        amplitude *= persistence;
        if amplitude < 0.001 {
            break;
        }
        let r = rotate(q, rotation);
        q = [2.0 * r[0] + 499.0, 2.0 * r[1] + 506.0];
        k += 1.0;
    }
    sum
}

/// The Dents sample map (FX-DIST-DENTS-03) for a plan from `dents_plan`. Each pixel is displaced by
/// `magnitude · (−sin φ, cos φ)`, where `φ = gain · turbulence(p − center) · frequency`.
pub fn dents_map(plan: [f32; 10]) -> impl Fn([f32; 2]) -> [f32; 2] {
    move |p| {
        let [cx, cy, frequency, magnitude, gain, persistence, octaves, cos, sin, seed] = plan;
        let v = [(p[0] - cx) * frequency, (p[1] - cy) * frequency];
        let phi = gain * turbulence(v, [cos, sin], octaves, persistence, seed as u32);
        [p[0] + magnitude * -phi.sin(), p[1] + magnitude * phi.cos()]
    }
}

/// Dents through the shared engine (Edge mode Reflect), with a plan from `dents_plan`.
pub fn dents_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    quality: u8,
    plan: &[f32],
) -> Result<Vec<u8>, String> {
    let plan: [f32; 10] = plan
        .try_into()
        .map_err(|_| format!("a Dents plan needs 10 values, got {}", plan.len()))?;
    distort_with(
        src,
        width,
        height,
        quality,
        EdgeMode::Reflect,
        dents_map(plan),
    )
}

/// The offset of one Frosted Glass sample (FX-DIST-FROST-03). With `plan` = `[min, max, p]`, the draw
/// `u1` sets the angle `2π·u1` and `u2` sets the radius `(minᵖ + u2·(maxᵖ − minᵖ))^(1/p)`.
pub fn frost_offset(plan: [f32; 3], u1: f32, u2: f32) -> [f32; 2] {
    let [min, max, diffusion] = plan;
    let theta = 2.0 * PI * u1;
    let lo = min.powf(diffusion);
    let hi = max.powf(diffusion);
    let base = lo + u2 * (hi - lo);
    let radius = if base > 0.0 {
        base.powf(1.0 / diffusion)
    } else {
        0.0
    };
    [radius * theta.cos(), radius * theta.sin()]
}

/// Frosted Glass through the shared engine (FX-DIST-FROST-03). Each seed is one sample map: a
/// pixel's own generator under that seed gives one random scatter, read bilinearly with the Reflect
/// edge. The `seeds.len()` samples are averaged on premultiplied values, with no RGSS offsets.
pub fn frost_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    plan: &[f32],
    seeds: &[u32],
) -> Result<Vec<u8>, String> {
    let plan: [f32; 3] = plan
        .try_into()
        .map_err(|_| format!("a Frosted Glass plan needs 3 values, got {}", plan.len()))?;
    if seeds.is_empty() {
        return Err("Frosted Glass needs at least one sample map".to_string());
    }
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    let plane = premultiply(src);
    let count = seeds.len() as f32;
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let mut acc = [0.0f32; 4];
            for &seed in seeds {
                let mut rng = PixelRng::new(seed, x as u32, y as u32);
                let u1 = rng.next_unit();
                let u2 = rng.next_unit();
                let offset = frost_offset(plan, u1, u2);
                let scene = [x as f32 + 0.5 + offset[0], y as f32 + 0.5 + offset[1]];
                let texel = sample(&plane, width, height, scene, EdgeMode::Reflect);
                for (total, value) in acc.iter_mut().zip(texel) {
                    *total += value;
                }
            }
            push_straight(&mut out, acc.map(|total| total / count));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: [f32; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

    fn ramp(width: usize, height: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                out.extend_from_slice(&[
                    (x * 37 % 256) as u8,
                    (y * 61 % 256) as u8,
                    ((x + y) * 13 % 256) as u8,
                    255,
                ]);
            }
        }
        out
    }

    fn run(src: &[u8], w: usize, h: usize, q: u8, edge: EdgeMode, m: [f32; 6]) -> Vec<u8> {
        distort_affine_rgba8(src, w, h, q, edge, &m).expect("valid inputs")
    }

    #[test]
    fn quality_one_samples_only_the_pixel_center() {
        assert_eq!(rgss_offsets(1).unwrap(), vec![[0.0, 0.0]]);
    }

    #[test]
    fn rotated_grid_offsets_follow_the_spec_formula() {
        let offsets = rgss_offsets(2).unwrap();
        assert_eq!(offsets.len(), 4);
        // i = 0: n = 4, f = 0.2, frac(0.4) - 0.5 = -0.1, f - 0.5 = -0.3.
        assert!((offsets[0][0] - -0.1).abs() < 1e-6);
        assert!((offsets[0][1] - -0.3).abs() < 1e-6);
        // i = 2: f = 0.6, frac(1.2) - 0.5 = -0.3, f - 0.5 = 0.1.
        assert!((offsets[2][0] - -0.3).abs() < 1e-6);
        assert!((offsets[2][1] - 0.1).abs() < 1e-6);
        for quality in 1..=MAX_QUALITY {
            let offsets = rgss_offsets(quality).unwrap();
            assert_eq!(offsets.len(), usize::from(quality).pow(2));
            assert!(offsets
                .iter()
                .all(|o| o.iter().all(|v| (-0.5..0.5).contains(v))));
        }
    }

    #[test]
    fn quality_outside_one_to_eight_is_an_error() {
        assert!(rgss_offsets(0).is_err());
        assert!(rgss_offsets(9).is_err());
        assert!(EdgeMode::from_code(4).is_err());
        assert_eq!(EdgeMode::from_code(3).unwrap(), EdgeMode::Transparent);
    }

    #[test]
    fn identity_map_at_quality_one_returns_an_opaque_image_unchanged() {
        let src = ramp(7, 5);
        assert_eq!(run(&src, 7, 5, 1, EdgeMode::Clamp, IDENTITY), src);
    }

    #[test]
    fn straight_alpha_survives_the_round_trip_within_one() {
        let src: Vec<u8> = [200u8, 100, 50, 128].repeat(9);
        let out = run(&src, 3, 3, 1, EdgeMode::Transparent, IDENTITY);
        for (a, b) in out.iter().zip(&src) {
            assert!(a.abs_diff(*b) <= 1, "{a} vs {b}");
        }
    }

    #[test]
    fn uniform_images_stay_uniform_at_every_quality() {
        let src = [30u8, 60, 90, 255].repeat(16);
        for quality in 1..=MAX_QUALITY {
            assert_eq!(run(&src, 4, 4, quality, EdgeMode::Wrap, IDENTITY), src);
        }
    }

    #[test]
    fn supersampling_changes_a_sharp_edge_at_higher_quality() {
        let mut src = Vec::new();
        for _y in 0..4 {
            for x in 0..8 {
                let v = if x < 4 { 0u8 } else { 255 };
                src.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let one = run(&src, 8, 4, 1, EdgeMode::Clamp, IDENTITY);
        let four = run(&src, 8, 4, 2, EdgeMode::Clamp, IDENTITY);
        assert_ne!(one, four);
        // The sharp step blurs by about a pixel at the boundary, and nowhere else.
        assert!(four[3 * 4] > 0 && four[3 * 4] < 255);
        assert_eq!(four[0], 0);
        assert_eq!(four[7 * 4], 255);
    }

    #[test]
    fn a_whole_pixel_shift_reads_the_neighbor_under_each_edge_mode() {
        let (w, h) = (4, 1);
        let src = [10u8, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255];
        let shift_left = [1.0, 0.0, 0.0, 1.0, 1.0, 0.0];
        let clamp = run(&src, w, h, 1, EdgeMode::Clamp, shift_left);
        assert_eq!(clamp[12], 40);
        assert_eq!(clamp[0], 20);
        let wrap = run(&src, w, h, 1, EdgeMode::Wrap, shift_left);
        assert_eq!(wrap[12], 10);
        let reflect = run(&src, w, h, 1, EdgeMode::Reflect, shift_left);
        assert_eq!(reflect[12], 40);
        let transparent = run(&src, w, h, 1, EdgeMode::Transparent, shift_left);
        assert_eq!(transparent[12..16], [0, 0, 0, 0]);
        assert_eq!(transparent[0], 20);
    }

    #[test]
    fn reflect_mirrors_the_image_at_the_far_edge() {
        let src = [10u8, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255];
        let shift_right = [1.0, 0.0, 0.0, 1.0, -1.0, 0.0];
        let out = run(&src, 4, 1, 1, EdgeMode::Reflect, shift_right);
        // Pixel 0 reads x = -1, which mirrors to pixel 0 itself.
        assert_eq!(out[0], 10);
        assert_eq!(out[4], 10);
        let clamp = run(&src, 4, 1, 1, EdgeMode::Clamp, shift_right);
        assert_eq!(clamp[0], 10);
        assert_eq!(clamp[4], 10);
    }

    #[test]
    fn transparent_pixels_and_the_outputs_alpha_follow_the_source() {
        let src = [0u8, 0, 0, 0, 255, 255, 255, 255];
        let out = run(&src, 2, 1, 1, EdgeMode::Transparent, IDENTITY);
        assert_eq!(&out[..4], &[0, 0, 0, 0]);
        assert_eq!(&out[4..], &[255, 255, 255, 255]);
    }

    #[test]
    fn bulge_plan_centers_on_the_bounds_and_takes_the_smaller_radius() {
        assert_eq!(
            bulge_plan(40.0, 24.0, [0.0, 0.0], 0.45),
            [20.0, 12.0, 12.0, 0.45]
        );
        // Center ⊙ (w/2, h/2): a full offset of +1 moves the center to the right edge.
        assert_eq!(
            bulge_plan(40.0, 24.0, [1.0, -1.0], 0.0),
            [40.0, 0.0, 12.0, 0.0]
        );
    }

    #[test]
    fn bulge_fixes_its_center_and_leaves_the_outside_alone() {
        let map = bulge_map(bulge_plan(40.0, 24.0, [0.0, 0.0], 0.8));
        assert_eq!(map([20.0, 12.0]), [20.0, 12.0]);
        // (0.5, 0.5) is outside the radius-12 circle, so it reads itself.
        assert_eq!(map([0.5, 0.5]), [0.5, 0.5]);
    }

    #[test]
    fn positive_bulge_pulls_samples_toward_the_center_and_negative_pushes_them_out() {
        let plan = bulge_plan(40.0, 24.0, [0.0, 0.0], 0.45);
        let p = [26.0, 12.0];
        let swell = bulge_map(plan)(p);
        assert!(swell[0] < p[0] && swell[0] > 20.0, "{swell:?}");
        assert_eq!(swell[1], 12.0);
        let pinch = bulge_map(bulge_plan(40.0, 24.0, [0.0, 0.0], -0.45))(p);
        assert!(pinch[0] > p[0], "{pinch:?}");
    }

    #[test]
    fn zero_strength_bulge_and_zero_amount_twist_are_the_identity() {
        let src = ramp(12, 8);
        let bulge = bulge_rgba8(
            &src,
            12,
            8,
            1,
            EdgeMode::Clamp,
            &bulge_plan(12.0, 8.0, [0.0, 0.0], 0.0),
        )
        .unwrap();
        assert_eq!(bulge, src);
        let twist = twist_rgba8(
            &src,
            12,
            8,
            1,
            EdgeMode::Clamp,
            &twist_plan(12.0, 8.0, [12.0, 8.0], [0.0, 0.0], 0.0, 1.0),
        )
        .unwrap();
        assert_eq!(twist, src);
    }

    #[test]
    fn twist_plan_follows_the_amount_sign_and_normalizes_size_by_the_document() {
        let plan = twist_plan(40.0, 24.0, [80.0, 60.0], [0.0, 0.0], 30.0, 1.0);
        // a = -0.3 and τ = sign(a)·(100a)² = -900, so the gain τ / 100 is -9 radians.
        assert!((plan[3] - -9.0).abs() < 1e-4, "{plan:?}");
        assert!((plan[2] - 30.0).abs() < 1e-4, "{plan:?}");
        let negative = twist_plan(40.0, 24.0, [80.0, 60.0], [0.0, 0.0], -30.0, 1.0);
        assert!((negative[3] - 9.0).abs() < 1e-4);
        // A document the size of the selection leaves the 12 px radius as it is.
        assert_eq!(
            twist_plan(40.0, 24.0, [40.0, 24.0], [0.0, 0.0], 30.0, 1.0)[2],
            12.0
        );
    }

    #[test]
    fn twist_keeps_each_radius_and_stops_outside_its_limit() {
        let plan = twist_plan(40.0, 24.0, [40.0, 24.0], [0.0, 0.0], 100.0, 1.0);
        let map = twist_map(plan);
        let center = [20.0, 12.0];
        // Inside the limit (12 px): the radius of the source equals the radius of the pixel.
        let p = [center[0] + 4.0, center[1] + 3.0];
        let s = map(p);
        let radius = ((s[0] - center[0]).powi(2) + (s[1] - center[1]).powi(2)).sqrt();
        assert!((radius - 5.0).abs() < 1e-4, "{s:?}");
        assert_ne!(s, p);
        // Beyond the limit the source is the pixel itself.
        let far = [center[0] + 20.0, center[1]];
        let s = map(far);
        assert!(
            (s[0] - far[0]).abs() < 1e-4 && (s[1] - far[1]).abs() < 1e-4,
            "{s:?}"
        );
    }

    #[test]
    fn plans_with_the_wrong_length_are_rejected() {
        let src = ramp(2, 2);
        assert!(bulge_rgba8(&src, 2, 2, 1, EdgeMode::Clamp, &[1.0; 3]).is_err());
        assert!(twist_rgba8(&src, 2, 2, 1, EdgeMode::Clamp, &[1.0; 5]).is_err());
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        let src = ramp(2, 2);
        assert!(distort_affine_rgba8(&src, 2, 2, 0, EdgeMode::Clamp, &IDENTITY).is_err());
        assert!(distort_affine_rgba8(&src, 2, 2, 1, EdgeMode::Clamp, &[1.0; 5]).is_err());
        assert!(distort_affine_rgba8(&src, 3, 2, 1, EdgeMode::Clamp, &IDENTITY).is_err());
    }

    #[test]
    fn permutation_tables_are_permutations_and_differ() {
        for table in [PERM_A, PERM_B] {
            let mut seen = [false; 256];
            for value in table {
                seen[value as usize] = true;
            }
            assert!(seen.iter().all(|&hit| hit));
        }
        assert_ne!(PERM_A, PERM_B);
        assert_eq!(permutation_tables().len(), 512);
    }

    #[test]
    fn crystal_plan_salts_the_cell_with_the_hashed_seed() {
        let plan = crystal_plan(8.0, 0x1234_5678);
        assert_eq!(plan[0], 8.0);
        let bytes = pcg_hash(0x1234_5678).to_le_bytes();
        for (value, byte) in plan[1..].iter().zip(bytes) {
            assert_eq!(*value, f32::from(byte));
        }
        assert_ne!(crystal_plan(8.0, 1), crystal_plan(8.0, 2));
    }

    #[test]
    fn crystal_feature_offsets_stay_in_the_unit_square_and_vary_by_cell() {
        let salt = [3, 9, 27, 81];
        let mut seen = Vec::new();
        for i in -3..3 {
            for j in -3..3 {
                let offset = feature_offset(i, j, salt);
                assert!((0.0..1.0).contains(&offset[0]) && (0.0..1.0).contains(&offset[1]));
                seen.push(offset);
            }
        }
        seen.dedup();
        assert!(seen.len() > 30, "only {} distinct offsets", seen.len());
    }

    #[test]
    fn crystal_sources_sit_at_nearby_feature_points() {
        let cell = 8.0;
        let map = crystal_map(crystal_plan(cell, 5));
        for y in 0..24 {
            for x in 0..40 {
                let p = [x as f32 + 0.5, y as f32 + 0.5];
                let s = map(p);
                assert!(
                    (s[0] - p[0]).abs() <= 2.0 * cell + 1.0
                        && (s[1] - p[1]).abs() <= 2.0 * cell + 1.0,
                    "{p:?} reads {s:?}"
                );
            }
        }
    }

    #[test]
    fn crystal_map_gives_each_region_one_source_color() {
        let cell = 16.0;
        let map = crystal_map(crystal_plan(cell, 7));
        let centre = map([8.0, 8.0]);
        assert_eq!(map([7.5, 7.5]), centre);
        assert_eq!(map([8.5, 8.5]), centre);
    }

    #[test]
    fn crystalize_keeps_a_uniform_image_uniform_and_follows_the_seed() {
        let uniform: Vec<u8> = [90u8, 40, 200, 255].repeat(12 * 8);
        let out = crystalize_rgba8(&uniform, 12, 8, 2, &crystal_plan(4.0, 0)).unwrap();
        assert_eq!(out, uniform);
        let src = ramp(24, 16);
        let a = crystalize_rgba8(&src, 24, 16, 1, &crystal_plan(5.0, 1)).unwrap();
        let b = crystalize_rgba8(&src, 24, 16, 1, &crystal_plan(5.0, 2)).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn dents_plan_follows_the_spec_constants() {
        let plan = dents_plan(200.0, 200.0, [25.0, 50.0, 10.0, 10.0, 0.0], 7);
        let close = |a: f32, b: f32| (a - b).abs() < 1e-4;
        assert!(close(plan[0], 100.0) && close(plan[1], 100.0));
        // f = (400 / (200 / 2)) / 25 = 0.16, m = 0.5 / 0.16, g = 2π, a = 0.1.
        assert!(close(plan[2], 0.16), "{plan:?}");
        assert!(close(plan[3], 0.5 / 0.16), "{plan:?}");
        assert!(close(plan[4], 2.0 * PI));
        assert!(close(plan[5], 0.1));
        // 1 + Detail / 10 = 2, limited to floor(log0.5 0.16) = 2.
        assert!(close(plan[6], 2.0));
        assert!(close(plan[7], 1.0) && close(plan[8], 0.0));
        assert_eq!(plan[9], 7.0);
    }

    #[test]
    fn dents_octaves_are_limited_by_the_frequency_and_by_detail() {
        let fine = dents_plan(200.0, 200.0, [200.0, 50.0, 100.0, 10.0, 0.0], 0);
        // f = 0.02, so floor(log0.5 f) = 5, which is below 1 + 100 / 10.
        assert!(fine[6] == 5.0, "{fine:?}");
        // A Scale of 0 is read as 0.01, so f = 400 and no frequency limit applies.
        let zero = dents_plan(200.0, 200.0, [0.0, 50.0, 100.0, 10.0, 0.0], 0);
        assert!(zero[2].is_finite() && zero[6] == 11.0, "{zero:?}");
    }

    #[test]
    fn perlin_noise_is_zero_at_the_lattice_points() {
        for (x, y) in [(0.0, 0.0), (3.0, 7.0), (-2.0, 5.0)] {
            assert_eq!(perlin([x, y], 0), 0.0);
        }
        let inside = perlin([0.37, 0.61], 0);
        assert!(inside.abs() > 0.0 && inside.abs() <= 1.0, "{inside}");
    }

    #[test]
    fn zero_refraction_dents_leave_the_image_unchanged() {
        let src = ramp(10, 6);
        let plan = dents_plan(10.0, 6.0, [25.0, 0.0, 10.0, 10.0, 0.0], 3);
        assert_eq!(dents_rgba8(&src, 10, 6, 1, &plan).unwrap(), src);
    }

    #[test]
    fn dents_displace_each_pixel_by_the_refraction_magnitude() {
        let plan = dents_plan(40.0, 24.0, [25.0, 50.0, 10.0, 10.0, 30.0], 9);
        let map = dents_map(plan);
        for p in [[5.5, 4.5], [20.5, 12.5], [33.5, 20.5]] {
            let s = map(p);
            let shift = ((s[0] - p[0]).powi(2) + (s[1] - p[1]).powi(2)).sqrt();
            assert!((shift - plan[3]).abs() < 1e-3, "{p:?} moved {shift}");
        }
    }

    #[test]
    fn dents_and_crystalize_reject_plans_of_the_wrong_length() {
        let src = ramp(2, 2);
        assert!(dents_rgba8(&src, 2, 2, 1, &[1.0; 9]).is_err());
        assert!(crystalize_rgba8(&src, 2, 2, 1, &[1.0; 4]).is_err());
    }

    #[test]
    fn frost_radius_stays_between_the_scatter_limits() {
        for diffusion in [0.5f32, 1.0, 2.0] {
            let plan = [2.0, 5.0, diffusion];
            for step in 0..20 {
                let u2 = step as f32 / 20.0;
                let offset = frost_offset(plan, 0.3, u2);
                let radius = offset[0].hypot(offset[1]);
                assert!((2.0 - 1e-4..=5.0 + 1e-4).contains(&radius), "{radius}");
            }
            let at_min = frost_offset(plan, 0.0, 0.0);
            assert!((at_min[0].hypot(at_min[1]) - 2.0).abs() < 1e-4);
        }
    }

    #[test]
    fn frost_with_no_scatter_returns_the_image() {
        let src = ramp(6, 4);
        let out = frost_rgba8(&src, 6, 4, &[0.0, 0.0, 1.0], &[1, 2, 3]).unwrap();
        assert_eq!(out, src);
    }

    #[test]
    fn frost_keeps_a_uniform_image_uniform() {
        let src = [30u8, 60, 90, 255].repeat(20);
        let out = frost_rgba8(&src, 5, 4, &[3.0, 6.0, 1.0], &[11, 12, 13, 14, 15]).unwrap();
        assert_eq!(out, src);
    }

    #[test]
    fn frost_pattern_follows_the_seeds() {
        let src = ramp(16, 12);
        let plan = [0.0, 6.0, 1.0];
        let one = frost_rgba8(&src, 16, 12, &plan, &[1]).unwrap();
        assert_ne!(one, frost_rgba8(&src, 16, 12, &plan, &[2]).unwrap());
        assert_ne!(one, frost_rgba8(&src, 16, 12, &plan, &[1, 2]).unwrap());
        assert_eq!(one, frost_rgba8(&src, 16, 12, &plan, &[1]).unwrap());
    }

    #[test]
    fn frost_rejects_bad_plans_seeds_and_sizes() {
        let src = ramp(2, 2);
        assert!(frost_rgba8(&src, 2, 2, &[1.0, 2.0], &[1]).is_err());
        assert!(frost_rgba8(&src, 2, 2, &[1.0, 2.0, 1.0], &[]).is_err());
        assert!(frost_rgba8(&src, 3, 2, &[1.0, 2.0, 1.0], &[1]).is_err());
    }

    #[test]
    fn polar_plan_normalizes_the_scale_by_the_document_and_the_smaller_side() {
        assert_eq!(
            polar_plan(40.0, 24.0, [40.0, 24.0], [0.0, 0.0], 1.0),
            [20.0, 12.0, 12.0, 1.0]
        );
        // min(doc) / min(B) = 60 / 24 = 2.5 scales the inversion strength.
        assert_eq!(
            polar_plan(40.0, 24.0, [80.0, 60.0], [0.0, 0.0], 1.0)[3],
            2.5
        );
    }

    #[test]
    fn polar_full_scale_inverts_the_radius_and_keeps_the_angle() {
        let map = polar_map(polar_plan(40.0, 24.0, [40.0, 24.0], [0.0, 0.0], 1.0));
        // d = (6, 0), so the source is at R² / |d| = 144 / 6 = 24 from the center.
        let s = map([26.0, 12.0]);
        assert!((s[0] - 44.0).abs() < 1e-4 && (s[1] - 12.0).abs() < 1e-4, "{s:?}");
        // Inversion is an involution: mapping the source again returns the pixel.
        let back = map(s);
        assert!((back[0] - 26.0).abs() < 1e-3 && (back[1] - 12.0).abs() < 1e-3, "{back:?}");
        assert_eq!(map([20.0, 12.0]), [20.0, 12.0]);
    }

    #[test]
    fn zero_scale_polar_inversion_is_the_identity() {
        let src = ramp(12, 8);
        let plan = polar_plan(12.0, 8.0, [12.0, 8.0], [0.0, 0.0], 0.0);
        assert_eq!(polar_rgba8(&src, 12, 8, 1, EdgeMode::Clamp, &plan).unwrap(), src);
    }

    #[test]
    fn tile_plan_takes_the_rotation_from_the_negated_angle_and_the_curvature_squared() {
        let plan = tile_plan([20.0, 12.0], 30.0, 40.0, -8.0);
        let close = |a: f32, b: f32| (a - b).abs() < 1e-5;
        assert!(close(plan[2], (-30f32).to_radians().cos()), "{plan:?}");
        assert!(close(plan[3], (-30f32).to_radians().sin()), "{plan:?}");
        assert!(close(plan[4], PI / 40.0));
        // sign(-8) · 8² / 10 = -6.4.
        assert!(close(plan[5], -6.4), "{plan:?}");
    }

    #[test]
    fn zero_curvature_tile_reflection_is_the_identity() {
        let map = tile_map(tile_plan([10.0, 6.0], 45.0, 25.0, 0.0));
        for p in [[0.5, 0.5], [7.5, 2.5], [19.5, 11.5]] {
            let s = map(p);
            assert!((s[0] - p[0]).abs() < 1e-4 && (s[1] - p[1]).abs() < 1e-4, "{s:?}");
        }
    }

    #[test]
    fn tile_reflection_bends_the_axis_by_the_curvature_at_its_angle() {
        // Angle 0 and origin 0: a point at x = 10 with tile 40 has k·x = π/4, so tan = 1 and the
        // source moves by λ = 8² / 10 = 6.4.
        let map = tile_map(tile_plan([0.0, 0.0], 0.0, 40.0, 8.0));
        let s = map([10.0, 0.0]);
        assert!((s[0] - 16.4).abs() < 1e-3 && s[1].abs() < 1e-5, "{s:?}");
    }

    #[test]
    fn tile_tangent_is_accurate_and_finite_at_the_poles() {
        let mut x = -200.0f32;
        while x < 200.0 {
            let exact = f64::from(x).tan();
            let ours = f64::from(tile_tan(x));
            if exact.abs() < 1e4 {
                assert!(
                    (ours - exact).abs() <= 2e-6 * exact.abs().max(1.0),
                    "tan({x}) = {ours}, not {exact}"
                );
            }
            x += 0.013;
        }
        assert_eq!(tile_tan(0.0), 0.0);
        for pole in [std::f32::consts::FRAC_PI_2, -std::f32::consts::FRAC_PI_2, 1e4] {
            assert!(tile_tan(pole).is_finite());
        }
        assert!((tile_reciprocal(-3.0) + 1.0 / 3.0).abs() < 1e-7);
    }

    #[test]
    fn tile_reflection_keeps_a_uniform_image_uniform_and_rejects_bad_plans() {
        let src = [30u8, 60, 90, 255].repeat(20);
        let plan = tile_plan([2.0, 2.0], 30.0, 6.0, 8.0);
        assert_eq!(tile_rgba8(&src, 5, 4, 2, EdgeMode::Reflect, &plan).unwrap(), src);
        assert!(tile_rgba8(&src, 5, 4, 1, EdgeMode::Reflect, &[1.0; 5]).is_err());
        assert!(polar_rgba8(&src, 5, 4, 1, EdgeMode::Reflect, &[1.0; 3]).is_err());
    }
}
