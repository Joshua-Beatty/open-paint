//! Photo effects (FX-PHOTO): Glow, Soften Portrait, Sharpen, Red Eye Removal, Straighten and Vignette.
//! All take and return straight-alpha RGBA8. Glow, Soften Portrait and Sharpen work in document
//! space, and Straighten and Vignette in linear light. The WGSL twins in `packages/effects` mirror
//! each stage in the same order, so the GPU result stays within ±1.

use crate::adjust::brightness_contrast_plan;
use crate::artistic::{brightness_contrast_color, check_image, luma, straight, to_u8};
use crate::blur::blur_clamped_rgba8;
use crate::srgb::{to_linear, to_srgb};
use crate::transform::{transform_rgba8, Sampling, Spec};

/// The Gaussian radius of Glow is its Radius times this factor (FX-PHOTO-GLOW-01).
pub const GLOW_RADIUS_FACTOR: f32 = 1.25;
/// Glow runs its Gaussian in high-quality mode (FX-PHOTO-GLOW-01).
pub const GLOW_QUALITY: u8 = 4;
/// The Gaussian radius of Soften Portrait is Softness × 3 × 1.25 (FX-PHOTO-SOFTEN-01).
const SOFTEN_RADIUS_FACTOR: f32 = 3.0 * 1.25;
/// The spec gives no quality for Soften Portrait's Gaussian, so it uses Glow's high-quality mode.
const SOFTEN_QUALITY: u8 = GLOW_QUALITY;

/// Glow's screen step (FX-PHOTO-GLOW-01, steps 3-5): the blurred image gets Brightness / Contrast
/// with `plan`, then it is screened over the source, `1 - (1 - dst)(1 - src)`, on colors
/// premultiplied by the source's alpha. The result keeps the source's alpha.
fn glow_screen(src: &[u8], blurred: &[u8], plan: [f32; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len());
    for (s, b) in src
        .as_chunks::<4>()
        .0
        .iter()
        .zip(blurred.as_chunks::<4>().0)
    {
        let a = f32::from(s[3]) / 255.0;
        let lifted = brightness_contrast_color(straight(b), plan);
        let mut px = [0u8; 4];
        for (c, channel) in px.iter_mut().enumerate().take(3) {
            let dst = f32::from(s[c]) / 255.0 * a;
            let glow = lifted[c] * a;
            let screened = 1.0 - (1.0 - dst) * (1.0 - glow);
            *channel = to_u8(if a > 0.0 { screened / a } else { 0.0 });
        }
        px[3] = s[3];
        out.extend_from_slice(&px);
    }
    out
}

/// Glow (FX-PHOTO-GLOW): the image is screened over a blurred copy of itself that has Brightness /
/// Contrast applied. `radius` is 1..=20, and `brightness` and `contrast` are -100..=100 on the
/// Brightness / Contrast scale (the spec's values divided by 100).
pub fn glow_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    radius: f32,
    brightness: f32,
    contrast: f32,
) -> Result<Vec<u8>, String> {
    if !(1.0..=20.0).contains(&radius) {
        return Err(format!("radius must be 1..=20, got {radius}"));
    }
    let plan = brightness_contrast_plan(brightness, contrast)?;
    let blurred = blur_clamped_rgba8(
        src,
        width,
        height,
        radius * GLOW_RADIUS_FACTOR,
        GLOW_QUALITY,
    )?;
    Ok(glow_screen(src, &blurred, plan))
}

/// The Overlay blend (W3C) of `source` over `base`, where the base is the backdrop.
fn overlay(base: f32, source: f32) -> f32 {
    if base <= 0.5 {
        2.0 * base * source
    } else {
        1.0 - 2.0 * (1.0 - base) * (1.0 - source)
    }
}

/// Soften Portrait (FX-PHOTO-SOFTEN): the image is overlaid on a warm monochrome of itself. The
/// source branch is a Gaussian of Softness, with Brightness / Contrast of `lighting` and -`lighting`
/// / 2. `softness` is 0..=10, `lighting` -20..=20 and `warmth` 0..=20. Lighting and Warmth are
/// divided by 100 in the spec, which is applied here. Each pixel keeps its alpha.
pub fn soften_portrait_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    softness: f32,
    lighting: f32,
    warmth: f32,
) -> Result<Vec<u8>, String> {
    if !(0.0..=10.0).contains(&softness) {
        return Err(format!("softness must be 0..=10, got {softness}"));
    }
    if !(-20.0..=20.0).contains(&lighting) {
        return Err(format!("lighting must be -20..=20, got {lighting}"));
    }
    if !(0.0..=20.0).contains(&warmth) {
        return Err(format!("warmth must be 0..=20, got {warmth}"));
    }
    let plan = brightness_contrast_plan(lighting, -lighting / 2.0)?;
    let blurred = blur_clamped_rgba8(
        src,
        width,
        height,
        softness * SOFTEN_RADIUS_FACTOR,
        SOFTEN_QUALITY,
    )?;
    let tint = warmth / 100.0;

    let mut out = Vec::with_capacity(src.len());
    for (s, b) in src
        .as_chunks::<4>()
        .0
        .iter()
        .zip(blurred.as_chunks::<4>().0)
    {
        let [r, g, bl] = straight(s);
        let gray = luma(r, g, bl);
        let warm = [
            (gray * (1.0 + tint)).clamp(0.0, 1.0),
            gray,
            (gray * (1.0 - tint)).clamp(0.0, 1.0),
        ];
        let lifted = brightness_contrast_color(straight(b), plan);
        for (base, source) in warm.into_iter().zip(lifted) {
            out.push(to_u8(overlay(base, source)));
        }
        out.push(s[3]);
    }
    Ok(out)
}

/// The 3×3 Gaussian 1-2-1 / 16 of Sharpen as one weight per tap, `(2 - |dx|)(2 - |dy|)` over 16
/// (FX-PHOTO-SHARPEN-01).
fn sharpen_tap_weight(dx: i32, dy: i32) -> f32 {
    ((2 - dx.abs()) * (2 - dy.abs())) as f32 / 16.0
}

/// Premultiplied channel `c` of the pixel at (x, y), with the coordinates clamped to the image.
fn premultiplied(src: &[u8], width: usize, height: usize, x: isize, y: isize, c: usize) -> f32 {
    let x = x.clamp(0, width as isize - 1) as usize;
    let y = y.clamp(0, height as isize - 1) as usize;
    let px = &src[(y * width + x) * 4..][..4];
    f32::from(px[c]) / 255.0 * (f32::from(px[3]) / 255.0)
}

/// Sharpen (FX-PHOTO-SHARPEN): each premultiplied color channel moves away from its 3×3 blur by
/// `amount` when the difference is at least `threshold`, and is kept otherwise. `amount` is 0..=10
/// and `threshold` 0..=1, on the spec's scale. Alpha is kept. Taps outside the image take the
/// nearest edge pixel.
pub fn sharpen_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    amount: f32,
    threshold: f32,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    if !(0.0..=10.0).contains(&amount) {
        return Err(format!("amount must be 0..=10, got {amount}"));
    }
    if !(0.0..=1.0).contains(&threshold) {
        return Err(format!("threshold must be 0..=1, got {threshold}"));
    }
    let mut out = vec![0u8; src.len()];
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) * 4;
            let alpha = f32::from(src[i + 3]) / 255.0;
            for c in 0..3 {
                let mut blur = 0.0;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let (tx, ty) = (x as isize + dx as isize, y as isize + dy as isize);
                        blur += sharpen_tap_weight(dx, dy)
                            * premultiplied(src, width, height, tx, ty, c);
                    }
                }
                let input = premultiplied(src, width, height, x as isize, y as isize, c);
                let difference = input - blur;
                let sharpened = if difference.abs() < threshold {
                    input
                } else {
                    input + amount * difference
                };
                let clamped = sharpened.clamp(0.0, 1.0);
                out[i + c] = to_u8(if alpha > 0.0 { clamped / alpha } else { 0.0 });
            }
            out[i + 3] = src[i + 3];
        }
    }
    Ok(out)
}

/// The threshold ratio of Red Eye Removal is `1.9 - 0.1 · strength` (FX-PHOTO-REDEYE-01).
const RED_EYE_BASE_RATIO: f32 = 1.9;
const RED_EYE_RATIO_STEP: f32 = 0.1;
/// Red Eye Removal only corrects a red above this level, on 0..=1 (FX-PHOTO-REDEYE-01).
const RED_EYE_MIN_RED: f32 = 0.25;

/// An inclusive pixel rectangle.
#[derive(Clone, Copy)]
struct Area {
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
}

/// Groups the selected pixels (coverage above zero) into clusters. Pixels that touch, including at
/// a corner, share a cluster, which is the union of the touching selection rectangles. Returns the
/// cluster label of every pixel (`usize::MAX` when unselected) and each cluster's bounding area.
fn selection_clusters(coverage: &[u8], width: usize, height: usize) -> (Vec<usize>, Vec<Area>) {
    let mut labels = vec![usize::MAX; width * height];
    let mut areas = Vec::new();
    let mut stack = Vec::new();
    for start in 0..width * height {
        if coverage[start] == 0 || labels[start] != usize::MAX {
            continue;
        }
        let id = areas.len();
        let (sx, sy) = (start % width, start / width);
        let mut area = Area {
            x0: sx,
            y0: sy,
            x1: sx,
            y1: sy,
        };
        labels[start] = id;
        stack.push(start);
        while let Some(p) = stack.pop() {
            let (x, y) = (p % width, p / width);
            area.x0 = area.x0.min(x);
            area.y0 = area.y0.min(y);
            area.x1 = area.x1.max(x);
            area.y1 = area.y1.max(y);
            for ny in y.saturating_sub(1)..=(y + 1).min(height - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                    let q = ny * width + nx;
                    if coverage[q] != 0 && labels[q] == usize::MAX {
                        labels[q] = id;
                        stack.push(q);
                    }
                }
            }
        }
        areas.push(area);
    }
    (labels, areas)
}

/// Red Eye Removal (FX-PHOTO-REDEYE): the selection is grouped into clusters, and within each
/// cluster's area a pixel is red-eye when `R > ratio · max(G, B)` and `R > 0.25`. Its red moves
/// toward `(G + B) / 2` by its redness weight times `strength / 5`. `strength` is 1..=5. `coverage`
/// is the selection, one byte per pixel (255 for the whole image), and each pixel's correction is
/// mixed in by its coverage. G, B and alpha are kept.
pub fn red_eye_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    coverage: &[u8],
    strength: f32,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    if !(1.0..=5.0).contains(&strength) {
        return Err(format!("strength must be 1..=5, got {strength}"));
    }
    if coverage.len() != width * height {
        return Err(format!(
            "coverage must have {} bytes, got {}",
            width * height,
            coverage.len()
        ));
    }
    let ratio = RED_EYE_BASE_RATIO - RED_EYE_RATIO_STEP * strength;
    let correction = strength / 5.0;
    let (labels, areas) = selection_clusters(coverage, width, height);
    let mut out = src.to_vec();
    for (id, area) in areas.iter().enumerate() {
        for y in area.y0..=area.y1 {
            for x in area.x0..=area.x1 {
                let p = y * width + x;
                if labels[p] != id {
                    continue;
                }
                let i = p * 4;
                let [r, g, b] = straight(&src[i..i + 4]);
                let green_blue = g.max(b);
                if r <= RED_EYE_MIN_RED || r <= ratio * green_blue {
                    continue;
                }
                let redness = if green_blue > 0.0 {
                    (r / green_blue - ratio).clamp(0.0, 1.0)
                } else {
                    1.0
                };
                let corrected = r + ((g + b) / 2.0 - r) * (redness * correction);
                let effected = u32::from(to_u8(corrected));
                let original = u32::from(src[i]);
                let c = u32::from(coverage[p]);
                out[i] = ((original * (255 - c) + effected * c + 127) / 255) as u8;
            }
        }
    }
    Ok(out)
}

/// Straighten's Angle is clamped to ±45 degrees (FX-PHOTO-STRAIGHTEN-01).
const STRAIGHTEN_MAX_ANGLE: f32 = 45.0;

/// The inverse transform of Straighten (FX-PHOTO-STRAIGHTEN-01) for a `width` x `height` image. The
/// layer turns by `-angle` about its center and is scaled up by `s`, which is just enough that no
/// transparent corners appear. Returns the coefficients `a, b, c, d, e, f` of
/// `transform::Spec::inverse`, rounded to f32 so the WGSL twin reads the same numbers.
pub fn straighten_matrix(width: usize, height: usize, angle: f32) -> Result<[f32; 6], String> {
    if width == 0 || height == 0 {
        return Err("image sizes must be positive".into());
    }
    if !(-STRAIGHTEN_MAX_ANGLE..=STRAIGHTEN_MAX_ANGLE).contains(&angle) {
        return Err(format!("angle must be -45..=45, got {angle}"));
    }
    let (w, h) = (width as f64, height as f64);
    let (sin, cos) = (-f64::from(angle)).to_radians().sin_cos();
    let (sin_abs, cos_abs) = (sin.abs(), cos.abs());
    let scale = ((w * cos_abs + h * sin_abs) / w).max((w * sin_abs + h * cos_abs) / h);
    let (a, b, c, d) = (cos / scale, -sin / scale, sin / scale, cos / scale);
    let (cx, cy) = (w / 2.0, h / 2.0);
    let e = cx - (a * cx + c * cy);
    let f = cy - (b * cx + d * cy);
    Ok([a, b, c, d, e, f].map(|value| value as f32))
}

/// Straighten (FX-PHOTO-STRAIGHTEN) of a straight-alpha RGBA8 image, resampled in linear light
/// through `straighten_matrix`. `sampling` is 0 for Bicubic, 1 for Bilinear and 2 for Nearest
/// Neighbor, the order of the dialog.
pub fn straighten_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    angle: f32,
    sampling: u8,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    let sampling = match sampling {
        0 => Sampling::Cubic,
        1 => Sampling::Linear,
        2 => Sampling::Nearest,
        other => return Err(format!("sampling must be 0..=2, got {other}")),
    };
    let inverse = straighten_matrix(width, height, angle)?.map(f64::from);
    transform_rgba8(&Spec {
        src,
        src_width: width,
        src_height: height,
        dst_width: width,
        dst_height: height,
        inverse,
        sampling,
        linear_light: true,
    })
}

/// The Vignette plan (FX-PHOTO-VIGNETTE-01) for a `width` x `height` region: `[cx, cy, k]`. `(cx, cy)`
/// is the center in pixels, from the Center's -1..=1 coordinates, and `k` scales a squared distance
/// so that `d = |p - c|² · k`. The radius is 0.1..=4, as on the spec's scale.
pub fn vignette_plan(
    width: usize,
    height: usize,
    center_x: f32,
    center_y: f32,
    radius: f32,
) -> Result<Vec<f32>, String> {
    if width == 0 || height == 0 {
        return Err("image sizes must be positive".into());
    }
    if !(-1.0..=1.0).contains(&center_x) || !(-1.0..=1.0).contains(&center_y) {
        return Err(format!(
            "center must be -1..=1, got ({center_x}, {center_y})"
        ));
    }
    if !(0.1..=4.0).contains(&radius) {
        return Err(format!("radius must be 0.1..=4, got {radius}"));
    }
    let (w, h) = (width as f32, height as f32);
    let r_max = 0.5 * w.max(h) * radius;
    let k = std::f32::consts::PI / (8.0 * r_max * r_max);
    Ok(vec![
        w * (1.0 + center_x) / 2.0,
        h * (1.0 + center_y) / 2.0,
        k,
    ])
}

/// The Vignette multiplier at scaled squared distance `d` (FX-PHOTO-VIGNETTE-01): `1 - strength`
/// outside the cosine lobe, and `(1 - strength) + strength · cos⁴ d` inside it.
fn vignette_factor(d: f32, strength: f32) -> f32 {
    if d >= std::f32::consts::PI {
        return 1.0 - strength;
    }
    let cos = d.cos();
    if cos <= 0.0 {
        return 1.0 - strength;
    }
    let cos2 = cos * cos;
    (1.0 - strength) + strength * (cos2 * cos2)
}

/// Vignette (FX-PHOTO-VIGNETTE) of a straight-alpha RGBA8 region. Each color is darkened in linear
/// light by its pixel's factor (`vignette_factor`), and alpha is kept. `strength` is 0..=1.
pub fn vignette_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    center_x: f32,
    center_y: f32,
    radius: f32,
    strength: f32,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    if !(0.0..=1.0).contains(&strength) {
        return Err(format!("strength must be 0..=1, got {strength}"));
    }
    let plan = vignette_plan(width, height, center_x, center_y, radius)?;
    let (cx, cy, k) = (plan[0], plan[1], plan[2]);
    let mut out = src.to_vec();
    for y in 0..height {
        for x in 0..width {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let factor = vignette_factor((dx * dx + dy * dy) * k, strength);
            let i = (y * width + x) * 4;
            for c in 0..3 {
                let linear = to_linear(f32::from(src[i + c]) / 255.0);
                out[i + c] = to_u8(to_srgb((linear * factor).clamp(0.0, 1.0)));
            }
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

    #[test]
    fn glow_screen_brightens_a_flat_gray() {
        // Screening 0.502 over itself gives about 0.752, which is about 192.
        let src = flat(1, 1, [128, 128, 128, 255]);
        let plan = brightness_contrast_plan(0.0, 0.0).unwrap();
        let out = glow_screen(&src, &src, plan);
        assert!((i32::from(out[0]) - 192).abs() <= 1);
        assert_eq!(out[3], 255);
    }

    #[test]
    fn glow_keeps_a_flat_black_and_alpha() {
        let out = glow_rgba8(&flat(4, 4, [0, 0, 0, 128]), 4, 4, 3.0, 0.0, 0.0).unwrap();
        assert!(out
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| *px == [0, 0, 0, 128]));
    }

    #[test]
    fn glow_rejects_bad_ranges() {
        let src = flat(2, 2, [0; 4]);
        assert!(glow_rgba8(&src, 2, 2, 0.5, 0.0, 0.0).is_err());
        assert!(glow_rgba8(&src, 2, 2, 21.0, 0.0, 0.0).is_err());
        assert!(glow_rgba8(&src, 2, 2, 6.0, 101.0, 0.0).is_err());
    }

    #[test]
    fn soften_keeps_flat_white_and_black() {
        let white = soften_portrait_rgba8(&flat(3, 3, [255; 4]), 3, 3, 5.0, 0.0, 20.0).unwrap();
        assert!(white.as_chunks::<4>().0.iter().all(|px| *px == [255; 4]));
        let black =
            soften_portrait_rgba8(&flat(3, 3, [0, 0, 0, 255]), 3, 3, 5.0, 0.0, 20.0).unwrap();
        assert!(black
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| *px == [0, 0, 0, 255]));
    }

    #[test]
    fn soften_warms_a_gray_toward_red() {
        // At Warmth 20 the red channel is brightest and the blue darkest of the warm monochrome.
        let out =
            soften_portrait_rgba8(&flat(4, 4, [128, 128, 128, 255]), 4, 4, 5.0, 0.0, 20.0).unwrap();
        let [r, g, b, a] = [out[0], out[1], out[2], out[3]];
        assert!(r > g && g > b, "expected warm tint, got {r} {g} {b}");
        assert_eq!(a, 255);
    }

    #[test]
    fn soften_with_no_warmth_or_lighting_overlays_gray_on_itself() {
        // Overlay of 0.502 over itself is 2 · 0.502², about 0.504, which is 129 after rounding.
        let out =
            soften_portrait_rgba8(&flat(3, 3, [128, 128, 128, 255]), 3, 3, 0.0, 0.0, 0.0).unwrap();
        assert!(out
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| (i32::from(px[0]) - 129).abs() <= 1));
    }

    #[test]
    fn soften_keeps_transparent_alpha() {
        let out =
            soften_portrait_rgba8(&flat(2, 2, [90, 90, 90, 0]), 2, 2, 5.0, 0.0, 10.0).unwrap();
        assert!(out.as_chunks::<4>().0.iter().all(|px| px[3] == 0));
    }

    #[test]
    fn soften_rejects_bad_ranges() {
        let src = flat(2, 2, [0; 4]);
        assert!(soften_portrait_rgba8(&src, 2, 2, 10.5, 0.0, 10.0).is_err());
        assert!(soften_portrait_rgba8(&src, 2, 2, 5.0, 21.0, 10.0).is_err());
        assert!(soften_portrait_rgba8(&src, 2, 2, 5.0, 0.0, 21.0).is_err());
    }

    /// A 3×3 gray with a brighter center, where the center's blur is 125 of 255.
    fn bright_center() -> Vec<u8> {
        let mut src = flat(3, 3, [100, 100, 100, 255]);
        src[4 * 4..4 * 4 + 3].copy_from_slice(&[200, 200, 200]);
        src
    }

    #[test]
    fn sharpen_leaves_a_flat_image_unchanged() {
        let src = flat(4, 4, [128, 60, 200, 255]);
        assert_eq!(sharpen_rgba8(&src, 4, 4, 2.0, 0.0).unwrap(), src);
    }

    #[test]
    fn sharpen_pushes_a_bright_center_outward_and_clamps() {
        // The center's difference is 75 / 255, so Amount 2 pushes 200 past 255.
        let out = sharpen_rgba8(&bright_center(), 3, 3, 2.0, 0.0).unwrap();
        assert_eq!(&out[4 * 4..4 * 4 + 4], &[255, 255, 255, 255]);
    }

    #[test]
    fn sharpen_skips_differences_below_the_threshold() {
        // 75 / 255 = 0.294 is below a threshold of 0.5, so the center stays put.
        let src = bright_center();
        assert_eq!(sharpen_rgba8(&src, 3, 3, 2.0, 0.5).unwrap(), src);
    }

    #[test]
    fn sharpen_keeps_alpha_and_transparent_pixels() {
        let out = sharpen_rgba8(&flat(3, 3, [90, 90, 90, 0]), 3, 3, 10.0, 0.0).unwrap();
        assert!(out.as_chunks::<4>().0.iter().all(|px| *px == [0, 0, 0, 0]));
        let mut src = bright_center();
        src[4 * 4 + 3] = 128;
        let out = sharpen_rgba8(&src, 3, 3, 1.0, 0.0).unwrap();
        assert_eq!(out[4 * 4 + 3], 128);
    }

    #[test]
    fn sharpen_rejects_bad_ranges() {
        let src = flat(2, 2, [0; 4]);
        assert!(sharpen_rgba8(&src, 2, 2, 10.5, 0.0).is_err());
        assert!(sharpen_rgba8(&src, 2, 2, 2.0, 1.5).is_err());
        assert!(sharpen_rgba8(&src[..7], 2, 2, 2.0, 0.0).is_err());
    }

    #[test]
    fn red_eye_corrects_a_red_pixel_toward_its_green_blue_mean() {
        // Strength 3: ratio 1.6, and the redness saturates at 1, so R moves 0.6 of the way.
        let src = flat(1, 1, [200, 40, 40, 255]);
        let out = red_eye_rgba8(&src, 1, 1, &[255], 3.0).unwrap();
        assert!((i32::from(out[0]) - 104).abs() <= 1, "red {}", out[0]);
        assert_eq!(&out[1..], &[40, 40, 255]);
    }

    #[test]
    fn red_eye_ignores_pixels_that_are_not_red_enough() {
        let gray = flat(1, 1, [120, 120, 120, 255]);
        assert_eq!(red_eye_rgba8(&gray, 1, 1, &[255], 5.0).unwrap(), gray);
        let dark_red = flat(1, 1, [60, 10, 10, 255]);
        assert_eq!(
            red_eye_rgba8(&dark_red, 1, 1, &[255], 5.0).unwrap(),
            dark_red
        );
    }

    #[test]
    fn red_eye_leaves_unselected_pixels_and_mixes_partial_coverage() {
        let src = flat(2, 1, [200, 40, 40, 255]);
        let out = red_eye_rgba8(&src, 2, 1, &[0, 128], 3.0).unwrap();
        assert_eq!(&out[..4], &[200, 40, 40, 255]);
        // Half coverage moves the red halfway between 200 and the corrected 104.
        assert!((i32::from(out[4]) - 152).abs() <= 1, "red {}", out[4]);
    }

    #[test]
    fn red_eye_rejects_bad_input() {
        let src = flat(2, 2, [0; 4]);
        assert!(red_eye_rgba8(&src, 2, 2, &[255; 4], 0.5).is_err());
        assert!(red_eye_rgba8(&src, 2, 2, &[255; 4], 6.0).is_err());
        assert!(red_eye_rgba8(&src, 2, 2, &[255; 3], 3.0).is_err());
    }

    #[test]
    fn selection_clusters_join_pixels_that_touch_at_a_corner() {
        let mut coverage = [0u8; 9];
        coverage[0] = 255;
        coverage[4] = 255;
        let (_, areas) = selection_clusters(&coverage, 3, 3);
        assert_eq!(areas.len(), 1);
        assert_eq!(
            (areas[0].x0, areas[0].y0, areas[0].x1, areas[0].y1),
            (0, 0, 1, 1)
        );
        coverage[4] = 0;
        coverage[2] = 255;
        let (_, areas) = selection_clusters(&coverage, 3, 3);
        assert_eq!(areas.len(), 2);
    }

    fn ramp(width: usize, height: usize) -> Vec<u8> {
        (0..width * height)
            .flat_map(|i| {
                [
                    (i * 37 % 256) as u8,
                    (i * 53 % 256) as u8,
                    (i * 11 % 256) as u8,
                    255,
                ]
            })
            .collect()
    }

    #[test]
    fn straighten_matrix_is_the_identity_at_zero_degrees() {
        assert_eq!(
            straighten_matrix(40, 24, 0.0).unwrap(),
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        );
    }

    #[test]
    fn straighten_scales_so_the_destination_corners_stay_inside_the_source() {
        let (width, height) = (40usize, 24usize);
        for angle in [-45.0f32, -30.0, 12.5, 45.0] {
            let [a, b, c, d, e, f] = straighten_matrix(width, height, angle)
                .unwrap()
                .map(f64::from);
            for (x, y) in [(0.0, 0.0), (40.0, 0.0), (0.0, 24.0), (40.0, 24.0)] {
                let sx = a * x + c * y + e;
                let sy = b * x + d * y + f;
                assert!((-1e-4..=40.0 + 1e-4).contains(&sx), "{angle}: x {sx}");
                assert!((-1e-4..=24.0 + 1e-4).contains(&sy), "{angle}: y {sy}");
            }
        }
    }

    #[test]
    fn straighten_at_zero_degrees_reproduces_the_image_for_every_sampling() {
        let src = ramp(7, 5);
        for sampling in 0..=2 {
            assert_eq!(straighten_rgba8(&src, 7, 5, 0.0, sampling).unwrap(), src);
        }
    }

    #[test]
    fn straighten_keeps_a_uniform_color_opaque_near_the_center() {
        let src = [40u8, 120, 200, 255].repeat(16 * 16);
        for sampling in 0..=2 {
            let out = straighten_rgba8(&src, 16, 16, 30.0, sampling).unwrap();
            for y in 6..10 {
                for x in 6..10 {
                    let px = &out[(y * 16 + x) * 4..][..4];
                    assert_eq!(px[3], 255, "sampling {sampling} at ({x}, {y})");
                    assert!((i32::from(px[0]) - 40).abs() <= 1, "sampling {sampling}");
                    assert!((i32::from(px[2]) - 200).abs() <= 1, "sampling {sampling}");
                }
            }
        }
    }

    #[test]
    fn straighten_rejects_bad_angles_samplings_and_buffers() {
        let src = ramp(4, 4);
        assert!(straighten_rgba8(&src, 4, 4, 46.0, 0).is_err());
        assert!(straighten_rgba8(&src, 4, 4, -45.5, 0).is_err());
        assert!(straighten_rgba8(&src, 4, 4, 10.0, 3).is_err());
        assert!(straighten_rgba8(&src[..8], 4, 4, 10.0, 0).is_err());
        assert!(straighten_matrix(0, 4, 10.0).is_err());
    }

    #[test]
    fn vignette_plan_puts_the_center_in_pixels_and_scales_the_falloff() {
        // Radius 0.5 on a 40 x 24 region: Rmax = 10, so k = π / 800.
        let plan = vignette_plan(40, 24, 0.0, 0.0, 0.5).unwrap();
        assert_eq!(plan[..2], [20.0, 12.0]);
        assert!((plan[2] - std::f32::consts::PI / 800.0).abs() < 1e-9);
        assert_eq!(
            vignette_plan(40, 24, -1.0, 1.0, 0.5).unwrap()[..2],
            [0.0, 24.0]
        );
    }

    #[test]
    fn vignette_plan_rejects_bad_ranges() {
        assert!(vignette_plan(40, 24, 1.5, 0.0, 0.5).is_err());
        assert!(vignette_plan(40, 24, 0.0, -1.5, 0.5).is_err());
        assert!(vignette_plan(40, 24, 0.0, 0.0, 0.05).is_err());
        assert!(vignette_plan(40, 24, 0.0, 0.0, 4.5).is_err());
        assert!(vignette_plan(0, 24, 0.0, 0.0, 0.5).is_err());
    }

    #[test]
    fn vignette_with_zero_strength_is_the_identity() {
        let src = ramp(9, 6);
        assert_eq!(
            vignette_rgba8(&src, 9, 6, 0.3, -0.2, 1.0, 0.0).unwrap(),
            src
        );
    }

    #[test]
    fn vignette_darkens_the_corners_and_keeps_the_center() {
        let src = flat(40, 24, [255, 255, 255, 255]);
        let out = vignette_rgba8(&src, 40, 24, 0.0, 0.0, 0.5, 1.0).unwrap();
        // The center pixel is at distance about 0, so its factor is 1.
        assert_eq!(&out[(12 * 40 + 20) * 4..][..4], &[255, 255, 255, 255]);
        // The corner lies beyond the first quarter cosine lobe, so Strength 1 blacks it out.
        assert_eq!(&out[..4], &[0, 0, 0, 255]);
    }

    #[test]
    fn vignette_darkens_in_linear_light_and_keeps_alpha() {
        let src = flat(40, 24, [128, 128, 128, 77]);
        let out = vignette_rgba8(&src, 40, 24, 0.0, 0.0, 0.5, 0.5).unwrap();
        // The far corner has factor 0.5, so 128 (linear 0.216) becomes linear 0.108, about 92.
        assert!((i32::from(out[0]) - 92).abs() <= 1, "red {}", out[0]);
        assert!(out.as_chunks::<4>().0.iter().all(|px| px[3] == 77));
    }

    #[test]
    fn vignette_rejects_bad_strength_and_buffers() {
        let src = ramp(4, 4);
        assert!(vignette_rgba8(&src, 4, 4, 0.0, 0.0, 0.5, 1.5).is_err());
        assert!(vignette_rgba8(&src, 4, 4, 0.0, 0.0, 0.5, -0.1).is_err());
        assert!(vignette_rgba8(&src[..8], 4, 4, 0.0, 0.0, 0.5, 1.0).is_err());
    }
}
