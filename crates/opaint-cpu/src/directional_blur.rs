//! Fragment Blur and Motion Blur (FX-BLUR-FRAG, FX-BLUR-MOTION). Both average bilinear samples of the
//! premultiplied source at fixed offsets from each pixel. `packages/effects/src/fragment-blur-wgsl.ts`
//! and `motion-blur-wgsl.ts` are the WGSL twins. They read the offsets and weights computed here, so
//! both backends sample the same points with the same numbers.

use crate::distort::{premultiply, push_straight, sample, EdgeMode};
use std::f32::consts::PI;

/// The largest Fragment Count (FX-BLUR-FRAG-02).
pub const MAX_FRAGMENTS: u32 = 200;

/// The spacing of the Motion Blur samples along the path, in pixels (FX-BLUR-MOTION-03).
pub const MOTION_STEP: f32 = 0.125;

/// The offsets of Fragment Blur (FX-BLUR-FRAG-03), as `dx, dy` pairs in pixels. Fragment `i` sits at
/// `distance · (sin θᵢ, cos θᵢ)`, with `θᵢ = (rotation − 90°) + i · 2π / count`.
pub fn fragment_offsets(count: u32, distance: f32, rotation: f32) -> Result<Vec<f32>, String> {
    if !(1..=MAX_FRAGMENTS).contains(&count) {
        return Err(format!(
            "fragment count must be 1-{MAX_FRAGMENTS}, got {count}"
        ));
    }
    if !(distance.is_finite() && distance >= 0.0) {
        return Err(format!(
            "fragment distance must be 0 or more, got {distance}"
        ));
    }
    if !rotation.is_finite() {
        return Err(format!("fragment rotation must be finite, got {rotation}"));
    }
    let start = (rotation - 90.0) * PI / 180.0;
    let step = 2.0 * PI / count as f32;
    let mut offsets = Vec::with_capacity(2 * count as usize);
    for i in 0..count {
        let theta = start + i as f32 * step;
        offsets.push(distance * theta.sin());
        offsets.push(distance * theta.cos());
    }
    Ok(offsets)
}

/// The integer tap below a sample position and the fraction past it, as `sample` splits them.
fn base_and_fraction(s: f32) -> (isize, f32) {
    let u = s - 0.5;
    let base = u.floor();
    (base as isize, u - base)
}

/// The bilinear weight of the taps of `s` that lie inside the image: the sample's coverage.
pub(crate) fn coverage(width: usize, height: usize, s: [f32; 2]) -> f32 {
    let (x0, fx) = base_and_fraction(s[0]);
    let (y0, fy) = base_and_fraction(s[1]);
    let (w, h) = (width as isize, height as isize);
    let mut total = 0.0;
    for (dy, wy) in [(0, 1.0 - fy), (1, fy)] {
        for (dx, wx) in [(0, 1.0 - fx), (1, fx)] {
            let (ix, iy) = (x0 + dx, y0 + dy);
            if (0..w).contains(&ix) && (0..h).contains(&iy) {
                total += wx * wy;
            }
        }
    }
    total
}

/// Fragment Blur of a straight-alpha RGBA8 image (FX-BLUR-FRAG-03). Each output is the sum of the
/// premultiplied source at every fragment offset, divided by the coverage sum. Samples outside the
/// image count for nothing, so the edges average over the copies that lie inside.
pub fn fragment_blur_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    count: u32,
    distance: f32,
    rotation: f32,
) -> Result<Vec<u8>, String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    let offsets = fragment_offsets(count, distance, rotation)?;
    let plane = premultiply(src);
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let mut acc = [0.0f32; 4];
            let mut total = 0.0f32;
            for offset in offsets.as_chunks::<2>().0 {
                let s = [x as f32 + 0.5 + offset[0], y as f32 + 0.5 + offset[1]];
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

/// The Motion Blur kernel (FX-BLUR-MOTION-03), flattened to `dx, dy, weight` triples in pixels. The
/// direction is `(cos θ, −sin θ)`, so positive angles point up and right. Samples lie every
/// `MOTION_STEP` px along the path, and their Gaussian weights sum to 1. A centered path spans
/// ±distance/2 around the pixel, with σ = distance/6. Otherwise the path spans 0..distance behind the
/// motion (the reversed direction), with σ = distance/3. Empty when the distance is 0 or less, which
/// passes the image through.
pub fn motion_plan(distance: f32, angle: f32, centered: bool) -> Result<Vec<f32>, String> {
    if !distance.is_finite() {
        return Err(format!("motion distance must be finite, got {distance}"));
    }
    if !angle.is_finite() {
        return Err(format!("motion angle must be finite, got {angle}"));
    }
    if distance <= 0.0 {
        return Ok(Vec::new());
    }
    let theta = angle * PI / 180.0;
    let (dir_x, dir_y) = (theta.cos(), -theta.sin());
    let (sign, start, center, sigma) = if centered {
        (1.0, -distance / 2.0, 0.0, distance / 6.0)
    } else {
        (-1.0, 0.0, distance / 2.0, distance / 3.0)
    };
    let count = (distance / MOTION_STEP).floor() as usize + 1;
    let mut plan = Vec::with_capacity(3 * count);
    let mut total = 0.0f32;
    for k in 0..count {
        let t = start + k as f32 * MOTION_STEP;
        let u = t - center;
        let weight = (-(u * u) / (2.0 * sigma * sigma)).exp();
        total += weight;
        plan.push(sign * t * dir_x);
        plan.push(sign * t * dir_y);
        plan.push(weight);
    }
    for weight in plan.iter_mut().skip(2).step_by(3) {
        *weight /= total;
    }
    Ok(plan)
}

/// Motion Blur of a straight-alpha RGBA8 image (FX-BLUR-MOTION-03). Each output is the weighted sum of
/// the premultiplied source along the kernel from `motion_plan`, read with the edge mode.
pub fn motion_blur_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    distance: f32,
    angle: f32,
    centered: bool,
    edge: EdgeMode,
) -> Result<Vec<u8>, String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    let plan = motion_plan(distance, angle, centered)?;
    if plan.is_empty() {
        return Ok(src.to_vec());
    }
    let plane = premultiply(src);
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let mut acc = [0.0f32; 4];
            for kernel in plan.as_chunks::<3>().0 {
                let s = [x as f32 + 0.5 + kernel[0], y as f32 + 0.5 + kernel[1]];
                let texel = sample(&plane, width, height, s, edge);
                for (sum, value) in acc.iter_mut().zip(texel) {
                    *sum += kernel[2] * value;
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

    fn gradient(width: usize, height: usize) -> Vec<u8> {
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

    fn triples(plan: &[f32]) -> Vec<[f32; 3]> {
        plan.as_chunks::<3>().0.to_vec()
    }

    #[test]
    fn fragment_offsets_place_the_copies_on_a_circle() {
        let offsets = fragment_offsets(4, 1.0, 0.0).unwrap();
        // Rotation 0 puts the first copy to the left, then steps clockwise through 90°.
        let expected = [-1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, -1.0];
        for (got, want) in offsets.iter().zip(expected) {
            assert!((got - want).abs() < 1e-6, "got {got}, want {want}");
        }
    }

    #[test]
    fn zero_distance_and_uniform_opaque_images_are_unchanged() {
        let src = gradient(9, 7);
        assert_eq!(fragment_blur_rgba8(&src, 9, 7, 6, 0.0, 33.0).unwrap(), src);
        let uniform = [30u8, 60, 90, 255].repeat(16 * 16);
        assert_eq!(
            fragment_blur_rgba8(&uniform, 16, 16, 8, 3.0, 17.0).unwrap(),
            uniform
        );
    }

    #[test]
    fn samples_outside_the_image_are_excluded_not_counted_as_transparent() {
        // In a one-row image, the copies above and below are outside. The two copies inside keep the
        // color, so no edge pixel fades.
        let src = [200u8, 100, 50, 255].repeat(5);
        assert_eq!(fragment_blur_rgba8(&src, 5, 1, 4, 1.0, 0.0).unwrap(), src);
    }

    #[test]
    fn a_pixel_with_every_copy_outside_stays_transparent() {
        // Two copies at 0° and 180°, five rows away from the only pixel: both are outside.
        let out = fragment_blur_rgba8(&[9, 9, 9, 255], 1, 1, 2, 5.0, 90.0).unwrap();
        assert_eq!(out, [0, 0, 0, 0]);
    }

    #[test]
    fn motion_plan_is_normalized_symmetric_and_follows_the_angle() {
        let plan = triples(&motion_plan(10.0, 0.0, true).unwrap());
        assert_eq!(plan.len(), 81);
        let total: f32 = plan.iter().map(|s| s[2]).sum();
        assert!((total - 1.0).abs() < 1e-5, "total {total}");
        assert!(
            plan.iter().all(|s| s[1].abs() < 1e-6),
            "angle 0 moves along x"
        );
        assert_eq!(plan[0][0], -5.0);
        assert_eq!(plan[80][0], 5.0);
        for (near, far) in plan.iter().zip(plan.iter().rev()) {
            assert!((near[2] - far[2]).abs() < 1e-6);
        }
    }

    #[test]
    fn a_trailing_path_lies_behind_the_motion() {
        // Up is negative y on screen, so a path at 90° that trails behind points down (positive y).
        let plan = triples(&motion_plan(10.0, 90.0, false).unwrap());
        assert!(plan.iter().all(|s| s[1] >= 0.0));
        assert_eq!(plan[0][1], 0.0);
        assert!((plan[80][1] - 10.0).abs() < 1e-4);
    }

    #[test]
    fn a_horizontal_motion_spreads_a_point_symmetrically_along_the_row() {
        let mut src = [0u8, 0, 0, 255].repeat(9);
        src[4 * 4..4 * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
        let out = motion_blur_rgba8(&src, 9, 1, 4.0, 0.0, true, EdgeMode::Clamp).unwrap();
        let red = |x: usize| out[x * 4];
        assert!(red(4) > red(3) && red(3) > red(2) && red(2) > 0);
        assert_eq!(red(0), 0);
        assert!(red(3).abs_diff(red(5)) <= 1);
    }

    #[test]
    fn uniform_images_keep_their_color_under_every_opaque_edge_mode() {
        let src = [30u8, 60, 90, 255].repeat(6 * 5);
        for edge in [EdgeMode::Clamp, EdgeMode::Wrap, EdgeMode::Reflect] {
            let out = motion_blur_rgba8(&src, 6, 5, 7.0, 33.0, false, edge).unwrap();
            assert_eq!(out, src, "edge {edge:?}");
        }
    }

    #[test]
    fn transparent_edges_fade_the_pixels_nearest_the_border() {
        let src = [200u8, 0, 0, 255].repeat(4);
        let out = motion_blur_rgba8(&src, 4, 1, 8.0, 0.0, true, EdgeMode::Transparent).unwrap();
        let alpha = |x: usize| out[x * 4 + 3];
        assert!(alpha(0) < alpha(1) && alpha(1) < 255);
    }

    #[test]
    fn a_zero_distance_passes_the_image_through_and_bad_input_is_rejected() {
        let src = gradient(5, 3);
        assert_eq!(
            motion_blur_rgba8(&src, 5, 3, 0.0, 25.0, true, EdgeMode::Clamp).unwrap(),
            src
        );
        assert!(motion_blur_rgba8(&src, 4, 3, 10.0, 0.0, true, EdgeMode::Clamp).is_err());
        assert!(motion_plan(f32::NAN, 0.0, true).is_err());
        assert!(fragment_offsets(0, 1.0, 0.0).is_err());
        assert!(fragment_offsets(201, 1.0, 0.0).is_err());
        assert!(fragment_offsets(2, -1.0, 0.0).is_err());
        assert!(fragment_blur_rgba8(&src, 4, 3, 2, 1.0, 0.0).is_err());
    }
}
