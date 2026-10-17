//! Resampling for DOC-IMG-02 and the display mip pyramid (ARC-03-04).
//!
//! Every filter is separable: a horizontal pass, then a vertical pass. Each output pixel reads a
//! short list of source taps (`Taps`), so one core serves all nine choices. Kernels are stretched by
//! the scale factor when downscaling, which prefilters the image against aliasing. Bilinear (Low
//! Quality) is the exception, a plain 2x2 interpolation. Nearest Neighbor copies one pixel, and
//! Super Sampling and Fant average the source area each output pixel covers.
//!
//! Pixels are premultiplied before filtering and unpremultiplied afterwards. The color is clamped
//! to its alpha, so filter overshoot never shows as color above coverage. With `linear_light`
//! (gamma correction), sRGB is decoded before premultiplying and encoded again afterwards.

use crate::srgb::{to_linear, to_srgb};
use std::f64::consts::PI;

/// The DOC-IMG-02 resampling choices. The discriminants are the WASM ids of `resample_rgba8`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Filter {
    /// Copies the source pixel under each output pixel center.
    Nearest = 0,
    /// Triangle filter, stretched when downscaling.
    Bilinear = 1,
    /// Plain 2x2 bilinear interpolation without prefiltering.
    BilinearLowQuality = 2,
    /// Catmull-Rom cubic convolution, stretched when downscaling.
    Bicubic = 3,
    /// Mitchell-Netravali cubic (B = C = 1/3), smoother and with less ringing.
    BicubicSmooth = 4,
    /// Lanczos-3 when downscaling, Catmull-Rom cubic when upscaling.
    Adaptive = 5,
    /// Lanczos-3 windowed sinc.
    Lanczos3 = 6,
    /// Equal-weight samples on a grid of at least 4 per axis, approximating box-filter area averaging.
    SuperSampling = 7,
    /// Fant's exact area averaging: each source pixel counts by the share of the output pixel it covers.
    Fant = 8,
}

impl TryFrom<u8> for Filter {
    type Error = u8;

    fn try_from(id: u8) -> Result<Self, u8> {
        Ok(match id {
            0 => Self::Nearest,
            1 => Self::Bilinear,
            2 => Self::BilinearLowQuality,
            3 => Self::Bicubic,
            4 => Self::BicubicSmooth,
            5 => Self::Adaptive,
            6 => Self::Lanczos3,
            7 => Self::SuperSampling,
            8 => Self::Fant,
            other => return Err(other),
        })
    }
}

/// The source pixels one output pixel reads: the first source index and normalized weights.
struct Taps {
    first: usize,
    weights: Vec<f32>,
}

impl Taps {
    fn point(src_len: usize, position: f64) -> Taps {
        Taps {
            first: source_index(src_len, position),
            weights: vec![1.0],
        }
    }

    /// Normalizes `raw` (one weight per source index from `first`). `None` when nothing contributes.
    fn normalized(first: usize, raw: &[f64]) -> Option<Taps> {
        let sum: f64 = raw.iter().sum();
        (sum > 0.0).then(|| Taps {
            first,
            weights: raw.iter().map(|w| (w / sum) as f32).collect(),
        })
    }
}

/// The source index under `position`, clamped to the image.
fn source_index(src_len: usize, position: f64) -> usize {
    (position.floor().max(0.0) as usize).min(src_len - 1)
}

fn sinc(x: f64) -> f64 {
    if x == 0.0 {
        1.0
    } else {
        let px = PI * x;
        px.sin() / px
    }
}

fn lanczos3(x: f64) -> f64 {
    if x.abs() < 3.0 {
        sinc(x) * sinc(x / 3.0)
    } else {
        0.0
    }
}

fn triangle(x: f64) -> f64 {
    (1.0 - x.abs()).max(0.0)
}

/// Mitchell-Netravali cubic with parameters `b` and `c`. Catmull-Rom is (0, 1/2).
fn cubic(x: f64, b: f64, c: f64) -> f64 {
    let x = x.abs();
    if x < 1.0 {
        ((12.0 - 9.0 * b - 6.0 * c) * x.powi(3)
            + (-18.0 + 12.0 * b + 6.0 * c) * x.powi(2)
            + (6.0 - 2.0 * b))
            / 6.0
    } else if x < 2.0 {
        ((-b - 6.0 * c) * x.powi(3)
            + (6.0 * b + 30.0 * c) * x.powi(2)
            + (-12.0 * b - 48.0 * c) * x
            + (8.0 * b + 24.0 * c))
            / 6.0
    } else {
        0.0
    }
}

fn catmull_rom(x: f64) -> f64 {
    cubic(x, 0.0, 0.5)
}

fn mitchell(x: f64) -> f64 {
    cubic(x, 1.0 / 3.0, 1.0 / 3.0)
}

/// Taps of `kernel` over the source pixels within `radius` filter widths of `center`.
/// `filter_scale` stretches the kernel: the source-to-output ratio when downscaling, otherwise 1.
fn kernel_taps(
    src_len: usize,
    center: f64,
    filter_scale: f64,
    radius: f64,
    kernel: fn(f64) -> f64,
) -> Taps {
    let support = radius * filter_scale;
    let first = source_index(src_len, center - support + 0.5);
    let end = ((center + support + 0.5).floor().max(0.0) as usize)
        .min(src_len)
        .max(first + 1);
    let raw: Vec<f64> = (first..end)
        .map(|j| kernel(((j as f64 + 0.5) - center) / filter_scale))
        .collect();
    Taps::normalized(first, &raw).unwrap_or_else(|| Taps::point(src_len, center))
}

/// Equal-weight point samples across `[lo, lo + scale)`, on a grid of `max(4, ceil(scale))` per axis.
fn super_sampling_taps(src_len: usize, lo: f64, scale: f64) -> Taps {
    let samples = (scale.ceil() as usize).max(4);
    let step = scale / samples as f64;
    let indices: Vec<usize> = (0..samples)
        .map(|k| source_index(src_len, lo + (k as f64 + 0.5) * step))
        .collect();
    let first = indices[0];
    let mut raw = vec![0.0; indices[samples - 1] - first + 1];
    for index in indices {
        raw[index - first] += 1.0;
    }
    Taps::normalized(first, &raw).unwrap_or_else(|| Taps::point(src_len, lo))
}

/// Exact area coverage of `[lo, hi)` by each source pixel (Fant's resampling).
fn area_taps(src_len: usize, lo: f64, hi: f64) -> Taps {
    let first = source_index(src_len, lo);
    let end = (hi.ceil().max(0.0) as usize).min(src_len).max(first + 1);
    let raw: Vec<f64> = (first..end)
        .map(|j| (((j + 1) as f64).min(hi) - (j as f64).max(lo)).max(0.0))
        .collect();
    Taps::normalized(first, &raw).unwrap_or_else(|| Taps::point(src_len, lo))
}

/// The taps of every output pixel along one axis.
fn axis_taps(filter: Filter, src_len: usize, dst_len: usize) -> Vec<Taps> {
    let scale = src_len as f64 / dst_len as f64;
    let prefilter = scale.max(1.0);
    (0..dst_len)
        .map(|i| {
            let lo = i as f64 * scale;
            let hi = (i + 1) as f64 * scale;
            let center = (i as f64 + 0.5) * scale;
            match filter {
                Filter::Nearest => Taps::point(src_len, center),
                Filter::Bilinear => kernel_taps(src_len, center, prefilter, 1.0, triangle),
                Filter::BilinearLowQuality => kernel_taps(src_len, center, 1.0, 1.0, triangle),
                Filter::Bicubic => kernel_taps(src_len, center, prefilter, 2.0, catmull_rom),
                Filter::BicubicSmooth => kernel_taps(src_len, center, prefilter, 2.0, mitchell),
                Filter::Adaptive if scale > 1.0 => {
                    kernel_taps(src_len, center, prefilter, 3.0, lanczos3)
                }
                Filter::Adaptive => kernel_taps(src_len, center, 1.0, 2.0, catmull_rom),
                Filter::Lanczos3 => kernel_taps(src_len, center, prefilter, 3.0, lanczos3),
                Filter::SuperSampling => super_sampling_taps(src_len, lo, scale),
                Filter::Fant => area_taps(src_len, lo, hi),
            }
        })
        .collect()
}

fn to_byte(value: f32) -> u8 {
    value.round().clamp(0.0, 255.0) as u8
}

fn check_dimensions(
    len: usize,
    (src_width, src_height): (usize, usize),
    (dst_width, dst_height): (usize, usize),
) -> Result<(), String> {
    if [src_width, src_height, dst_width, dst_height].contains(&0) {
        return Err("image sizes must be positive".into());
    }
    if len != src_width * src_height * 4 {
        return Err("source must be src_width x src_height RGBA8".into());
    }
    Ok(())
}

/// Separable resampling of premultiplied pixels (4 values each, row-major). Every kernel's weights
/// sum to one, so the caller's units carry through unchanged.
fn resample_premultiplied(
    src: &[f32],
    (src_width, src_height): (usize, usize),
    (dst_width, dst_height): (usize, usize),
    filter: Filter,
) -> Vec<f32> {
    let columns = axis_taps(filter, src_width, dst_width);
    let rows = axis_taps(filter, src_height, dst_height);

    // Horizontal pass: each source row becomes dst_width pixels.
    let mut horizontal = vec![0f32; dst_width * src_height * 4];
    for (y, line) in src.chunks_exact(src_width * 4).enumerate() {
        for (x, tap) in columns.iter().enumerate() {
            let out = &mut horizontal[(y * dst_width + x) * 4..][..4];
            for (k, w) in tap.weights.iter().enumerate() {
                let i = (tap.first + k) * 4;
                for (o, s) in out.iter_mut().zip(&line[i..i + 4]) {
                    *o += w * s;
                }
            }
        }
    }

    // Vertical pass.
    let mut out = vec![0f32; dst_width * dst_height * 4];
    for (y, tap) in rows.iter().enumerate() {
        for x in 0..dst_width {
            let pixel = &mut out[(y * dst_width + x) * 4..][..4];
            for (k, w) in tap.weights.iter().enumerate() {
                let i = ((tap.first + k) * dst_width + x) * 4;
                for (p, m) in pixel.iter_mut().zip(&horizontal[i..i + 4]) {
                    *p += w * m;
                }
            }
        }
    }
    out
}

/// Lanczos-3 resampling of premultiplied RGBA8 (the display mip pyramid, ARC-03-04). Output color is
/// clamped to alpha. Straight-alpha images use [`resample_rgba8`].
pub fn lanczos3_rgba8(
    src: &[u8],
    src_width: usize,
    src_height: usize,
    dst_width: usize,
    dst_height: usize,
) -> Result<Vec<u8>, String> {
    check_dimensions(src.len(), (src_width, src_height), (dst_width, dst_height))?;
    let pixels: Vec<f32> = src.iter().map(|v| f32::from(*v)).collect();
    let out = resample_premultiplied(
        &pixels,
        (src_width, src_height),
        (dst_width, dst_height),
        Filter::Lanczos3,
    );
    let mut bytes = Vec::with_capacity(out.len());
    for [r, g, b, a] in out.as_chunks::<4>().0.iter().copied() {
        let alpha = to_byte(a);
        bytes.extend([
            to_byte(r).min(alpha),
            to_byte(g).min(alpha),
            to_byte(b).min(alpha),
            alpha,
        ]);
    }
    Ok(bytes)
}

/// Resamples a straight-alpha RGBA8 image (`src_width` x `src_height`, the document format) to
/// `dst_width` x `dst_height` with `filter`. With `linear_light`, color is resampled in linear light
/// (gamma correction); otherwise in sRGB-encoded values. Transparent pixels carry no color into the
/// result. A fully transparent output pixel is returned as zero.
pub fn resample_rgba8(
    src: &[u8],
    src_width: usize,
    src_height: usize,
    dst_width: usize,
    dst_height: usize,
    filter: Filter,
    linear_light: bool,
) -> Result<Vec<u8>, String> {
    check_dimensions(src.len(), (src_width, src_height), (dst_width, dst_height))?;
    let decode: [f32; 256] = std::array::from_fn(|c| {
        let v = c as f32 / 255.0;
        if linear_light {
            to_linear(v)
        } else {
            v
        }
    });

    // Values stay on the 0-255 scale here: premultiplied color is decoded color times alpha.
    let mut premultiplied = Vec::with_capacity(src.len());
    for [r, g, b, a] in src.as_chunks::<4>().0 {
        let alpha = f32::from(*a);
        premultiplied.extend([r, g, b].map(|c| decode[usize::from(*c)] * alpha));
        premultiplied.push(alpha);
    }

    let resampled = resample_premultiplied(
        &premultiplied,
        (src_width, src_height),
        (dst_width, dst_height),
        filter,
    );
    let mut out = Vec::with_capacity(resampled.len());
    for [r, g, b, a] in resampled.as_chunks::<4>().0.iter().copied() {
        let coverage = a.clamp(0.0, 255.0);
        let alpha = to_byte(coverage);
        if alpha == 0 {
            out.extend([0, 0, 0, 0]);
            continue;
        }
        let straight = |c: f32| {
            let v = c.clamp(0.0, coverage) / coverage;
            let encoded = if linear_light { to_srgb(v) } else { v };
            to_byte(encoded * 255.0)
        };
        out.extend([straight(r), straight(g), straight(b), alpha]);
    }
    Ok(out)
}

/// Values per output pixel in [`lanczos3_axis_taps`]: the first source index, the tap count and
/// up to this many minus two weights.
pub const AXIS_TAP_STRIDE: usize = 14;

/// The Lanczos-3 taps [`lanczos3_rgba8`] uses along one axis from `src_len` to `dst_len` pixels,
/// so a GPU twin applies the same `f32` weights in the same order: per output pixel the first
/// source index, the tap count, then the weights, padded with zeros to [`AXIS_TAP_STRIDE`] values.
/// Errs when a pixel has more taps than fit.
pub fn lanczos3_axis_taps(src_len: usize, dst_len: usize) -> Result<Vec<f32>, String> {
    if src_len == 0 || dst_len == 0 {
        return Err("axis lengths must be positive".into());
    }
    let mut out = Vec::with_capacity(dst_len * AXIS_TAP_STRIDE);
    for taps in axis_taps(Filter::Lanczos3, src_len, dst_len) {
        if taps.weights.len() > AXIS_TAP_STRIDE - 2 {
            return Err(format!("{} taps do not fit", taps.weights.len()));
        }
        out.push(taps.first as f32);
        out.push(taps.weights.len() as f32);
        out.extend(&taps.weights);
        out.resize(out.len() + AXIS_TAP_STRIDE - 2 - taps.weights.len(), 0.0);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axis_taps_are_the_weights_lanczos3_rgba8_applies() {
        let taps = lanczos3_axis_taps(256, 128).unwrap();
        assert_eq!(taps.len(), 128 * AXIS_TAP_STRIDE);
        // Applying them by hand to one row reproduces the resampled row.
        let src: Vec<u8> = (0..256 * 4).map(|i| ((i * 37) % 256) as u8).collect();
        let row = lanczos3_rgba8(&src, 256, 1, 128, 1).unwrap();
        for x in 0..128 {
            let entry = &taps[x * AXIS_TAP_STRIDE..(x + 1) * AXIS_TAP_STRIDE];
            let (first, count) = (entry[0] as usize, entry[1] as usize);
            let mut alpha = 0f32;
            for k in 0..count {
                alpha += entry[2 + k] * f32::from(src[(first + k) * 4 + 3]);
            }
            assert_eq!(row[x * 4 + 3], to_byte(alpha), "pixel {x}");
        }
        assert!(lanczos3_axis_taps(0, 4).is_err());
    }

    const ALL_FILTERS: [Filter; 9] = [
        Filter::Nearest,
        Filter::Bilinear,
        Filter::BilinearLowQuality,
        Filter::Bicubic,
        Filter::BicubicSmooth,
        Filter::Adaptive,
        Filter::Lanczos3,
        Filter::SuperSampling,
        Filter::Fant,
    ];

    fn pattern(width: usize, height: usize) -> Vec<u8> {
        (0..width * height * 4)
            .map(|i| (i * 37 % 256) as u8)
            .collect::<Vec<u8>>()
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|px| [px[0], px[1], px[2], 255])
            .collect()
    }

    fn pixels(out: &[u8]) -> Vec<[u8; 4]> {
        out.as_chunks::<4>().0.to_vec()
    }

    #[test]
    fn filter_ids_round_trip_and_unknown_ids_are_rejected() {
        for id in 0..9u8 {
            assert_eq!(Filter::try_from(id).map(|f| f as u8), Ok(id));
        }
        assert_eq!(Filter::try_from(9), Err(9));
    }

    #[test]
    fn every_filter_normalizes_its_taps_inside_the_image() {
        for filter in ALL_FILTERS {
            for (src, dst) in [(1, 3), (8, 3), (3, 8), (9, 2), (13, 7), (5, 5), (17, 40)] {
                for tap in axis_taps(filter, src, dst) {
                    let sum: f32 = tap.weights.iter().sum();
                    assert!((sum - 1.0).abs() < 1e-5, "{filter:?} {src}->{dst}: {sum}");
                    assert!(
                        tap.first + tap.weights.len() <= src,
                        "{filter:?} {src}->{dst}"
                    );
                }
            }
        }
    }

    #[test]
    fn constant_image_stays_constant_for_every_filter_and_gamma() {
        let src: Vec<u8> = [100, 50, 25, 200].repeat(8 * 8);
        for filter in ALL_FILTERS {
            for linear in [false, true] {
                let out = resample_rgba8(&src, 8, 8, 3, 5, filter, linear).unwrap();
                assert!(
                    pixels(&out).iter().all(|px| *px == [100, 50, 25, 200]),
                    "{filter:?} linear {linear}"
                );
            }
        }
    }

    #[test]
    fn same_size_is_the_identity_for_every_interpolating_filter() {
        let src = pattern(5, 3);
        // Mitchell (Bicubic Smooth) does not pass through the samples, so it softens even at 1:1.
        for filter in ALL_FILTERS
            .into_iter()
            .filter(|f| *f != Filter::BicubicSmooth)
        {
            assert_eq!(resample_rgba8(&src, 5, 3, 5, 3, filter, true).unwrap(), src);
            assert_eq!(
                resample_rgba8(&src, 5, 3, 5, 3, filter, false).unwrap(),
                src
            );
        }
    }

    #[test]
    fn nearest_upscale_repeats_pixels() {
        let src = [10, 10, 10, 255, 200, 200, 200, 255];
        let out = resample_rgba8(&src, 2, 1, 4, 1, Filter::Nearest, false).unwrap();
        let values: Vec<u8> = pixels(&out).iter().map(|px| px[0]).collect();
        assert_eq!(values, [10, 10, 200, 200]);
    }

    #[test]
    fn fant_halving_black_and_white_averages_in_sample_space() {
        let src = [0, 0, 0, 255, 255, 255, 255, 255];
        let out = resample_rgba8(&src, 2, 1, 1, 1, Filter::Fant, false).unwrap();
        assert_eq!(out, [128, 128, 128, 255]);
    }

    #[test]
    fn gamma_correct_halving_averages_in_linear_light() {
        let src = [0, 0, 0, 255, 255, 255, 255, 255];
        let out = resample_rgba8(&src, 2, 1, 1, 1, Filter::Fant, true).unwrap();
        assert_eq!(out, [188, 188, 188, 255]);
    }

    #[test]
    fn transparent_pixels_do_not_darken_or_tint_their_neighbors() {
        let src = [255, 255, 255, 255, 0, 0, 0, 0];
        let out = resample_rgba8(&src, 2, 1, 1, 1, Filter::Fant, false).unwrap();
        assert_eq!(out, [255, 255, 255, 128]);
    }

    #[test]
    fn fully_transparent_output_is_zero() {
        let src = [9, 9, 9, 0, 1, 2, 3, 0];
        for filter in ALL_FILTERS {
            let out = resample_rgba8(&src, 2, 1, 3, 1, filter, true).unwrap();
            assert!(
                pixels(&out).iter().all(|px| *px == [0, 0, 0, 0]),
                "{filter:?}"
            );
        }
    }

    #[test]
    fn halving_a_checker_averages_it_to_mid_gray() {
        let src = [
            0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
        ];
        let out = lanczos3_rgba8(&src, 2, 2, 1, 1).unwrap();
        assert!((127..=128).contains(&out[0]), "got {}", out[0]);
        assert_eq!(out[3], 255);
    }

    #[test]
    fn output_color_never_exceeds_alpha() {
        let src: Vec<u8> = (0..16 * 16)
            .flat_map(|i| {
                let on = (i / 16 + i % 16) % 2 == 0;
                let alpha = if on { 255 } else { 0 };
                [alpha, alpha, alpha, alpha]
            })
            .collect();
        for px in pixels(&lanczos3_rgba8(&src, 16, 16, 7, 9).unwrap()) {
            assert!(px[0] <= px[3] && px[1] <= px[3] && px[2] <= px[3], "{px:?}");
        }
        for filter in ALL_FILTERS {
            for linear in [false, true] {
                let out = resample_rgba8(&src, 16, 16, 7, 9, filter, linear).unwrap();
                for px in pixels(&out) {
                    assert!(px[3] != 0 || px[..3] == [0, 0, 0], "{filter:?} {px:?}");
                }
            }
        }
    }

    #[test]
    fn rejects_bad_sizes_and_buffers() {
        assert!(lanczos3_rgba8(&[0; 4], 0, 1, 1, 1).is_err());
        assert!(lanczos3_rgba8(&[0; 4], 2, 1, 1, 1).is_err());
        for filter in ALL_FILTERS {
            assert!(resample_rgba8(&[0; 4], 2, 1, 1, 1, filter, true).is_err());
            assert!(resample_rgba8(&[0; 8], 2, 1, 0, 1, filter, true).is_err());
        }
    }
}
