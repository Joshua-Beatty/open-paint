//! Stylize effects (FX-STYL-EDGE, FX-STYL-EMBOSS, FX-STYL-OUTLINE, FX-STYL-RELIEF). All take and return
//! straight-alpha RGBA8 and work in document space, not linear light. The WGSL twins in
//! `packages/effects` run the same stages in the same order and read the kernel weights and the edge
//! gain from this module, so the GPU result stays within ±1.

use std::f32::consts::FRAC_PI_4;

use crate::artistic::{check_image, luma, to_u8};
use crate::blur::kernel;
use crate::neighborhood_blur::{disc, rank_estimate};

/// The largest Outline Thickness, which is the radius of its neighborhood (FX-STYL-OUTLINE-01).
pub const OUTLINE_MAX_THICKNESS: u32 = 50;
/// The Outline Quality range, in bits of precision of the percentile search (FX-STYL-OUTLINE-01).
pub const OUTLINE_MAX_QUALITY: u32 = 12;

/// Edge Detect's pre-blur has σ = Blurring / 3 (FX-SHARED-STDDEV).
const BLUR_DIVISOR: f32 = 3.0;
/// The edge value is Strength times this, divided by the kernel's weight sum (FX-STYL-EDGE-01).
const EDGE_GAIN: f32 = 4.0;
/// The Sobel and Prewitt x-gradient kernels, row-major. The y-gradient is the transpose.
const SOBEL_X: [f32; 9] = [-1.0, 0.0, 1.0, -2.0, 0.0, 2.0, -1.0, 0.0, 1.0];
const PREWITT_X: [f32; 9] = [-1.0, 0.0, 1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0];
/// The positive weight sum of each x kernel, which normalizes its gradient.
const SOBEL_NORM: f32 = 4.0;
const PREWITT_NORM: f32 = 3.0;
/// Emboss adds this gray level to the convolved relief (128 / 255).
const EMBOSS_OFFSET: f32 = 128.0 / 255.0;

/// The gain that turns a raw gradient magnitude into an edge value (FX-STYL-EDGE-01): `Strength · 4`
/// divided by the kernel's positive weight sum, which is 4 for Sobel and 3 for Prewitt.
pub fn edge_gain(strength: f32, prewitt: bool) -> f32 {
    let norm = if prewitt { PREWITT_NORM } else { SOBEL_NORM };
    strength * EDGE_GAIN / norm
}

/// The normalized Gaussian weights of Edge Detect's pre-blur, for σ = Blurring / 3.
pub fn edge_blur_weights(blurring: f32) -> Vec<f32> {
    kernel(blurring / BLUR_DIVISOR)
}

/// The premultiplied RGB of one straight pixel on 0..=1: `(c / 255) · (a / 255)`.
fn premultiplied(px: &[u8]) -> [f32; 3] {
    let a = f32::from(px[3]) / 255.0;
    std::array::from_fn(|c| f32::from(px[c]) / 255.0 * a)
}

/// The value at (x, y) with both coordinates clamped to the image.
fn clamped<T: Copy>(values: &[T], width: usize, height: usize, x: isize, y: isize) -> T {
    let x = x.clamp(0, width as isize - 1) as usize;
    let y = y.clamp(0, height as isize - 1) as usize;
    values[y * width + x]
}

/// The 3×3 sum of `weights` at (x, y), row by row from the top left, where `sample` gives each tap.
fn convolve(weights: &[f32; 9], x: usize, y: usize, sample: impl Fn(isize, isize) -> f32) -> f32 {
    let mut acc = 0.0f32;
    for row in 0..3 {
        for col in 0..3 {
            let (sx, sy) = (x as isize + col as isize - 1, y as isize + row as isize - 1);
            acc += weights[row * 3 + col] * sample(sx, sy);
        }
    }
    acc
}

/// One separable pass of the clamped Gaussian over premultiplied RGB (FX-STYL-EDGE-01, step 1).
fn blur_pass(
    src: &[[f32; 3]],
    width: usize,
    height: usize,
    weights: &[f32],
    horizontal: bool,
) -> Vec<[f32; 3]> {
    let radius = (weights.len() / 2) as isize;
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            let mut acc = [0.0f32; 3];
            for (k, &weight) in weights.iter().enumerate() {
                let offset = k as isize - radius;
                let (sx, sy) = if horizontal {
                    (x as isize + offset, y as isize)
                } else {
                    (x as isize, y as isize + offset)
                };
                let value = clamped(src, width, height, sx, sy);
                acc = std::array::from_fn(|c| acc[c] + weight * value[c]);
            }
            out.push(acc);
        }
    }
    out
}

/// The raw gradient magnitude of each premultiplied channel at (x, y), before the gain. The taps
/// clamp to the image, and the y kernel is the x kernel transposed.
fn gradient_magnitude(
    plane: &[[f32; 3]],
    width: usize,
    height: usize,
    x: usize,
    y: usize,
    kernel_x: &[f32; 9],
) -> [f32; 3] {
    let kernel_y: [f32; 9] = std::array::from_fn(|i| kernel_x[(i % 3) * 3 + i / 3]);
    std::array::from_fn(|c| {
        let sample = |sx: isize, sy: isize| clamped(plane, width, height, sx, sy)[c];
        let gx = convolve(kernel_x, x, y, sample);
        let gy = convolve(&kernel_y, x, y, sample);
        (gx * gx + gy * gy).sqrt()
    })
}

/// Edge Detect (FX-STYL-EDGE): a Gaussian pre-blur of premultiplied RGB with σ = `blurring` / 3 when
/// `blurring` is above 0, then the Sobel (or Prewitt) gradient magnitude of each channel scaled by
/// `edge_gain`. Without `overlay` the output is the edge map, with each straight color set to its
/// edge value and alpha kept. With `overlay` the edge map is composited source-over onto the
/// original. Its alpha is the largest of its channels, so edges show where the image has them.
/// `strength` is 0..=1, `blurring` 0..=10.
pub fn edge_detect_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    strength: f32,
    blurring: f32,
    prewitt: bool,
    overlay: bool,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    if !(0.0..=1.0).contains(&strength) {
        return Err(format!("strength must be 0..=1, got {strength}"));
    }
    if !(0.0..=10.0).contains(&blurring) {
        return Err(format!("blurring must be 0..=10, got {blurring}"));
    }
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }
    let gain = edge_gain(strength, prewitt);
    let source: Vec<[f32; 3]> = src
        .as_chunks::<4>()
        .0
        .iter()
        .map(|px| premultiplied(px))
        .collect();
    let blurred = (blurring > 0.0).then(|| {
        let weights = edge_blur_weights(blurring);
        let horizontal = blur_pass(&source, width, height, &weights, true);
        blur_pass(&horizontal, width, height, &weights, false)
    });
    let plane = blurred.as_deref().unwrap_or(source.as_slice());
    let kernel_x = if prewitt { PREWITT_X } else { SOBEL_X };

    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let i = y * width + x;
            let px = &src[i * 4..i * 4 + 4];
            let edge = gradient_magnitude(plane, width, height, x, y, &kernel_x)
                .map(|m| (m * gain).clamp(0.0, 1.0));
            if overlay {
                let edge_alpha = edge[0].max(edge[1]).max(edge[2]);
                let alpha = f32::from(px[3]) / 255.0;
                let out_alpha = edge_alpha + alpha * (1.0 - edge_alpha);
                let mut rgba = [0u8; 4];
                for (c, value) in rgba.iter_mut().enumerate().take(3) {
                    let premult = edge[c] * edge_alpha + source[i][c] * (1.0 - edge_alpha);
                    *value = to_u8(if out_alpha > 0.0 {
                        premult / out_alpha
                    } else {
                        0.0
                    });
                }
                rgba[3] = to_u8(out_alpha);
                out.extend_from_slice(&rgba);
            } else {
                out.extend_from_slice(&[to_u8(edge[0]), to_u8(edge[1]), to_u8(edge[2]), px[3]]);
            }
        }
    }
    Ok(out)
}

/// Emboss's kernel for `angle` degrees (FX-STYL-EMBOSS-01), row-major: `cos(θ + kπ/4)` at the
/// spec's positions, with θ = radians(Angle − 180) and a 0 in the center.
pub fn emboss_weights(angle: f32) -> [f32; 9] {
    let theta = (angle - 180.0).to_radians();
    let k = |n: f32| (theta + n * FRAC_PI_4).cos();
    [
        k(1.0),
        k(2.0),
        k(3.0),
        k(0.0),
        0.0,
        k(4.0),
        k(-1.0),
        k(-2.0),
        k(-3.0),
    ]
}

/// Emboss (FX-STYL-EMBOSS): the premultiplied gray of each pixel, convolved with `emboss_weights`
/// and shifted by 128 / 255, gives an opaque gray relief. `angle` is 0..=360.
pub fn emboss_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    angle: f32,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    if !(0.0..=360.0).contains(&angle) {
        return Err(format!("angle must be 0..=360, got {angle}"));
    }
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }
    let weights = emboss_weights(angle);
    let gray: Vec<f32> = src
        .as_chunks::<4>()
        .0
        .iter()
        .map(|px| {
            let [r, g, b] = premultiplied(px);
            luma(r, g, b)
        })
        .collect();
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let value = convolve(&weights, x, y, |sx, sy| {
                clamped(&gray, width, height, sx, sy)
            });
            let level = to_u8(value + EMBOSS_OFFSET);
            out.extend_from_slice(&[level, level, level, 255]);
        }
    }
    Ok(out)
}

/// Outline (FX-STYL-OUTLINE): two percentile filters over the disc of `thickness`, with the clamped
/// border. The low filter is at `100 − intensity` half-percent and the high one at `100 + intensity`,
/// which is the spec's `(1 − I)/2` and `(1 + I)/2` with I = intensity / 100. Each output color is
/// `255 − (hi − lo)` for its channel, so the output is dark where the local range is large, and its
/// alpha is the high filter's alpha. The percentile filters run over all four straight channels.
pub fn outline_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    thickness: u32,
    intensity: u32,
    quality: u32,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    if !(1..=OUTLINE_MAX_THICKNESS).contains(&thickness) {
        return Err(format!(
            "outline thickness must be 1-{OUTLINE_MAX_THICKNESS}, got {thickness}"
        ));
    }
    if intensity > 100 {
        return Err(format!("outline intensity must be 0-100, got {intensity}"));
    }
    if !(1..=OUTLINE_MAX_QUALITY).contains(&quality) {
        return Err(format!(
            "outline quality must be 1-{OUTLINE_MAX_QUALITY}, got {quality}"
        ));
    }
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }
    let (low, high) = (100 - intensity, 100 + intensity);
    let offsets = disc(thickness);
    let mut out = Vec::with_capacity(src.len());
    let mut values = Vec::with_capacity(offsets.len());
    for y in 0..height {
        for x in 0..width {
            let mut lo = [0u8; 4];
            let mut hi = [0u8; 4];
            for channel in 0..4 {
                values.clear();
                for &(dx, dy) in &offsets {
                    let nx = (x as isize + dx).clamp(0, width as isize - 1) as usize;
                    let ny = (y as isize + dy).clamp(0, height as isize - 1) as usize;
                    values.push(src[(ny * width + nx) * 4 + channel]);
                }
                lo[channel] = rank_estimate(&values, low, quality);
                hi[channel] = rank_estimate(&values, high, quality);
            }
            for channel in 0..3 {
                let range = i32::from(hi[channel]) - i32::from(lo[channel]);
                out.push((255 - range).clamp(0, 255) as u8);
            }
            out.push(hi[3]);
        }
    }
    Ok(out)
}

/// Relief's kernel for `angle` degrees (FX-STYL-RELIEF-01), row-major: `cos(θ + kπ/4)` at the spec's
/// positions, with θ = radians(Angle) and a 1 in the center.
pub fn relief_weights(angle: f32) -> [f32; 9] {
    let theta = angle.to_radians();
    let k = |n: f32| (theta + n * FRAC_PI_4).cos();
    [
        k(-3.0),
        k(-2.0),
        k(-1.0),
        k(4.0),
        1.0,
        k(0.0),
        k(3.0),
        k(2.0),
        k(1.0),
    ]
}

/// Relief (FX-STYL-RELIEF): the straight channels and alpha are convolved with `relief_weights`
/// (divisor 1, clamped), so flat areas are unchanged and edges get a lit rim. `angle` is -180..=180.
pub fn relief_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    angle: f32,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    if !(-180.0..=180.0).contains(&angle) {
        return Err(format!("angle must be -180..=180, got {angle}"));
    }
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }
    let weights = relief_weights(angle);
    let straight: Vec<[f32; 4]> = src
        .as_chunks::<4>()
        .0
        .iter()
        .map(|px| std::array::from_fn(|c| f32::from(px[c]) / 255.0))
        .collect();
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let mut rgba = [0u8; 4];
            for (ch, value) in rgba.iter_mut().enumerate() {
                *value = to_u8(convolve(&weights, x, y, |sx, sy| {
                    clamped(&straight, width, height, sx, sy)[ch]
                }));
            }
            out.extend_from_slice(&rgba);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(width: usize, height: usize, rgba: [u8; 4]) -> Vec<u8> {
        rgba.iter()
            .copied()
            .cycle()
            .take(width * height * 4)
            .collect()
    }

    /// A one-row image of opaque gray levels.
    fn row(levels: &[u8]) -> Vec<u8> {
        levels.iter().flat_map(|&v| [v, v, v, 255]).collect()
    }

    #[test]
    fn edge_gain_normalizes_by_each_kernel_weight_sum() {
        assert_eq!(edge_gain(0.5, false), 0.5);
        assert_eq!(edge_gain(0.75, true), 1.0);
    }

    #[test]
    fn edge_detect_leaves_flat_images_black_and_keeps_alpha() {
        let src = flat(4, 3, [120, 80, 40, 200]);
        let out = edge_detect_rgba8(&src, 4, 3, 1.0, 0.0, false, false).unwrap();
        assert!(out
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| *px == [0, 0, 0, 200]));
    }

    #[test]
    fn edge_detect_lights_a_step_by_the_strength_and_gain() {
        // The Sobel gradient beside a 0 to 255 step is 4, so Strength 0.1 gives an edge of 0.4, which
        // is 102. The flat sides stay black.
        let src = row(&[0, 0, 255, 255]);
        let out = edge_detect_rgba8(&src, 4, 1, 0.1, 0.0, false, false).unwrap();
        assert!((i32::from(out[4]) - 102).abs() <= 1, "red {}", out[4]);
        assert!((i32::from(out[8]) - 102).abs() <= 1, "red {}", out[8]);
        assert_eq!(out[0], 0);
        assert_eq!(out[12], 0);
        assert_eq!(out[7], 255);
    }

    #[test]
    fn prewitt_normalizes_a_step_like_sobel() {
        let src = row(&[0, 0, 255, 255]);
        let sobel = edge_detect_rgba8(&src, 4, 1, 0.1, 0.0, false, false).unwrap();
        let prewitt = edge_detect_rgba8(&src, 4, 1, 0.1, 0.0, true, false).unwrap();
        for (a, b) in sobel.iter().zip(&prewitt) {
            assert!((i32::from(*a) - i32::from(*b)).abs() <= 1);
        }
    }

    #[test]
    fn edge_detect_overlay_keeps_flat_images_and_draws_edges_on_top() {
        let flat_src = flat(3, 3, [90, 90, 90, 255]);
        assert_eq!(
            edge_detect_rgba8(&flat_src, 3, 3, 1.0, 0.0, false, true).unwrap(),
            flat_src
        );
        // The edge pixel has an edge value of 0.4 in white, at alpha 0.4, over black: 0.4 · 0.4 = 0.16.
        let step = row(&[0, 0, 255, 255]);
        let out = edge_detect_rgba8(&step, 4, 1, 0.1, 0.0, false, true).unwrap();
        assert!((i32::from(out[4]) - 41).abs() <= 1, "red {}", out[4]);
        assert_eq!(out[7], 255);
    }

    #[test]
    fn edge_detect_blur_lowers_the_peak_of_a_step() {
        let step = row(&[0, 0, 0, 0, 255, 255, 255, 255]);
        let sharp = edge_detect_rgba8(&step, 8, 1, 0.1, 0.0, false, false).unwrap();
        let soft = edge_detect_rgba8(&step, 8, 1, 0.1, 3.0, false, false).unwrap();
        let peak = |out: &[u8]| {
            out.as_chunks::<4>()
                .0
                .iter()
                .map(|px| px[0])
                .max()
                .unwrap_or(0)
        };
        assert!(peak(&soft) < peak(&sharp));
        assert!(peak(&soft) > 0);
    }

    #[test]
    fn edge_detect_rejects_bad_input() {
        let src = row(&[0, 255]);
        assert_eq!(
            edge_detect_rgba8(&src, 2, 1, 0.0, 0.0, true, false).unwrap(),
            vec![0, 0, 0, 255, 0, 0, 0, 255]
        );
        assert!(edge_detect_rgba8(&src, 2, 1, 1.5, 0.0, false, false).is_err());
        assert!(edge_detect_rgba8(&src, 2, 1, 0.5, 10.5, false, false).is_err());
        assert!(edge_detect_rgba8(&src[..4], 2, 1, 0.5, 0.0, false, false).is_err());
    }

    #[test]
    fn blur_weights_sum_to_one() {
        let sum: f32 = edge_blur_weights(2.0).iter().sum();
        assert!((sum - 1.0).abs() < 1e-5);
    }

    #[test]
    fn emboss_is_opaque_mid_gray_on_flat_images() {
        let out = emboss_rgba8(&flat(3, 3, [10, 200, 30, 255]), 3, 3, 0.0).unwrap();
        assert!(out
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| *px == [128, 128, 128, 255]));
    }

    #[test]
    fn emboss_at_zero_degrees_lights_the_right_side_of_an_edge() {
        // Right of the edge is brighter: the sum of the kernel over that step is 2.41, which is white.
        let light_right = emboss_rgba8(&row(&[0, 0, 255, 255]), 4, 1, 0.0).unwrap();
        assert_eq!(light_right[4], 255);
        let light_left = emboss_rgba8(&row(&[255, 255, 0, 0]), 4, 1, 0.0).unwrap();
        assert_eq!(light_left[4], 0);
    }

    #[test]
    fn emboss_is_opaque_even_where_the_image_is_transparent() {
        let out = emboss_rgba8(&flat(2, 2, [0, 0, 0, 0]), 2, 2, 90.0).unwrap();
        assert!(out
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| *px == [128, 128, 128, 255]));
    }

    #[test]
    fn emboss_rejects_bad_input() {
        let src = flat(2, 2, [0; 4]);
        assert!(emboss_rgba8(&src, 2, 2, 361.0).is_err());
        assert!(emboss_rgba8(&src, 2, 2, -1.0).is_err());
        assert!(emboss_rgba8(&src[..8], 2, 2, 0.0).is_err());
    }

    #[test]
    fn relief_weights_sum_to_one_so_flat_areas_stay_put() {
        for angle in [0.0f32, 45.0, -120.0, 170.0] {
            let weights = relief_weights(angle);
            let sum: f32 = weights.iter().sum();
            assert!((sum - 1.0).abs() < 1e-5, "angle {angle}: sum {sum}");
            assert_eq!(weights[4], 1.0);
        }
    }

    #[test]
    fn relief_keeps_flat_images_and_their_alpha() {
        let src = flat(3, 3, [90, 40, 200, 77]);
        let out = relief_rgba8(&src, 3, 3, 45.0).unwrap();
        assert!(out
            .iter()
            .zip(&src)
            .all(|(a, b)| (i32::from(*a) - i32::from(*b)).abs() <= 1));
    }

    #[test]
    fn relief_brightens_a_rising_edge_and_darkens_a_falling_one() {
        // At 45 degrees the left, middle and right columns weigh -1.71, 1 and 1.71, so a step up to
        // the right lights its pixel and a step down darkens it.
        let up = relief_rgba8(&row(&[0, 0, 255, 255]), 4, 1, 45.0).unwrap();
        assert_eq!(up[4], 255);
        let down = relief_rgba8(&row(&[255, 255, 0, 0]), 4, 1, 45.0).unwrap();
        assert_eq!(down[4], 0);
    }

    #[test]
    fn relief_rejects_bad_input() {
        let src = flat(2, 2, [0; 4]);
        assert!(relief_rgba8(&src, 2, 2, 181.0).is_err());
        assert!(relief_rgba8(&src[..8], 2, 2, 45.0).is_err());
    }

    #[test]
    fn outline_keeps_flat_images_white_with_their_alpha() {
        let src = flat(3, 3, [90, 40, 200, 77]);
        let out = outline_rgba8(&src, 3, 3, 2, 50, 8).unwrap();
        assert!(out
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| *px == [255, 255, 255, 77]));
    }

    #[test]
    fn outline_draws_dark_lines_where_the_local_range_is_large() {
        // At Thickness 1 and Intensity 100 the range is the min to the max of the cross around each
        // pixel. The two pixels beside the step see both sides, so they are black. The others are white.
        let src = row(&[0, 0, 255, 255]);
        let out = outline_rgba8(&src, 4, 1, 1, 100, 8).unwrap();
        assert_eq!(out[0], 255);
        assert_eq!(out[4], 0);
        assert_eq!(out[8], 0);
        assert_eq!(out[12], 255);
        assert_eq!(out[7], 255);
    }

    #[test]
    fn outline_at_zero_intensity_is_white_because_both_ranks_are_the_median() {
        let src = row(&[0, 0, 255, 255]);
        let out = outline_rgba8(&src, 4, 1, 1, 0, 8).unwrap();
        assert!(out
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| px[..3] == [255, 255, 255]));
    }

    #[test]
    fn outline_takes_its_alpha_from_the_high_filter() {
        // Alpha steps from 0 to 255, so the high filter (the maximum at Intensity 100) gives 255 beside it.
        let src = [0u8, 0, 0, 0, 255, 0, 0, 255];
        let out = outline_rgba8(&src, 2, 1, 1, 100, 8).unwrap();
        assert_eq!(out[3], 255);
        assert_eq!(out[7], 255);
    }

    #[test]
    fn outline_rejects_bad_input() {
        let src = flat(2, 2, [0; 4]);
        assert!(outline_rgba8(&src, 2, 2, 0, 50, 8).is_err());
        assert!(outline_rgba8(&src, 2, 2, 51, 50, 8).is_err());
        assert!(outline_rgba8(&src, 2, 2, 3, 101, 8).is_err());
        assert!(outline_rgba8(&src, 2, 2, 3, 50, 0).is_err());
        assert!(outline_rgba8(&src, 2, 2, 3, 50, 13).is_err());
        assert!(outline_rgba8(&src[..8], 2, 2, 3, 50, 8).is_err());
    }
}
