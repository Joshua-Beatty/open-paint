//! Radial Blur and Zoom Blur (FX-BLUR-RADIAL, FX-BLUR-ZOOM). Both average bilinear samples of the
//! premultiplied source along a path through each pixel. `packages/effects/src/radial-blur-wgsl.ts`
//! and `zoom-blur-wgsl.ts` are the WGSL twins. They read the plans computed here, so both backends
//! sample the same points with the same weights.

use crate::directional_blur::coverage;
use crate::distort::{premultiply, push_straight, sample, EdgeMode, MAX_QUALITY};
use std::f32::consts::PI;

/// The number of samples at a Quality (FX-BLUR-RADIAL-03): `floor(2^(Quality + 5))`, so 64 at 1 and
/// 8192 at 8. A decimal Quality gives a count between two powers of two.
pub fn sample_count(quality: f32) -> Result<usize, String> {
    if !(1.0..=f32::from(MAX_QUALITY)).contains(&quality) {
        return Err(format!("quality must be 1-{MAX_QUALITY}, got {quality}"));
    }
    Ok(2f32.powf(quality + 5.0).floor() as usize)
}

/// The rotations of Radial Blur (FX-BLUR-RADIAL-03), flattened to `cos, sin` pairs. The sample angles
/// run evenly from `-angle / 2` to `+angle / 2`, with both ends included.
pub fn radial_plan(angle: f32, quality: f32) -> Result<Vec<f32>, String> {
    if !(angle.is_finite() && angle >= 0.0) {
        return Err(format!("radial angle must be 0 or more, got {angle}"));
    }
    let count = sample_count(quality)?;
    let arc = angle * PI / 180.0;
    let mut plan = Vec::with_capacity(2 * count);
    for i in 0..count {
        let t = i as f32 / (count - 1).max(1) as f32;
        let theta = -arc / 2.0 + arc * t;
        plan.push(theta.cos());
        plan.push(theta.sin());
    }
    Ok(plan)
}

/// Radial Blur of a straight-alpha RGBA8 image (FX-BLUR-RADIAL-03). Each output is the average of the
/// premultiplied source at every rotation of the pixel about `center` (in pixels), divided by the
/// coverage of the samples inside the image. Samples outside the image count for nothing.
pub fn radial_blur_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    center: [f32; 2],
    plan: &[f32],
) -> Result<Vec<u8>, String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    if plan.is_empty() || !plan.len().is_multiple_of(2) {
        return Err("radial plan needs cos, sin pairs".to_string());
    }
    let plane = premultiply(src);
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - center[0];
            let dy = y as f32 + 0.5 - center[1];
            let mut acc = [0.0f32; 4];
            let mut total = 0.0f32;
            for rotation in plan.as_chunks::<2>().0 {
                let (cos, sin) = (rotation[0], rotation[1]);
                let s = [
                    center[0] + cos * dx - sin * dy,
                    center[1] + sin * dx + cos * dy,
                ];
                let texel = sample(&plane, width, height, s, EdgeMode::Transparent);
                for (sum, value) in acc.iter_mut().zip(texel) {
                    *sum += value;
                }
                total += coverage(width, height, s);
            }
            if total > 0.0 {
                push_straight(&mut out, acc.map(|sum| sum / total));
            } else {
                out.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
    Ok(out)
}

/// The scales of Zoom Blur (FX-BLUR-ZOOM-03), flattened to `scale, weight` pairs. The scales step
/// evenly from `min(distance, 1)` to `max(distance, 1)`. Each weight is `|(s - a) / b|^focus`, where
/// `b` is the range width and `a` its far end from scale 1, and the weights are normalized to sum 1.
/// Empty when the distance is 1, which passes the image through.
pub fn zoom_plan(distance: f32, focus: f32, quality: f32) -> Result<Vec<f32>, String> {
    if !(distance.is_finite() && distance > 0.0) {
        return Err(format!("zoom distance must be above 0, got {distance}"));
    }
    if !(focus.is_finite() && focus >= 0.0) {
        return Err(format!("zoom focus must be 0 or more, got {focus}"));
    }
    let count = sample_count(quality)?;
    let (low, high) = (distance.min(1.0), distance.max(1.0));
    if high == low {
        return Ok(Vec::new());
    }
    let far = if distance > 1.0 { high } else { low };
    let width = high - low;
    let mut plan = Vec::with_capacity(2 * count);
    let mut total = 0.0f32;
    for i in 0..count {
        let t = i as f32 / (count - 1) as f32;
        let scale = low + width * t;
        let weight = ((scale - far) / width).abs().powf(focus);
        plan.push(scale);
        plan.push(weight);
        total += weight;
    }
    for weight in plan.iter_mut().skip(1).step_by(2) {
        *weight /= total;
    }
    Ok(plan)
}

/// Zoom Blur of a straight-alpha RGBA8 image (FX-BLUR-ZOOM-03). Each output is the weighted sum of the
/// premultiplied source at `center + (p - center) / scale` for each scale of `plan`. The source has a
/// clamped border, so every sample has full coverage and the weights sum to 1.
pub fn zoom_blur_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    center: [f32; 2],
    plan: &[f32],
) -> Result<Vec<u8>, String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    if !plan.len().is_multiple_of(2) {
        return Err("zoom plan needs scale, weight pairs".to_string());
    }
    if plan.is_empty() {
        return Ok(src.to_vec());
    }
    let plane = premultiply(src);
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - center[0];
            let dy = y as f32 + 0.5 - center[1];
            let mut acc = [0.0f32; 4];
            for step in plan.as_chunks::<2>().0 {
                let scale = step[0];
                let s = [center[0] + dx / scale, center[1] + dy / scale];
                let texel = sample(&plane, width, height, s, EdgeMode::Clamp);
                for (sum, value) in acc.iter_mut().zip(texel) {
                    *sum += step[1] * value;
                }
            }
            push_straight(&mut out, acc);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn sample_counts_follow_the_quality_power_law() {
        assert_eq!(sample_count(1.0).unwrap(), 64);
        assert_eq!(sample_count(2.0).unwrap(), 128);
        assert_eq!(sample_count(8.0).unwrap(), 8192);
        assert_eq!(sample_count(1.5).unwrap(), 90);
        assert!(sample_count(0.5).is_err());
        assert!(sample_count(9.0).is_err());
        assert!(sample_count(f32::NAN).is_err());
    }

    #[test]
    fn radial_plan_spans_the_arc_with_both_ends_included() {
        let plan = radial_plan(90.0, 1.0).unwrap();
        assert_eq!(plan.len(), 128);
        let (first_cos, first_sin) = (plan[0], plan[1]);
        assert!((first_cos - (PI / 4.0).cos()).abs() < 1e-5);
        assert!((first_sin + (PI / 4.0).sin()).abs() < 1e-5, "{first_sin}");
        let (last_cos, last_sin) = (plan[126], plan[127]);
        assert!((last_cos - (PI / 4.0).cos()).abs() < 1e-5);
        assert!((last_sin - (PI / 4.0).sin()).abs() < 1e-5);
        assert!(radial_plan(-1.0, 1.0).is_err());
    }

    #[test]
    fn zero_angle_and_uniform_images_are_unchanged() {
        let src = ramp(9, 7);
        let plan = radial_plan(0.0, 1.0).unwrap();
        assert_eq!(radial_blur_rgba8(&src, 9, 7, [4.5, 3.5], &plan).unwrap(), src);
        let uniform = [30u8, 60, 90, 255].repeat(12 * 10);
        let plan = radial_plan(60.0, 1.0).unwrap();
        assert_eq!(
            radial_blur_rgba8(&uniform, 12, 10, [2.0, 9.0], &plan).unwrap(),
            uniform
        );
    }

    #[test]
    fn radial_blur_keeps_the_center_pixel_and_spreads_others_along_the_arc() {
        let mut src = [0u8, 0, 0, 255].repeat(9 * 9);
        let center = 4 * 9 + 4;
        src[center * 4..center * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
        let plan = radial_plan(90.0, 1.0).unwrap();
        let out = radial_blur_rgba8(&src, 9, 9, [4.5, 4.5], &plan).unwrap();
        // The center pixel rotates about itself, so it keeps its value.
        assert_eq!(out[center * 4], 255);
        // A pixel one step to the right is smeared around the circle through the bright center.
        let right = 4 * 9 + 5;
        assert!(out[right * 4] > 0 && out[right * 4] < 255);
    }

    #[test]
    fn radial_blur_of_an_opaque_image_keeps_its_color_at_the_edges() {
        let src = [200u8, 100, 50, 255].repeat(6 * 6);
        let plan = radial_plan(120.0, 1.0).unwrap();
        let out = radial_blur_rgba8(&src, 6, 6, [3.0, 3.0], &plan).unwrap();
        for (a, b) in out.iter().zip(&src) {
            assert!(a.abs_diff(*b) <= 1, "{a} vs {b}");
        }
    }

    #[test]
    fn zoom_plan_is_empty_at_scale_one_and_normalized_otherwise() {
        assert!(zoom_plan(1.0, 2.0, 1.0).unwrap().is_empty());
        let plan = zoom_plan(1.25, 2.0, 1.0).unwrap();
        assert_eq!(plan.len(), 128);
        let total: f32 = plan.iter().skip(1).step_by(2).sum();
        assert!((total - 1.0).abs() < 1e-5, "total {total}");
        assert!((plan[0] - 1.0).abs() < 1e-6);
        assert!((plan[126] - 1.25).abs() < 1e-6);
        // The far end (scale 1.25) has no weight, and the scale near 1 carries the most.
        assert!(plan[1] > plan[127]);
        assert_eq!(plan[127], 0.0);
    }

    #[test]
    fn zoom_out_weights_the_scale_near_one_most() {
        let plan = zoom_plan(0.5, 2.0, 1.0).unwrap();
        assert!((plan[0] - 0.5).abs() < 1e-6);
        assert!((plan[126] - 1.0).abs() < 1e-6);
        assert_eq!(plan[1], 0.0);
        assert!(plan[127] > plan[1]);
    }

    #[test]
    fn higher_focus_concentrates_the_weight_near_scale_one() {
        let soft = zoom_plan(2.0, 1.0, 1.0).unwrap();
        let sharp = zoom_plan(2.0, 4.0, 1.0).unwrap();
        // The weight at scale 1 (index 0) is larger when Focus is higher.
        assert!(sharp[1] > soft[1]);
    }

    #[test]
    fn zoom_blur_of_a_uniform_image_and_of_scale_one_is_unchanged() {
        let uniform = [30u8, 60, 90, 255].repeat(10 * 8);
        let plan = zoom_plan(2.5, 2.0, 1.0).unwrap();
        assert_eq!(
            zoom_blur_rgba8(&uniform, 10, 8, [5.0, 4.0], &plan).unwrap(),
            uniform
        );
        let src = ramp(7, 5);
        assert_eq!(
            zoom_blur_rgba8(&src, 7, 5, [3.5, 2.5], &zoom_plan(1.0, 2.0, 1.0).unwrap()).unwrap(),
            src
        );
    }

    #[test]
    fn zoom_blur_smears_a_point_outward_from_the_center() {
        // Pixel p reads the source at center + (p - center) / scale, so a bright pixel at distance 2
        // is seen from the pixels farther out, and never from the pixels between it and the center.
        let mut src = [0u8, 0, 0, 255].repeat(9 * 9);
        let bright = 4 * 9 + 6;
        src[bright * 4..bright * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
        let plan = zoom_plan(2.0, 1.0, 1.0).unwrap();
        let out = zoom_blur_rgba8(&src, 9, 9, [4.5, 4.5], &plan).unwrap();
        let red = |x: usize| out[(4 * 9 + x) * 4];
        assert!(red(7) > 0 && red(8) > 0);
        assert_eq!(red(5), 0);
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        let src = ramp(2, 2);
        assert!(zoom_plan(0.0, 2.0, 1.0).is_err());
        assert!(zoom_plan(f32::NAN, 2.0, 1.0).is_err());
        assert!(zoom_plan(1.5, -1.0, 1.0).is_err());
        assert!(zoom_blur_rgba8(&src, 2, 2, [1.0, 1.0], &[1.0]).is_err());
        assert!(zoom_blur_rgba8(&src, 3, 2, [1.0, 1.0], &[]).is_err());
        assert!(radial_blur_rgba8(&src, 2, 2, [1.0, 1.0], &[1.0]).is_err());
        assert!(radial_blur_rgba8(&src, 2, 2, [1.0, 1.0], &[]).is_err());
        assert!(radial_blur_rgba8(&src, 3, 2, [1.0, 1.0], &[1.0, 0.0]).is_err());
    }
}
