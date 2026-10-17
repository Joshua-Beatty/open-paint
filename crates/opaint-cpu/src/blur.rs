//! Reference Gaussian blur (FX-BLUR-GAUSS). The WGSL twin in `packages/effects` runs the
//! same steps in the same order, so GPU output must match this kernel within ±1 per channel.
//!
//! Pipeline: straight sRGB → linear light → gamma(e) on straight color → premultiply → optional
//! bilinear downsample (quality 1-3) → separable Gaussian with a mirror border → optional bilinear
//! upsample → unpremultiply → inverse gamma(1/e) → sRGB → RGBA8 (round half up).

use crate::srgb::{to_linear, to_srgb};

/// Premultiplied, gamma-boosted linear light as `[r, g, b, a]`. Filters may leave channels outside 0..=1.
pub(crate) type Texel = [f32; 4];

/// Downsample factor for `quality` (1-4) at `sigma`. Levels 1-3 downsample only above their
/// proposed threshold (FX-BLUR-GAUSS-03 [TBD]); level 4 always blurs at full resolution.
pub fn downsample_factor(quality: u8, sigma: f32) -> usize {
    let (factor, threshold) = match quality {
        1 => (4, 16.0),
        2 => (2, 32.0),
        3 => (2, 64.0),
        _ => return 1,
    };
    if sigma > threshold {
        factor
    } else {
        1
    }
}

/// Normalized Gaussian weights for `sigma`, over offsets `-R..=R` with `R = ceil(3 sigma)`.
pub fn kernel(sigma: f32) -> Vec<f32> {
    if sigma.is_nan() || sigma <= 0.0 {
        return vec![1.0];
    }
    let radius = (3.0 * sigma).ceil() as i32;
    let scale = 1.0 / (2.0 * sigma * sigma);
    let mut weights: Vec<f32> = (-radius..=radius)
        .map(|offset| {
            if offset == 0 {
                return 1.0;
            }
            let d = offset as f32;
            (-(d * d) * scale).exp()
        })
        .collect();
    let sum: f32 = weights.iter().sum();
    for w in &mut weights {
        *w /= sum;
    }
    weights
}

/// Index of `index` under a mirror border: -1 maps to 0, `len` maps to `len - 1`, repeating with
/// period `2 * len`.
pub(crate) fn mirror_index(index: isize, len: usize) -> usize {
    let n = len as isize;
    let m = index.rem_euclid(2 * n);
    (if m >= n { 2 * n - 1 - m } else { m }) as usize
}

fn clamp_index(index: isize, len: usize) -> usize {
    index.clamp(0, len as isize - 1) as usize
}

/// How a separable pass reads samples outside the image: mirrored (the "hard" border of the
/// Gaussian blur, FX-BLUR-GAUSS-03) or clamped to the nearest edge pixel (Glow, FX-PHOTO-GLOW).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Border {
    Mirror,
    Clamp,
}

impl Border {
    /// The sample index of `index` under this border on a line of `len` pixels.
    pub(crate) fn index(self, index: isize, len: usize) -> usize {
        match self {
            Border::Mirror => mirror_index(index, len),
            Border::Clamp => clamp_index(index, len),
        }
    }
}

/// `base^exponent` for `base >= 0`, defined as 0 at 0 (matches the WGSL twin).
fn pow_nonneg(base: f32, exponent: f32) -> f32 {
    if base <= 0.0 {
        0.0
    } else {
        base.powf(exponent)
    }
}

fn to_u8(v: f32) -> u8 {
    (v * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8
}

fn bilinear(src: &[Texel], width: usize, height: usize, sx: f32, sy: f32) -> Texel {
    let (x0, y0) = (sx.floor(), sy.floor());
    let (tx, ty) = (sx - x0, sy - y0);
    let (x0, y0) = (x0 as isize, y0 as isize);
    let at = |x: isize, y: isize| src[clamp_index(y, height) * width + clamp_index(x, width)];
    let (p00, p10) = (at(x0, y0), at(x0 + 1, y0));
    let (p01, p11) = (at(x0, y0 + 1), at(x0 + 1, y0 + 1));
    std::array::from_fn(|c| {
        let top = p00[c] + (p10[c] - p00[c]) * tx;
        let bottom = p01[c] + (p11[c] - p01[c]) * tx;
        top + (bottom - top) * ty
    })
}

/// Resamples `src` (`sw` x `sh`) to `dw` x `dh`. A destination pixel center maps to the source
/// coordinate `(x + 0.5) * scale - 0.5`; taps are clamped to the image.
fn resample_bilinear(
    src: &[Texel],
    (sw, sh): (usize, usize),
    (dw, dh): (usize, usize),
    scale: f32,
) -> Vec<Texel> {
    let mut out = Vec::with_capacity(dw * dh);
    for y in 0..dh {
        let sy = (y as f32 + 0.5) * scale - 0.5;
        for x in 0..dw {
            let sx = (x as f32 + 0.5) * scale - 0.5;
            out.push(bilinear(src, sw, sh, sx, sy));
        }
    }
    out
}

/// One separable pass of `weights` (centered, odd length) over a `width` x `height` plane.
fn blur_pass(
    src: &[Texel],
    width: usize,
    height: usize,
    weights: &[f32],
    horizontal: bool,
    border: Border,
) -> Vec<Texel> {
    let half = (weights.len() / 2) as isize;
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            let mut acc = [0.0f32; 4];
            for (k, &weight) in weights.iter().enumerate() {
                let offset = k as isize - half;
                let index = if horizontal {
                    y * width + border.index(x as isize + offset, width)
                } else {
                    border.index(y as isize + offset, height) * width + x
                };
                let p = src[index];
                acc = std::array::from_fn(|c| acc[c] + weight * p[c]);
            }
            out.push(acc);
        }
    }
    out
}

/// Gaussian blur of a straight-alpha RGBA8 image (FX-BLUR-GAUSS). `radius` is the spec's Radius
/// (σ = radius / 3); 0 returns the input unchanged. `gamma_boost` is in -0.99..=2 and gives
/// e = 1 + gamma_boost; `quality` is 1..=4.
pub fn blur_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    radius: f32,
    gamma_boost: f32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    if !(1..=4).contains(&quality) {
        return Err(format!("quality must be 1-4, got {quality}"));
    }
    check_separable_args(src, width, height, radius, gamma_boost)?;
    if radius == 0.0 || width == 0 || height == 0 {
        return Ok(src.to_vec());
    }

    let sigma = radius / 3.0;
    let factor = downsample_factor(quality, sigma);
    let weights = kernel(sigma / factor as f32);
    Ok(separable_rgba8(
        src,
        width,
        height,
        1.0 + gamma_boost,
        factor,
        &weights,
        Border::Mirror,
    ))
}

/// The Gaussian blur of Glow (FX-PHOTO-GLOW): the Gaussian at quality `quality` with the gamma
/// boost at 0 and a clamped border. `radius` is the Gaussian radius (σ = radius / 3). A radius of 0
/// returns the input unchanged.
pub(crate) fn blur_clamped_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    radius: f32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    check_separable_args(src, width, height, radius, 0.0)?;
    if radius == 0.0 || width == 0 || height == 0 {
        return Ok(src.to_vec());
    }
    let sigma = radius / 3.0;
    let factor = downsample_factor(quality, sigma);
    let weights = kernel(sigma / factor as f32);
    Ok(separable_rgba8(
        src,
        width,
        height,
        1.0,
        factor,
        &weights,
        Border::Clamp,
    ))
}

/// Checks the arguments that the gamma-separable blurs share: the buffer size, the radius and the
/// gamma boost.
pub(crate) fn check_separable_args(
    src: &[u8],
    width: usize,
    height: usize,
    radius: f32,
    gamma_boost: f32,
) -> Result<(), String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    if !(radius.is_finite() && radius >= 0.0) {
        return Err(format!("radius must be a finite value >= 0, got {radius}"));
    }
    if !(gamma_boost.is_finite() && (-0.99..=2.0).contains(&gamma_boost)) {
        return Err(format!("gamma boost must be -0.99..=2, got {gamma_boost}"));
    }
    Ok(())
}

/// The gamma-separable pipeline of Gaussian and Square Blur (FX-BLUR-GAUSS-03, FX-BLUR-SQUARE-03):
/// gamma(e) on straight color, premultiply, an optional downsample, the separable `weights` pass,
/// the optional upsample, unpremultiply and the inverse gamma. `factor` 1 blurs at full resolution.
fn separable_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    exponent: f32,
    factor: usize,
    weights: &[f32],
    border: Border,
) -> Vec<u8> {
    gamma_pipeline(src, exponent, |plane| {
        if factor > 1 {
            let (dw, dh) = (width.div_ceil(factor), height.div_ceil(factor));
            let down = resample_bilinear(&plane, (width, height), (dw, dh), factor as f32);
            let blurred_h = blur_pass(&down, dw, dh, weights, true, border);
            let blurred = blur_pass(&blurred_h, dw, dh, weights, false, border);
            resample_bilinear(&blurred, (dw, dh), (width, height), 1.0 / factor as f32)
        } else {
            let blurred_h = blur_pass(&plane, width, height, weights, true, border);
            blur_pass(&blurred_h, width, height, weights, false, border)
        }
    })
}

/// The gamma pipeline shared by the blurs (FX-BLUR-GAUSS-03, FX-BLUR-BOKEH-03): gamma(e) on straight
/// color, premultiply, `filter` on the premultiplied linear plane, unpremultiply with the color
/// clamped to 0..=alpha, the inverse gamma and the sRGB encode. `filter` may overshoot, and the
/// clamp at unpremultiply keeps the output in range.
pub(crate) fn gamma_pipeline(
    src: &[u8],
    exponent: f32,
    filter: impl FnOnce(Vec<Texel>) -> Vec<Texel>,
) -> Vec<u8> {
    let plane: Vec<Texel> = src
        .as_chunks::<4>()
        .0
        .iter()
        .map(|px| {
            let a = f32::from(px[3]) / 255.0;
            let lift = |v: u8| pow_nonneg(to_linear(f32::from(v) / 255.0), exponent) * a;
            [lift(px[0]), lift(px[1]), lift(px[2]), a]
        })
        .collect();
    let plane = filter(plane);

    let inverse = 1.0 / exponent;
    let mut out = Vec::with_capacity(src.len());
    for p in &plane {
        let a = p[3].clamp(0.0, 1.0);
        for &channel in &p[..3] {
            let straight = if a > 0.0 {
                (channel / a).clamp(0.0, 1.0)
            } else {
                0.0
            };
            out.push(to_u8(to_srgb(pow_nonneg(straight, inverse))));
        }
        out.push(to_u8(a));
    }
    out
}

/// The normalized box weights of Square Blur (FX-BLUR-SQUARE-03) for `radius`, over offsets
/// `-R..=R` with `R = ceil(radius)`. Taps at `|offset| <= floor(radius)` weigh 1, and the outermost
/// tap weighs the part of `radius` beyond `floor(radius)`. The weights are then divided by their sum.
/// A radius of 0 or less gives `[1]`.
pub fn box_kernel(radius: f32) -> Vec<f32> {
    if radius.is_nan() || radius <= 0.0 {
        return vec![1.0];
    }
    let whole = radius.floor();
    let reach = radius.ceil();
    let partial = radius - whole;
    let mut weights: Vec<f32> = (-(reach as i32)..=(reach as i32))
        .map(|offset| {
            if ((offset.abs()) as f32) <= whole {
                1.0
            } else {
                partial
            }
        })
        .collect();
    let sum: f32 = weights.iter().sum();
    for w in &mut weights {
        *w /= sum;
    }
    weights
}

/// Square Blur of a straight-alpha RGBA8 image (FX-BLUR-SQUARE): gamma(e), then a separable box blur
/// over `box_kernel(radius)` in linear light with a mirror border, then the inverse gamma.
/// `gamma_boost` is in -0.99..=2. A radius of 0 returns the input unchanged.
pub fn box_blur_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    radius: f32,
    gamma_boost: f32,
) -> Result<Vec<u8>, String> {
    check_separable_args(src, width, height, radius, gamma_boost)?;
    if radius == 0.0 || width == 0 || height == 0 {
        return Ok(src.to_vec());
    }
    Ok(separable_rgba8(
        src,
        width,
        height,
        1.0 + gamma_boost,
        1,
        &box_kernel(radius),
        Border::Mirror,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pixels: &[[u8; 4]]) -> Vec<u8> {
        pixels.iter().flatten().copied().collect()
    }

    #[test]
    fn kernel_is_normalized_symmetric_and_spans_three_sigma() {
        let weights = kernel(2.0);
        assert_eq!(weights.len(), 2 * 6 + 1);
        assert!((weights.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        for k in 0..weights.len() / 2 {
            assert_eq!(weights[k], weights[weights.len() - 1 - k]);
        }
        assert!(weights[6] > weights[5] && weights[5] > weights[4]);
        assert_eq!(kernel(0.0), vec![1.0]);
    }

    #[test]
    fn box_kernel_weighs_the_outer_tap_by_the_fraction_of_the_radius() {
        let whole = box_kernel(3.0);
        assert_eq!(whole.len(), 7);
        for w in &whole {
            assert!((w - 1.0 / 7.0).abs() < 1e-6);
        }
        let fractional = box_kernel(2.5);
        assert_eq!(fractional.len(), 7);
        assert!((fractional.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        assert!((fractional[0] - 0.5 / 6.0).abs() < 1e-6);
        assert_eq!(fractional[0], fractional[6]);
        assert!((fractional[1] - 1.0 / 6.0).abs() < 1e-6);
        assert_eq!(box_kernel(0.0), vec![1.0]);
    }

    #[test]
    fn square_blur_keeps_uniform_images_and_radius_zero() {
        let pixel = [120, 60, 200, 255];
        let src: Vec<u8> = (0..9 * 7).flat_map(|_| pixel).collect();
        assert_eq!(box_blur_rgba8(&src, 9, 7, 2.5, 0.5).unwrap(), src);
        assert_eq!(box_blur_rgba8(&src, 9, 7, 0.0, 0.5).unwrap(), src);
    }

    #[test]
    fn square_blur_spreads_a_spike_over_its_box() {
        let mut pixels = vec![[0u8, 0, 0, 255]; 9];
        pixels[4] = [255, 255, 255, 255];
        let out = box_blur_rgba8(&row(&pixels), 9, 1, 1.0, 0.0).unwrap();
        let at = |x: usize| out[x * 4];
        assert_eq!(at(2), 0);
        assert_eq!(at(6), 0);
        assert!(at(3) > 0);
        assert_eq!(at(3), at(4));
        assert_eq!(at(4), at(5));
    }

    #[test]
    fn square_blur_rejects_invalid_arguments() {
        let src = vec![0u8; 4 * 4];
        assert!(box_blur_rgba8(&src, 2, 2, -1.0, 0.0).is_err());
        assert!(box_blur_rgba8(&src, 2, 2, f32::NAN, 0.0).is_err());
        assert!(box_blur_rgba8(&src, 2, 2, 1.0, -1.0).is_err());
        assert!(box_blur_rgba8(&src[..8], 2, 2, 1.0, 0.0).is_err());
    }

    #[test]
    fn quality_selects_downsample_factor_above_its_threshold() {
        assert_eq!(downsample_factor(1, 16.0), 1);
        assert_eq!(downsample_factor(1, 16.5), 4);
        assert_eq!(downsample_factor(2, 32.0), 1);
        assert_eq!(downsample_factor(2, 40.0), 2);
        assert_eq!(downsample_factor(3, 65.0), 2);
        assert_eq!(downsample_factor(4, 1000.0), 1);
    }

    #[test]
    fn mirror_border_reflects_without_repeating_the_edge() {
        assert_eq!(mirror_index(-1, 4), 0);
        assert_eq!(mirror_index(-2, 4), 1);
        assert_eq!(mirror_index(4, 4), 3);
        assert_eq!(mirror_index(5, 4), 2);
        assert_eq!(mirror_index(-5, 4), 3);
        assert_eq!(mirror_index(3, 1), 0);
        assert_eq!(mirror_index(-7, 1), 0);
    }

    #[test]
    fn zero_radius_returns_the_input() {
        let src = row(&[[10, 20, 30, 40], [200, 0, 255, 128]]);
        assert_eq!(blur_rgba8(&src, 2, 1, 0.0, 0.5, 3), Ok(src));
    }

    #[test]
    fn uniform_image_stays_uniform_at_every_quality_and_gamma() {
        let pixel = [120, 60, 200, 255];
        let src: Vec<u8> = (0..9 * 7).flat_map(|_| pixel).collect();
        for quality in 1..=4 {
            for boost in [-0.5, 0.0, 1.0] {
                let out = blur_rgba8(&src, 9, 7, 3.0, boost, quality).unwrap();
                assert_eq!(out, src, "quality {quality} boost {boost}");
            }
        }
        let large: Vec<u8> = (0..40 * 24).flat_map(|_| pixel).collect();
        let out = blur_rgba8(&large, 40, 24, 120.0, 0.0, 1).unwrap();
        assert_eq!(out, large);
    }

    #[test]
    fn transparent_pixels_do_not_darken_their_opaque_neighbors() {
        let mut pixels = vec![[255, 255, 255, 255]; 4];
        pixels.extend(vec![[0, 0, 0, 0]; 4]);
        let out = blur_rgba8(&row(&pixels), 8, 1, 3.0, 0.0, 4).unwrap();
        let edge = &out[3 * 4..3 * 4 + 4];
        assert_eq!(&edge[..3], &[255, 255, 255]);
        assert!(edge[3] < 255 && edge[3] > 0);
    }

    #[test]
    fn positive_gamma_boost_brightens_and_negative_darkens_a_mixed_edge() {
        let mut pixels = vec![[0, 0, 0, 255]; 8];
        pixels.extend(vec![[255, 255, 255, 255]; 8]);
        let src = row(&pixels);
        let red_at_edge = |boost: f32| {
            let out = blur_rgba8(&src, 16, 1, 6.0, boost, 4).unwrap();
            out[7 * 4]
        };
        let (bright, neutral, dark) = (red_at_edge(1.0), red_at_edge(0.0), red_at_edge(-0.5));
        assert!(
            bright > neutral && neutral > dark,
            "{bright} {neutral} {dark}"
        );
    }

    #[test]
    fn rejects_invalid_arguments() {
        let src = vec![0u8; 4 * 4];
        assert!(blur_rgba8(&src, 2, 2, 1.0, 0.0, 0).is_err());
        assert!(blur_rgba8(&src, 2, 2, 1.0, 0.0, 5).is_err());
        assert!(blur_rgba8(&src, 2, 2, -1.0, 0.0, 3).is_err());
        assert!(blur_rgba8(&src, 2, 2, f32::NAN, 0.0, 3).is_err());
        assert!(blur_rgba8(&src, 2, 2, 1.0, -1.0, 3).is_err());
        assert!(blur_rgba8(&src, 2, 2, 1.0, 2.5, 3).is_err());
        assert!(blur_rgba8(&src[..8], 2, 2, 1.0, 0.0, 3).is_err());
    }
}
