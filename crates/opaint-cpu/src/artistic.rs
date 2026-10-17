//! Artistic effects (FX-ART-INK, FX-ART-OIL, FX-ART-PENCIL). Every public function takes and returns
//! straight-alpha RGBA8. The WGSL twins in `packages/effects` mirror each stage in the same order,
//! so the GPU result stays within ±1. Glow (FX-PHOTO-GLOW), which Ink Sketch uses, lives in `photo`.

use crate::adjust::brightness_contrast_plan;
use crate::blur::{blur_rgba8, mirror_index};
use crate::photo::glow_rgba8;
use crate::srgb::{to_linear, to_srgb};

/// The Glow radius that Ink Sketch uses (FX-ART-INK-03).
const INK_GLOW_RADIUS: f32 = 6.0;
/// Pencil Sketch's Gaussian quality (FX-ART-PENCIL-03).
const PENCIL_QUALITY: u8 = 3;
/// The ink branch's 5x5 kernel reaches two pixels in each direction (FX-ART-INK-03).
const INK_REACH: isize = 2;
const INK_CENTER_TAP: f32 = 30.0;
const INK_EDGE_TAP: f32 = -5.0;
const INK_OTHER_TAP: f32 = -1.0;
/// Oil Painting's granularity sets the bin count as `int(granularity * 256)`, clamped to this range.
const OIL_MIN_BINS: usize = 4;
const OIL_MAX_BINS: usize = 256;

/// Luma (ADJ-COMMON-06), the same weights as the rest of the document-space kernels.
pub(crate) fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.299 * r + 0.587 * g + 0.114 * b
}

/// Converts a value on 0..=1 to 8 bits, rounded half up, with clamping.
pub(crate) fn to_u8(v: f32) -> u8 {
    (255.0 * v.clamp(0.0, 1.0) + 0.5).floor() as u8
}

/// The straight color of a pixel on 0..=1.
pub(crate) fn straight(px: &[u8]) -> [f32; 3] {
    [
        f32::from(px[0]) / 255.0,
        f32::from(px[1]) / 255.0,
        f32::from(px[2]) / 255.0,
    ]
}

/// Brightness / Contrast of one straight color (ADJ-BC-01) on 0..=1 channels, with the plan of
/// `brightness_contrast_plan`. Returns the three channels.
pub(crate) fn brightness_contrast_color(rgb: [f32; 3], plan: [f32; 3]) -> [f32; 3] {
    let [bright, mul, div] = plan;
    let y = luma(rgb[0], rgb[1], rgb[2]);
    if div == 0.0 {
        let gray = if y + bright >= 0.5 { 1.0 } else { 0.0 };
        return [gray; 3];
    }
    let (pre, post) = if div == 100.0 {
        (0.0, bright)
    } else {
        (bright, 0.0)
    };
    let shift = ((y - 0.5 + pre) * mul / div) + (0.5 - y + post);
    rgb.map(|c| (c + shift).clamp(0.0, 1.0))
}

pub(crate) fn check_image(src: &[u8], width: usize, height: usize) -> Result<(), String> {
    if src.len() == width * height * 4 {
        Ok(())
    } else {
        Err(format!("source must be {width}x{height} RGBA8"))
    }
}

/// The ink branch's tap at offset `(dx, dy)`: the center is +30, the middle of the top row is -5
/// and every other tap is -1, so the kernel sums to +2 (FX-ART-INK-03).
fn ink_tap(dx: isize, dy: isize) -> f32 {
    if dx == 0 && dy == 0 {
        INK_CENTER_TAP
    } else if dx == 0 && dy == -INK_REACH {
        INK_EDGE_TAP
    } else {
        INK_OTHER_TAP
    }
}

/// The ink branch of Ink Sketch (FX-ART-INK-03): the 5x5 high-pass on the straight colors with a
/// mirror border and clamping to 0..=1, then a threshold on luma. Alpha 0 stays transparent. Other
/// pixels become white above `threshold` and black at or below it, with their alpha kept.
fn ink_lines(src: &[u8], width: usize, height: usize, threshold: f32) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let px = &src[(y * width + x) * 4..][..4];
            if px[3] == 0 {
                out.extend_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            let mut rgb = [0.0f32; 3];
            for (c, value) in rgb.iter_mut().enumerate() {
                let mut acc = 0.0f32;
                for dy in -INK_REACH..=INK_REACH {
                    for dx in -INK_REACH..=INK_REACH {
                        let sx = mirror_index(x as isize + dx, width);
                        let sy = mirror_index(y as isize + dy, height);
                        let v = src[(sy * width + sx) * 4 + c];
                        acc += ink_tap(dx, dy) * (f32::from(v) / 255.0);
                    }
                }
                *value = acc.clamp(0.0, 1.0);
            }
            let ink = if luma(rgb[0], rgb[1], rgb[2]) > threshold {
                255
            } else {
                0
            };
            out.extend_from_slice(&[ink, ink, ink, px[3]]);
        }
    }
    out
}

/// The final step of Ink Sketch (FX-ART-INK-03, step 3): the ink is blended over the glow with the
/// Darken mode (per-channel minimum). The ink's alpha is its share of the blend, so an opaque ink
/// pixel takes the minimum and a transparent one leaves the glow. The result keeps the glow's alpha.
fn ink_darken(glow: &[u8], ink: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(glow.len());
    for (g, k) in glow.as_chunks::<4>().0.iter().zip(ink.as_chunks::<4>().0) {
        let share = f32::from(k[3]) / 255.0;
        let mut px = [0u8; 4];
        for (c, channel) in px.iter_mut().enumerate().take(3) {
            let base = f32::from(g[c]) / 255.0;
            let top = f32::from(k[c]) / 255.0;
            *channel = to_u8(base * (1.0 - share) + share * base.min(top));
        }
        px[3] = g[3];
        out.extend_from_slice(&px);
    }
    out
}

/// Ink Sketch (FX-ART-INK): an ink outline over a glow of the colors. `ink_outline` is the Ink
/// Outline value (0-99, used as /100) and `coloring` the Coloring value (0-100). The effect runs in
/// document space, not linear light. Returns the new pixels.
pub fn ink_sketch_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    ink_outline: f32,
    coloring: f32,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    if !(0.0..=99.0).contains(&ink_outline) {
        return Err(format!("ink outline must be 0..=99, got {ink_outline}"));
    }
    if !(0.0..=100.0).contains(&coloring) {
        return Err(format!("coloring must be 0..=100, got {coloring}"));
    }
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }
    // Glow's brightness and contrast are (0.5 - Coloring / 100) * 2, on the -1..1 scale that is
    // -100..100 in the Brightness / Contrast units.
    let shift = (50.0 - coloring) * 2.0;
    let glow = glow_rgba8(src, width, height, INK_GLOW_RADIUS, shift, shift)?;
    let ink = ink_lines(src, width, height, ink_outline / 100.0);
    Ok(ink_darken(&glow, &ink))
}

/// The offsets of Oil Painting's kernel (FX-ART-OIL-03, step 1), in row-major order: a square of
/// side 2r + 1, or the disc `dx² + dy² <= r² + r / 2`.
fn oil_offsets(radius: isize, square: bool) -> Vec<(isize, isize)> {
    let limit = (radius * radius) as f32 + radius as f32 * 0.5;
    let mut offsets = Vec::new();
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            if square || ((dx * dx + dy * dy) as f32) <= limit {
                offsets.push((dx, dy));
            }
        }
    }
    offsets
}

/// Oil Painting (FX-ART-OIL): a mode filter over a kernel of radius `brush_size`, with the
/// histogram of `granularity` bins over the linear luma. The most populated bin (the lowest on a
/// tie) gives the average of its premultiplied colors. A radius of 0 returns the input unchanged.
/// `granularity` is 0.01..=1 and `brush_size` is 0..=50.
pub fn oil_painting_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    brush_size: u32,
    granularity: f32,
    square: bool,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    if !(0.01..=1.0).contains(&granularity) {
        return Err(format!("granularity must be 0.01..=1, got {granularity}"));
    }
    if brush_size > 50 {
        return Err(format!("brush size must be 0..=50, got {brush_size}"));
    }
    if brush_size == 0 || width == 0 || height == 0 {
        return Ok(src.to_vec());
    }
    let bins = ((granularity * 256.0).floor() as usize).clamp(OIL_MIN_BINS, OIL_MAX_BINS);
    let offsets = oil_offsets(brush_size as isize, square);

    // Linear light, straight at the boundary and premultiplied inside.
    let planes: Vec<[f32; 4]> = src
        .as_chunks::<4>()
        .0
        .iter()
        .map(|px| {
            let a = f32::from(px[3]) / 255.0;
            let lift = |v: u8| to_linear(f32::from(v) / 255.0) * a;
            [lift(px[0]), lift(px[1]), lift(px[2]), a]
        })
        .collect();
    let bin_of: Vec<usize> = planes
        .iter()
        .map(|p| {
            let y = luma(p[0], p[1], p[2]).clamp(0.0, 1.0);
            (y * (bins - 1) as f32).floor() as usize
        })
        .collect();

    let mut out = Vec::with_capacity(src.len());
    let mut counts = vec![0u32; bins];
    let mut sums = vec![[0.0f32; 4]; bins];
    for y in 0..height {
        for x in 0..width {
            counts.fill(0);
            sums.fill([0.0; 4]);
            for &(dx, dy) in &offsets {
                let sx = (x as isize + dx).clamp(0, width as isize - 1) as usize;
                let sy = (y as isize + dy).clamp(0, height as isize - 1) as usize;
                let index = sy * width + sx;
                let bin = bin_of[index];
                counts[bin] += 1;
                for (sum, value) in sums[bin].iter_mut().zip(planes[index]) {
                    *sum += value;
                }
            }
            let mut best = 0;
            for bin in 1..bins {
                if counts[bin] > counts[best] {
                    best = bin;
                }
            }
            let n = counts[best] as f32;
            let avg = sums[best].map(|v| v / n);
            let a = avg[3].clamp(0.0, 1.0);
            for &c in &avg[..3] {
                let straight = if a > 0.0 {
                    (c / a).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                out.push(to_u8(to_srgb(straight)));
            }
            out.push(to_u8(a));
        }
    }
    Ok(out)
}

/// Pencil Sketch (FX-ART-PENCIL): a color dodge of the grayscale source by the inverted, blurred
/// and contrast-adjusted source. `tip_size` is 1..=20 and sets the blur radius (1.5 × tip size);
/// `range` is -20..=20 and sets the Brightness / Contrast. The output is gray, and the alpha is kept.
pub fn pencil_sketch_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    tip_size: f32,
    range: f32,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    if !(1.0..=20.0).contains(&tip_size) {
        return Err(format!("tip size must be 1..=20, got {tip_size}"));
    }
    if !(-20.0..=20.0).contains(&range) {
        return Err(format!("range must be -20..=20, got {range}"));
    }
    let blurred = blur_rgba8(src, width, height, 1.5 * tip_size, 0.0, PENCIL_QUALITY)?;
    // Brightness = Range / 100 + 0.01 and Contrast = -(Range / 100 + 0.01), on the -100..100 scale.
    let shift = range + 1.0;
    let plan = brightness_contrast_plan(shift, -shift)?;

    let mut out = Vec::with_capacity(src.len());
    for (s, b) in src
        .as_chunks::<4>()
        .0
        .iter()
        .zip(blurred.as_chunks::<4>().0)
    {
        let base = luma(
            f32::from(s[0]) / 255.0,
            f32::from(s[1]) / 255.0,
            f32::from(s[2]) / 255.0,
        );
        let adjusted = brightness_contrast_color(straight(b), plan);
        let top = luma(1.0 - adjusted[0], 1.0 - adjusted[1], 1.0 - adjusted[2]);
        let dodge = if top >= 1.0 {
            1.0
        } else {
            (base / (1.0 - top)).min(1.0)
        };
        let gray = to_u8(dodge);
        out.extend_from_slice(&[gray, gray, gray, s[3]]);
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
    fn ink_kernel_sums_to_two() {
        let total: f32 = (-INK_REACH..=INK_REACH)
            .flat_map(|dy| (-INK_REACH..=INK_REACH).map(move |dx| ink_tap(dx, dy)))
            .sum();
        assert_eq!(total, 2.0);
        assert_eq!(ink_tap(0, -2), INK_EDGE_TAP);
        assert_eq!(ink_tap(0, 2), INK_OTHER_TAP);
    }

    #[test]
    fn ink_lines_threshold_a_flat_image() {
        // A flat gray of 0.2 convolves to 0.4 (dark) and one of 0.3 to 0.6 (light).
        let dark = ink_lines(&flat(3, 3, [51, 51, 51, 255]), 3, 3, 0.5);
        assert!(
            dark.as_chunks::<4>()
                .0
                .iter()
                .all(|px| *px == [0, 0, 0, 255])
        );
        let light = ink_lines(&flat(3, 3, [77, 77, 77, 255]), 3, 3, 0.5);
        assert!(
            light
                .as_chunks::<4>()
                .0
                .iter()
                .all(|px| *px == [255, 255, 255, 255])
        );
    }

    #[test]
    fn ink_lines_keep_transparent_pixels_transparent() {
        let out = ink_lines(&flat(2, 2, [200, 10, 10, 0]), 2, 2, 0.5);
        assert!(out.as_chunks::<4>().0.iter().all(|px| *px == [0, 0, 0, 0]));
    }

    #[test]
    fn ink_sketch_flat_dark_is_black_and_light_is_glow() {
        let dark = ink_sketch_rgba8(&flat(4, 4, [51, 51, 51, 255]), 4, 4, 50.0, 50.0).unwrap();
        assert!(
            dark.as_chunks::<4>()
                .0
                .iter()
                .all(|px| px[..3] == [0, 0, 0] && px[3] == 255)
        );
        // A light flat gray keeps the glow, which screens 0.302 over itself to about 131.
        let light = ink_sketch_rgba8(&flat(4, 4, [77, 77, 77, 255]), 4, 4, 50.0, 50.0).unwrap();
        assert!(
            light
                .as_chunks::<4>()
                .0
                .iter()
                .all(|px| (i32::from(px[0]) - 131).abs() <= 1)
        );
    }

    #[test]
    fn ink_sketch_keeps_transparency_and_checks_ranges() {
        let out = ink_sketch_rgba8(&flat(2, 2, [90, 90, 90, 0]), 2, 2, 50.0, 50.0).unwrap();
        assert!(out.as_chunks::<4>().0.iter().all(|px| px[3] == 0));
        assert!(ink_sketch_rgba8(&flat(2, 2, [0; 4]), 2, 2, 100.0, 50.0).is_err());
        assert!(ink_sketch_rgba8(&flat(2, 2, [0; 4]), 2, 2, 50.0, 101.0).is_err());
    }

    #[test]
    fn oil_radius_zero_passes_through() {
        let src: Vec<u8> = (0..(5 * 4 * 4)).map(|i| (i * 7) as u8).collect();
        let out = oil_painting_rgba8(&src, 5, 4, 0, 0.2, false).unwrap();
        assert_eq!(out, src);
    }

    #[test]
    fn oil_keeps_a_flat_image() {
        let src = flat(6, 5, [60, 120, 200, 255]);
        let out = oil_painting_rgba8(&src, 6, 5, 2, 0.2, false).unwrap();
        assert_eq!(out, src);
    }

    #[test]
    fn oil_removes_a_single_odd_pixel() {
        // The centre pixel is white in a gray field. The 3x3 square's majority is the gray, so the
        // centre takes the gray back.
        let mut src = flat(5, 5, [100, 100, 100, 255]);
        let center = (2 * 5 + 2) * 4;
        src[center..center + 4].copy_from_slice(&[255, 255, 255, 255]);
        let out = oil_painting_rgba8(&src, 5, 5, 1, 0.2, true).unwrap();
        assert_eq!(&out[center..center + 4], &[100, 100, 100, 255]);
    }

    #[test]
    fn oil_rejects_bad_ranges() {
        let src = flat(2, 2, [0; 4]);
        assert!(oil_painting_rgba8(&src, 2, 2, 51, 0.2, false).is_err());
        assert!(oil_painting_rgba8(&src, 2, 2, 3, 0.0, false).is_err());
    }

    #[test]
    fn oil_disc_has_the_bias_of_the_spec() {
        // For r = 1 the disc holds the centre and the four edge neighbours, not the corners.
        let offsets = oil_offsets(1, false);
        assert_eq!(offsets.len(), 5);
        assert_eq!(oil_offsets(1, true).len(), 9);
    }

    #[test]
    fn pencil_flat_white_is_white_and_alpha_is_kept() {
        let out = pencil_sketch_rgba8(&flat(4, 4, [255, 255, 255, 255]), 4, 4, 2.0, 0.0).unwrap();
        assert!(
            out.as_chunks::<4>()
                .0
                .iter()
                .all(|px| *px == [255, 255, 255, 255])
        );
        let transparent =
            pencil_sketch_rgba8(&flat(4, 4, [40, 40, 40, 0]), 4, 4, 2.0, 0.0).unwrap();
        assert!(transparent.as_chunks::<4>().0.iter().all(|px| px[3] == 0));
    }

    #[test]
    fn pencil_flat_mid_gray_goes_nearly_white() {
        // Color dodge of a flat gray by its own inverted, adjusted blur lightens it toward white.
        let out = pencil_sketch_rgba8(&flat(4, 4, [128, 128, 128, 255]), 4, 4, 2.0, 0.0).unwrap();
        assert!(
            out.as_chunks::<4>()
                .0
                .iter()
                .all(|px| px[0] > 240 && px[0] == px[1])
        );
    }

    #[test]
    fn pencil_rejects_bad_ranges() {
        let src = flat(2, 2, [0; 4]);
        assert!(pencil_sketch_rgba8(&src, 2, 2, 0.5, 0.0).is_err());
        assert!(pencil_sketch_rgba8(&src, 2, 2, 2.0, 21.0).is_err());
    }
}
