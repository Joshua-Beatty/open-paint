//! Affine resampling of straight-alpha RGBA8 pixels for Move Selected Pixels (04 TL-MOVE-PIX-01,
//! TL-OPT-RESAMP and TL-OPT-GAMMA). Each destination pixel maps back to source coordinates through
//! the inverse transform, then takes a weighted mix of source pixels with the chosen filter. Color is
//! averaged premultiplied (in linear light when `linear_light` is set), so transparent neighbors do
//! not darken the edges.

use crate::srgb::{to_linear, to_srgb};

/// The TL-OPT-RESAMP choices, in the order of their WASM ids: Nearest Neighbor, Bilinear, Multisample
/// Bilinear, Anisotropic and High Quality Cubic (Catmull-Rom).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sampling {
    Nearest,
    Linear,
    Multisample,
    Anisotropic,
    Cubic,
}

impl TryFrom<u8> for Sampling {
    type Error = u8;

    fn try_from(id: u8) -> Result<Self, u8> {
        Ok(match id {
            0 => Self::Nearest,
            1 => Self::Linear,
            2 => Self::Multisample,
            3 => Self::Anisotropic,
            4 => Self::Cubic,
            other => return Err(other),
        })
    }
}

/// A transform to apply. `inverse` maps a destination pixel center `(x + 0.5, y + 0.5)` to continuous
/// source coordinates, where source pixel `i` covers `[i, i + 1)`. Its six values are `a, b, c, d, e, f`
/// with `x' = a x + c y + e` and `y' = b x + d y + f`.
pub struct Spec<'a> {
    pub src: &'a [u8],
    pub src_width: usize,
    pub src_height: usize,
    pub dst_width: usize,
    pub dst_height: usize,
    pub inverse: [f64; 6],
    pub sampling: Sampling,
    pub linear_light: bool,
}

/// Samples per footprint axis for Multisample Bilinear (a fixed 4 by 4 grid).
const MULTISAMPLE_GRID: usize = 4;

/// The most samples per footprint axis for Anisotropic sampling, so large reductions stay bounded.
const MAX_ANISOTROPIC_AXIS: usize = 16;

type Premultiplied = [f32; 4];

/// Resamples `spec.src` through the transform and returns straight-alpha RGBA8 of the destination size.
pub fn transform_rgba8(spec: &Spec) -> Result<Vec<u8>, String> {
    transform_rows_rgba8(spec, 0, spec.dst_height)
}

/// Rows `first .. first + rows` of `transform_rgba8`'s result, byte for byte: each pixel takes the
/// same arithmetic as in the whole result, so bands computed apart join into it exactly.
pub fn transform_rows_rgba8(spec: &Spec, first: usize, rows: usize) -> Result<Vec<u8>, String> {
    if first + rows > spec.dst_height {
        return Err("the rows lie outside the destination".to_owned());
    }
    if spec.src.len() != spec.src_width * spec.src_height * 4 {
        return Err("the source pixels do not match its size".to_owned());
    }
    if spec.inverse.iter().any(|value| !value.is_finite()) {
        return Err("the transform must have finite coefficients".to_owned());
    }
    let source = premultiplied(spec);
    let [a, b, c, d, e, f] = spec.inverse;
    let v1 = (a, b);
    let v2 = (c, d);
    let (grid_x, grid_y) = footprint_grid(spec.sampling, v1, v2);
    let mut out = vec![0u8; spec.dst_width * rows * 4];
    for row in 0..rows {
        let y = first + row;
        for x in 0..spec.dst_width {
            let cx = x as f64 + 0.5;
            let cy = y as f64 + 0.5;
            let center = (a * cx + c * cy + e, b * cx + d * cy + f);
            let color = match spec.sampling {
                Sampling::Nearest => nearest(&source, spec, center),
                Sampling::Cubic => cubic(&source, spec, center),
                Sampling::Linear => linear(&source, spec, center),
                Sampling::Multisample | Sampling::Anisotropic => {
                    footprint_average(&source, spec, center, v1, v2, grid_x, grid_y)
                }
            };
            let index = (row * spec.dst_width + x) * 4;
            out[index..index + 4].copy_from_slice(&encode(color, spec.linear_light));
        }
    }
    Ok(out)
}

/// Converts the source to premultiplied floats, decoding color to linear light when asked.
fn premultiplied(spec: &Spec) -> Vec<Premultiplied> {
    spec.src
        .as_chunks::<4>()
        .0
        .iter()
        .map(|px| {
            let alpha = f32::from(px[3]) / 255.0;
            if px[3] == 0 {
                return [0.0; 4];
            }
            let channel = |value: u8| {
                let v = f32::from(value) / 255.0;
                let v = if spec.linear_light { to_linear(v) } else { v };
                v * alpha
            };
            [channel(px[0]), channel(px[1]), channel(px[2]), alpha]
        })
        .collect()
}

/// The sample grid over one footprint of a destination pixel: `(n, m)` samples along the two
/// footprint vectors. Anisotropic sampling takes one sample per source pixel of footprint, up to a
/// cap. Multisample uses its fixed grid. The other filters do not average a footprint.
fn footprint_grid(sampling: Sampling, v1: (f64, f64), v2: (f64, f64)) -> (usize, usize) {
    match sampling {
        Sampling::Multisample => (MULTISAMPLE_GRID, MULTISAMPLE_GRID),
        Sampling::Anisotropic => (axis_samples(v1), axis_samples(v2)),
        _ => (1, 1),
    }
}

fn axis_samples(v: (f64, f64)) -> usize {
    let length = v.0.hypot(v.1);
    (length.ceil() as usize).clamp(1, MAX_ANISOTROPIC_AXIS)
}

/// Averages bilinear samples over the parallelogram that one destination pixel covers in the source.
fn footprint_average(
    source: &[Premultiplied],
    spec: &Spec,
    center: (f64, f64),
    v1: (f64, f64),
    v2: (f64, f64),
    n: usize,
    m: usize,
) -> Premultiplied {
    let mut sum = [0.0f32; 4];
    for j in 0..m {
        let t2 = (j as f64 + 0.5) / m as f64 - 0.5;
        for i in 0..n {
            let t1 = (i as f64 + 0.5) / n as f64 - 0.5;
            let p = (
                center.0 + t1 * v1.0 + t2 * v2.0,
                center.1 + t1 * v1.1 + t2 * v2.1,
            );
            add(&mut sum, linear(source, spec, p), 1.0);
        }
    }
    let count = (n * m) as f32;
    sum.map(|value| value / count)
}

fn add(sum: &mut Premultiplied, color: Premultiplied, weight: f32) {
    for (total, value) in sum.iter_mut().zip(color) {
        *total += value * weight;
    }
}

fn texel(source: &[Premultiplied], spec: &Spec, x: i64, y: i64) -> Premultiplied {
    if x < 0 || y < 0 || x >= spec.src_width as i64 || y >= spec.src_height as i64 {
        return [0.0; 4];
    }
    source[y as usize * spec.src_width + x as usize]
}

fn nearest(source: &[Premultiplied], spec: &Spec, p: (f64, f64)) -> Premultiplied {
    texel(source, spec, p.0.floor() as i64, p.1.floor() as i64)
}

fn linear(source: &[Premultiplied], spec: &Spec, p: (f64, f64)) -> Premultiplied {
    let fx = p.0 - 0.5;
    let fy = p.1 - 0.5;
    let x0 = fx.floor();
    let y0 = fy.floor();
    let tx = (fx - x0) as f32;
    let ty = (fy - y0) as f32;
    let (x0, y0) = (x0 as i64, y0 as i64);
    let mut out = [0.0f32; 4];
    for (dy, wy) in [(0, 1.0 - ty), (1, ty)] {
        for (dx, wx) in [(0, 1.0 - tx), (1, tx)] {
            add(&mut out, texel(source, spec, x0 + dx, y0 + dy), wx * wy);
        }
    }
    out
}

/// Catmull-Rom weights (a = -0.5) of the four taps around `t` in [0, 1).
pub(crate) fn catmull_rom(t: f32) -> [f32; 4] {
    let t2 = t * t;
    let t3 = t2 * t;
    [
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    ]
}

fn cubic(source: &[Premultiplied], spec: &Spec, p: (f64, f64)) -> Premultiplied {
    let fx = p.0 - 0.5;
    let fy = p.1 - 0.5;
    let x0 = fx.floor();
    let y0 = fy.floor();
    let wx = catmull_rom((fx - x0) as f32);
    let wy = catmull_rom((fy - y0) as f32);
    let (x0, y0) = (x0 as i64, y0 as i64);
    let mut out = [0.0f32; 4];
    for (j, weight_y) in wy.iter().enumerate() {
        for (i, weight_x) in wx.iter().enumerate() {
            let tap = texel(source, spec, x0 - 1 + i as i64, y0 - 1 + j as i64);
            add(&mut out, tap, weight_x * weight_y);
        }
    }
    // Catmull-Rom overshoots. An alpha above one is scaled down together with the color, so the
    // color stays the same, and each premultiplied channel is kept inside [0, alpha].
    if out[3] <= 0.0 {
        return [0.0; 4];
    }
    if out[3] > 1.0 {
        let alpha = out[3];
        out = out.map(|value| value / alpha);
    }
    let alpha = out[3];
    for channel in &mut out[..3] {
        *channel = channel.clamp(0.0, alpha);
    }
    out
}

/// Unpremultiplies, encodes the color as sRGB when it was linear, and rounds to 8 bits.
fn encode(color: Premultiplied, linear_light: bool) -> [u8; 4] {
    let alpha = color[3].clamp(0.0, 1.0);
    if alpha <= 0.0 {
        return [0, 0, 0, 0];
    }
    let channel = |value: f32| {
        let v = (value / alpha).clamp(0.0, 1.0);
        let v = if linear_light { to_srgb(v) } else { v };
        (v * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8
    };
    [
        channel(color[0]),
        channel(color[1]),
        channel(color[2]),
        (alpha * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

    fn spec<'a>(
        src: &'a [u8],
        width: usize,
        height: usize,
        inverse: [f64; 6],
        sampling: Sampling,
    ) -> Spec<'a> {
        Spec {
            src,
            src_width: width,
            src_height: height,
            dst_width: width,
            dst_height: height,
            inverse,
            sampling,
            linear_light: false,
        }
    }

    fn gradient(width: usize, height: usize) -> Vec<u8> {
        let mut px = Vec::new();
        for y in 0..height {
            for x in 0..width {
                px.extend([
                    (x * 37 % 256) as u8,
                    (y * 53 % 256) as u8,
                    ((x + y) * 11 % 256) as u8,
                    255,
                ]);
            }
        }
        px
    }

    #[test]
    fn row_bands_join_into_the_whole_result_byte_for_byte() {
        let src = gradient(9, 7);
        let (cos, sin) = (0.4f64.cos(), 0.4f64.sin());
        for sampling in [Sampling::Nearest, Sampling::Multisample, Sampling::Cubic] {
            let mut turned = spec(&src, 9, 7, [cos, -sin, sin, cos, 1.3, -0.7], sampling);
            turned.dst_width = 11;
            turned.dst_height = 10;
            turned.linear_light = true;
            let whole = transform_rgba8(&turned).unwrap();
            let mut joined = Vec::new();
            for (first, rows) in [(0, 3), (3, 1), (4, 6)] {
                joined.extend(transform_rows_rgba8(&turned, first, rows).unwrap());
            }
            assert_eq!(joined, whole, "{sampling:?}");
        }
        assert!(transform_rows_rgba8(&spec(&src, 9, 7, IDENTITY, Sampling::Nearest), 5, 3).is_err());
    }

    #[test]
    fn identity_is_exact_for_every_filter_but_multisample() {
        let src = gradient(5, 4);
        for sampling in [
            Sampling::Nearest,
            Sampling::Linear,
            Sampling::Anisotropic,
            Sampling::Cubic,
        ] {
            let out = transform_rgba8(&spec(&src, 5, 4, IDENTITY, sampling)).unwrap();
            assert_eq!(out, src, "{sampling:?}");
        }
    }

    #[test]
    fn integer_translation_moves_pixels_and_leaves_transparency_behind() {
        let src = gradient(4, 4);
        // Destination pixel (x, y) reads source (x - 1, y): the first column becomes transparent.
        let inverse = [1.0, 0.0, 0.0, 1.0, -1.0, 0.0];
        let out = transform_rgba8(&spec(&src, 4, 4, inverse, Sampling::Nearest)).unwrap();
        assert_eq!(&out[0..4], &[0, 0, 0, 0]);
        assert_eq!(&out[4..8], &src[0..4]);
    }

    #[test]
    fn quarter_turn_maps_pixels_exactly_with_nearest_neighbor() {
        // Destination (x, y) reads source (y, W - 1 - x) for a 90 degree turn of a square image.
        let size = 3;
        let src = gradient(size, size);
        let inverse = [0.0, -1.0, 1.0, 0.0, 0.0, size as f64];
        let out = transform_rgba8(&spec(&src, size, size, inverse, Sampling::Nearest)).unwrap();
        for y in 0..size {
            for x in 0..size {
                let from = ((size - 1 - x) * size + y) * 4;
                let to = (y * size + x) * 4;
                assert_eq!(&out[to..to + 4], &src[from..from + 4], "({x}, {y})");
            }
        }
    }

    #[test]
    fn uniform_color_stays_uniform_under_every_filter() {
        let src = [40u8, 120, 200, 255].repeat(64);
        let theta: f64 = 0.5;
        let (s, c) = theta.sin_cos();
        let inverse = [c * 0.5, -s * 0.5, s * 0.5, c * 0.5, 2.0, 2.0];
        for sampling in [
            Sampling::Nearest,
            Sampling::Linear,
            Sampling::Multisample,
            Sampling::Anisotropic,
            Sampling::Cubic,
        ] {
            let out = transform_rgba8(&spec(&src, 8, 8, inverse, sampling)).unwrap();
            let mut opaque = 0;
            for px in out.as_chunks::<4>().0 {
                // Catmull-Rom weights overshoot at partly transparent edges, so only the
                // fully covered pixels are checked for Cubic.
                if px[3] == 0 || (sampling == Sampling::Cubic && px[3] != 255) {
                    continue;
                }
                if px[3] == 255 {
                    opaque += 1;
                }
                assert!((i32::from(px[0]) - 40).abs() <= 1, "{sampling:?}");
                assert!((i32::from(px[1]) - 120).abs() <= 1, "{sampling:?}");
                assert!((i32::from(px[2]) - 200).abs() <= 1, "{sampling:?}");
            }
            assert!(opaque > 0, "{sampling:?} has no interior pixel");
        }
    }

    #[test]
    fn downscale_averages_in_linear_light_when_asked() {
        // A black and a white pixel, reduced to one pixel with a 2x footprint.
        let src = [0, 0, 0, 255, 255, 255, 255, 255];
        let scaled = |linear_light: bool| Spec {
            src: &src,
            src_width: 2,
            src_height: 1,
            dst_width: 1,
            dst_height: 1,
            inverse: [2.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            sampling: Sampling::Anisotropic,
            linear_light,
        };
        let companded = transform_rgba8(&scaled(false)).unwrap();
        let linear = transform_rgba8(&scaled(true)).unwrap();
        assert_eq!(companded[0], 128);
        assert_eq!(linear[0], 188);
        assert_eq!(linear[3], 255);
    }

    #[test]
    fn transparent_neighbors_do_not_darken_color() {
        // Red opaque pixel next to a fully transparent pixel: the average keeps the red at half alpha.
        let src = [255, 0, 0, 255, 0, 0, 0, 0];
        let out = transform_rgba8(&Spec {
            src: &src,
            src_width: 2,
            src_height: 1,
            dst_width: 1,
            dst_height: 1,
            inverse: [2.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            sampling: Sampling::Anisotropic,
            linear_light: false,
        })
        .unwrap();
        assert_eq!(out, [255, 0, 0, 128]);
    }

    #[test]
    fn rejects_mismatched_pixels_and_non_finite_transforms() {
        let src = [0u8; 8];
        assert!(transform_rgba8(&spec(&src, 2, 2, IDENTITY, Sampling::Linear)).is_err());
        let bad = [f64::NAN, 0.0, 0.0, 1.0, 0.0, 0.0];
        assert!(transform_rgba8(&spec(&src, 2, 1, bad, Sampling::Linear)).is_err());
    }

    #[test]
    fn sampling_ids_round_trip_and_reject_unknown_ones() {
        assert_eq!(Sampling::try_from(4), Ok(Sampling::Cubic));
        assert_eq!(Sampling::try_from(5), Err(5));
    }
}
