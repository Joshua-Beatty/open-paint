//! Object effects (FX-OBJ): Drop Shadow. The work is in linear light, and the WGSL twin in
//! `packages/effects` runs the same stages in the same order, so the GPU result stays within ±1.
//!
//! Stages: the layer's alpha is blurred with a Gaussian (σ = radius / 3) over transparent pixels
//! outside the image, the blurred alpha is shifted by the offset with bilinear sampling, and the
//! shadow color and Opacity are applied. Unless *Only draw shadow* is on, the layer is composited
//! over the shadow (source-over), in premultiplied linear light.

use crate::artistic::{check_image, to_u8};
use crate::blur::kernel;
use crate::srgb::{to_linear, to_srgb};

/// The largest Shadow Radius the engine accepts (the dialog shows 0 to 100, FX-OBJ-DROPSHADOW-01).
pub const DROP_SHADOW_MAX_RADIUS: f32 = 300.0;
/// The largest Distance, in pixels (FX-OBJ-DROPSHADOW-01).
pub const DROP_SHADOW_MAX_DISTANCE: f32 = 100.0;

/// The blur weights of the shadow: a Gaussian of σ = radius / 3 (FX-SHARED-STDDEV) over
/// `blur::kernel`. A radius of 0 gives `[1]`, so the alpha is not blurred.
pub fn drop_shadow_weights(radius: f32) -> Result<Vec<f32>, String> {
    if !(radius.is_finite() && (0.0..=DROP_SHADOW_MAX_RADIUS).contains(&radius)) {
        return Err(format!("radius must be 0..=300, got {radius}"));
    }
    Ok(kernel(radius / 3.0))
}

/// The numbers both backends compute from the parameters, as `[dx, dy, r, g, b, opacity]`. The
/// offset `(dx, dy)` is `Distance · (cos φ, sin φ)` with `φ = radians(-Angle)`, so the default
/// -45° points down and to the right. The color is the sRGB `color` (0xRRGGBB) in linear light.
pub fn drop_shadow_plan(
    distance: f32,
    angle: f32,
    opacity: f32,
    color: u32,
) -> Result<[f32; 6], String> {
    if !(0.0..=DROP_SHADOW_MAX_DISTANCE).contains(&distance) {
        return Err(format!("distance must be 0..=100, got {distance}"));
    }
    if !(-180.0..=180.0).contains(&angle) {
        return Err(format!("angle must be -180..=180, got {angle}"));
    }
    if !(0.0..=1.0).contains(&opacity) {
        return Err(format!("opacity must be 0..=1, got {opacity}"));
    }
    if color > 0xFF_FFFF {
        return Err(format!("color must be a 24-bit RGB value, got {color}"));
    }
    let phi = f64::from(-angle).to_radians();
    let distance = f64::from(distance);
    let dx = (distance * phi.cos()) as f32;
    let dy = (distance * phi.sin()) as f32;
    let linear = |shift: u32| to_linear(((color >> shift) & 255) as f32 / 255.0);
    Ok([dx, dy, linear(16), linear(8), linear(0), opacity])
}

/// One separable pass of `weights` (centered, odd length) over a `width` x `height` plane of
/// values. Samples outside the image count as zero, so the shadow fades past the image edge.
fn blur_zero(
    plane: &[f32],
    width: usize,
    height: usize,
    weights: &[f32],
    horizontal: bool,
) -> Vec<f32> {
    let half = (weights.len() / 2) as isize;
    let (w, h) = (width as isize, height as isize);
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            let mut acc = 0.0f32;
            for (k, &weight) in weights.iter().enumerate() {
                let offset = k as isize - half;
                let (sx, sy) = if horizontal {
                    (x as isize + offset, y as isize)
                } else {
                    (x as isize, y as isize + offset)
                };
                if (0..w).contains(&sx) && (0..h).contains(&sy) {
                    acc += weight * plane[sy as usize * width + sx as usize];
                }
            }
            out.push(acc);
        }
    }
    out
}

/// The value at (x, y) of a plane, or zero outside it.
fn sample_zero(plane: &[f32], width: usize, height: usize, x: isize, y: isize) -> f32 {
    if x < 0 || y < 0 || x >= width as isize || y >= height as isize {
        0.0
    } else {
        plane[y as usize * width + x as usize]
    }
}

/// The bilinear sample of a plane at the pixel-index coordinate (sx, sy), with zeros outside.
fn bilinear_zero(plane: &[f32], width: usize, height: usize, sx: f32, sy: f32) -> f32 {
    let (x0, y0) = (sx.floor(), sy.floor());
    let (tx, ty) = (sx - x0, sy - y0);
    let (x0, y0) = (x0 as isize, y0 as isize);
    let at = |x: isize, y: isize| sample_zero(plane, width, height, x, y);
    let top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    let bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    top + (bottom - top) * ty
}

/// Drop Shadow (FX-OBJ-DROPSHADOW) of a straight-alpha RGBA8 image. `radius` is 0..=300,
/// `distance` 0..=100, `angle` -180..=180, `opacity` 0..=1 and `color` 0xRRGGBB. With
/// `only_shadow`, the output is the shadow alone.
#[allow(clippy::too_many_arguments)]
pub fn drop_shadow_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    radius: f32,
    distance: f32,
    angle: f32,
    opacity: f32,
    color: u32,
    only_shadow: bool,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    let weights = drop_shadow_weights(radius)?;
    let [dx, dy, r, g, b, opacity] = drop_shadow_plan(distance, angle, opacity, color)?;
    let pixels = src.as_chunks::<4>().0;
    let alpha: Vec<f32> = pixels.iter().map(|px| f32::from(px[3]) / 255.0).collect();
    let across = blur_zero(&alpha, width, height, &weights, true);
    let blurred = blur_zero(&across, width, height, &weights, false);

    let mut out = Vec::with_capacity(src.len());
    for (i, px) in pixels.iter().enumerate() {
        let (x, y) = ((i % width) as f32, (i / width) as f32);
        let shadow_alpha = opacity * bilinear_zero(&blurred, width, height, x - dx, y - dy);
        let shadow = [r * shadow_alpha, g * shadow_alpha, b * shadow_alpha];
        let (premultiplied, alpha_out) = if only_shadow {
            (shadow, shadow_alpha)
        } else {
            let a = f32::from(px[3]) / 255.0;
            let rest = 1.0 - a;
            let source = [px[0], px[1], px[2]].map(|c| to_linear(f32::from(c) / 255.0) * a);
            (
                [0, 1, 2].map(|c| source[c] + shadow[c] * rest),
                a + shadow_alpha * rest,
            )
        };
        for channel in premultiplied {
            let straight = if alpha_out > 0.0 {
                (channel / alpha_out).clamp(0.0, 1.0)
            } else {
                0.0
            };
            out.push(to_u8(to_srgb(straight)));
        }
        out.push(to_u8(alpha_out));
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

    fn alpha_at(out: &[u8], width: usize, x: usize, y: usize) -> u8 {
        out[(y * width + x) * 4 + 3]
    }

    #[test]
    fn default_angle_offsets_the_shadow_down_and_right() {
        let plan = drop_shadow_plan(10.0, -45.0, 0.75, 0).unwrap();
        let step = 10.0 / 2f32.sqrt();
        assert!((plan[0] - step).abs() < 1e-5, "dx {}", plan[0]);
        assert!((plan[1] - step).abs() < 1e-5, "dy {}", plan[1]);
        assert_eq!(plan[5], 0.75);
    }

    #[test]
    fn angle_minus_ninety_offsets_straight_down() {
        let plan = drop_shadow_plan(4.0, -90.0, 1.0, 0).unwrap();
        assert!(plan[0].abs() < 1e-6);
        assert!((plan[1] - 4.0).abs() < 1e-6);
    }

    #[test]
    fn shadow_color_is_converted_to_linear_light() {
        let plan = drop_shadow_plan(0.0, 0.0, 1.0, 0xFF_80_00).unwrap();
        assert!((plan[2] - 1.0).abs() < 1e-6);
        assert!((plan[3] - to_linear(128.0 / 255.0)).abs() < 1e-6);
        assert_eq!(plan[4], 0.0);
    }

    #[test]
    fn weights_are_a_gaussian_of_a_third_of_the_radius() {
        assert_eq!(drop_shadow_weights(0.0).unwrap(), vec![1.0]);
        assert_eq!(drop_shadow_weights(3.0).unwrap(), kernel(1.0));
        assert_eq!(drop_shadow_weights(3.0).unwrap().len(), 7);
    }

    #[test]
    fn an_opaque_image_with_no_offset_or_blur_keeps_its_colors() {
        let src = flat(4, 4, [200, 100, 50, 255]);
        let out = drop_shadow_rgba8(&src, 4, 4, 0.0, 0.0, -45.0, 0.75, 0, false).unwrap();
        for (a, b) in out.iter().zip(&src) {
            assert!((i32::from(*a) - i32::from(*b)).abs() <= 1, "{a} vs {b}");
        }
    }

    #[test]
    fn only_shadow_puts_the_shadow_below_the_object() {
        // One opaque pixel at (2, 1) with a black shadow 2 px straight down.
        let mut src = flat(5, 5, [0, 0, 0, 0]);
        src[(5 + 2) * 4 + 3] = 255;
        let out = drop_shadow_rgba8(&src, 5, 5, 0.0, 2.0, -90.0, 1.0, 0, true).unwrap();
        assert_eq!(alpha_at(&out, 5, 2, 3), 255);
        assert_eq!(alpha_at(&out, 5, 2, 1), 0);
    }

    #[test]
    fn the_object_is_drawn_over_its_shadow() {
        let mut src = flat(5, 5, [0, 0, 0, 0]);
        let center = (2 * 5 + 2) * 4;
        src[center..center + 4].copy_from_slice(&[200, 100, 50, 255]);
        let out = drop_shadow_rgba8(&src, 5, 5, 0.0, 0.0, -45.0, 1.0, 0, false).unwrap();
        for c in 0..3 {
            assert!((i32::from(out[center + c]) - i32::from(src[center + c])).abs() <= 1);
        }
        assert_eq!(out[center + 3], 255);
    }

    #[test]
    fn a_blurred_shadow_spreads_past_its_edge_and_fades() {
        let mut src = flat(9, 1, [0, 0, 0, 0]);
        src[4 * 4 + 3] = 255;
        let out = drop_shadow_rgba8(&src, 9, 1, 3.0, 0.0, 0.0, 1.0, 0, true).unwrap();
        let (near, far) = (alpha_at(&out, 9, 3, 0), alpha_at(&out, 9, 1, 0));
        assert!(near > 0 && near < 255, "near {near}");
        assert!(far < near, "far {far} near {near}");
    }

    #[test]
    fn a_transparent_image_stays_transparent() {
        let src = flat(3, 3, [90, 90, 90, 0]);
        let out = drop_shadow_rgba8(&src, 3, 3, 4.0, 5.0, -45.0, 0.75, 0, false).unwrap();
        assert!(out.iter().all(|&v| v == 0));
    }

    #[test]
    fn rejects_bad_arguments() {
        let src = flat(2, 2, [0; 4]);
        assert!(drop_shadow_rgba8(&src, 2, 2, -1.0, 0.0, 0.0, 1.0, 0, false).is_err());
        assert!(drop_shadow_rgba8(&src, 2, 2, 301.0, 0.0, 0.0, 1.0, 0, false).is_err());
        assert!(drop_shadow_rgba8(&src, 2, 2, 1.0, -1.0, 0.0, 1.0, 0, false).is_err());
        assert!(drop_shadow_rgba8(&src, 2, 2, 1.0, 101.0, 0.0, 1.0, 0, false).is_err());
        assert!(drop_shadow_rgba8(&src, 2, 2, 1.0, 1.0, 181.0, 1.0, 0, false).is_err());
        assert!(drop_shadow_rgba8(&src, 2, 2, 1.0, 1.0, 0.0, 1.5, 0, false).is_err());
        assert!(drop_shadow_rgba8(&src, 2, 2, 1.0, 1.0, 0.0, 1.0, 0x100_0000, false).is_err());
        assert!(drop_shadow_rgba8(&src[..8], 2, 2, 1.0, 1.0, 0.0, 1.0, 0, false).is_err());
    }
}
