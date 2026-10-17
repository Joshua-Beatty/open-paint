//! Flip Horizontal and Flip Vertical (FX-OBJ-FLIP): mirrors the selected pixels of an image about
//! the centre line of the image, which the host crops to the selection's bounding box.
//!
//! A mirror is a pure index remap: pixel `(x, y)` takes pixel `(w - 1 - x, y)` (horizontal) or
//! `(x, h - 1 - y)` (vertical). Nothing is resampled. `coverage` is the selection over the image,
//! one byte per pixel (0-255, antialiased edges included); an empty `coverage` selects every pixel.
//! The selection outline is mirrored with the pixels, so the mirrored coverage is the coverage of
//! the new selection.
//!
//! With coverage `c` at a pixel and `m` at its mirror, the output is the pixel with the lift taken
//! out (`c` of its alpha removed; fully lifted pixels become (0, 0, 0, 0)), with the mirrored pixel
//! placed over it by `m`: `lerp(base, mirrored, m / 255)` per straight channel, rounded half up.
//! These are the lift and the drop of Move Selected Pixels, so a fully selected pixel takes its
//! mirror exactly, an unselected pixel that nothing lands on keeps its value, and the area the
//! selection vacates becomes transparent. The WGSL twin in `packages/effects` runs the same integer
//! operations, so both backends match exactly.

use crate::artistic::check_image;

fn check_coverage(coverage: &[u8], width: usize, height: usize) -> Result<(), String> {
    if coverage.is_empty() || coverage.len() == width * height {
        Ok(())
    } else {
        Err(format!(
            "coverage must be empty or one byte per pixel of {width}x{height}"
        ))
    }
}

/// The index of the pixel that `(x, y)` mirrors.
fn mirror_index(x: usize, y: usize, width: usize, height: usize, vertical: bool) -> usize {
    if vertical {
        (height - 1 - y) * width + x
    } else {
        y * width + (width - 1 - x)
    }
}

/// The selection coverage mirrored with the pixels: the coverage of the new selection. An empty
/// `coverage` (everything selected) stays empty.
pub fn flip_coverage(
    coverage: &[u8],
    width: usize,
    height: usize,
    vertical: bool,
) -> Result<Vec<u8>, String> {
    check_coverage(coverage, width, height)?;
    if coverage.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(coverage.len());
    for y in 0..height {
        for x in 0..width {
            out.push(coverage[mirror_index(x, y, width, height, vertical)]);
        }
    }
    Ok(out)
}

/// The pixel with `c` of it lifted out: its alpha loses `round(alpha * c / 255)`, and a fully
/// lifted pixel becomes (0, 0, 0, 0).
fn remaining(px: [u8; 4], c: u32) -> [u8; 4] {
    match c {
        0 => px,
        255 => [0; 4],
        _ => {
            let alpha = px[3] as u32;
            // alpha * c / 255 is never exactly half way, so adding 127 rounds it to nearest.
            let lifted = (alpha * c + 127) / 255;
            [px[0], px[1], px[2], (alpha - lifted) as u8]
        }
    }
}

/// `lerp(base, top, c / 255)` per channel, rounded half up, as the selection clip and Move Selected
/// Pixels' drop do.
fn place(base: [u8; 4], top: [u8; 4], c: u32) -> [u8; 4] {
    match c {
        0 => base,
        255 => top,
        _ => {
            let keep = 255 - c;
            let mix = |k: usize| ((base[k] as u32 * keep + top[k] as u32 * c + 127) / 255) as u8;
            [mix(0), mix(1), mix(2), mix(3)]
        }
    }
}

/// Mirrors the selected pixels of a straight-alpha RGBA8 image left to right (`vertical` false) or
/// top to bottom (`vertical` true), as the module describes.
pub fn flip_object_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    coverage: &[u8],
    vertical: bool,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    check_coverage(coverage, width, height)?;
    let pixels = src.as_chunks::<4>().0;
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let i = y * width + x;
            let j = mirror_index(x, y, width, height, vertical);
            if coverage.is_empty() {
                out.extend_from_slice(&pixels[j]);
                continue;
            }
            let base = remaining(pixels[i], coverage[i] as u32);
            out.extend_from_slice(&place(base, pixels[j], coverage[j] as u32));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A distinct opaque colour per pixel, so every remap is visible.
    fn pattern(width: usize, height: usize) -> Vec<u8> {
        let mut img = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                img.extend_from_slice(&[
                    (x * 20 + 5) as u8,
                    (y * 30 + 7) as u8,
                    (x + y) as u8,
                    255,
                ]);
            }
        }
        img
    }

    fn at(img: &[u8], width: usize, x: usize, y: usize) -> [u8; 4] {
        let i = (y * width + x) * 4;
        [img[i], img[i + 1], img[i + 2], img[i + 3]]
    }

    fn mask_from(rows: &[&str]) -> Vec<u8> {
        rows.iter()
            .flat_map(|row| row.bytes().map(|b| if b == b'#' { 255 } else { 0 }))
            .collect()
    }

    #[test]
    fn without_a_selection_every_pixel_takes_its_mirror() {
        for (w, h) in [(4, 3), (5, 3), (1, 1), (6, 5), (7, 1), (1, 6)] {
            let src = pattern(w, h);
            let horizontal = flip_object_rgba8(&src, w, h, &[], false).unwrap();
            let vertical = flip_object_rgba8(&src, w, h, &[], true).unwrap();
            for y in 0..h {
                for x in 0..w {
                    assert_eq!(at(&horizontal, w, x, y), at(&src, w, w - 1 - x, y));
                    assert_eq!(at(&vertical, w, x, y), at(&src, w, x, h - 1 - y));
                }
            }
        }
    }

    #[test]
    fn odd_widths_keep_the_centre_column_and_flipping_twice_restores_the_image() {
        let (w, h) = (5, 4);
        let src = pattern(w, h);
        let once = flip_object_rgba8(&src, w, h, &[], false).unwrap();
        for y in 0..h {
            assert_eq!(at(&once, w, 2, y), at(&src, w, 2, y));
        }
        assert_eq!(flip_object_rgba8(&once, w, h, &[], false).unwrap(), src);
        let (w, h) = (3, 5);
        let src = pattern(w, h);
        let once = flip_object_rgba8(&src, w, h, &[], true).unwrap();
        for x in 0..w {
            assert_eq!(at(&once, w, x, 2), at(&src, w, x, 2));
        }
        assert_eq!(flip_object_rgba8(&once, w, h, &[], true).unwrap(), src);
    }

    #[test]
    fn a_fully_selected_rectangle_is_a_pure_mirror() {
        let (w, h) = (6, 4);
        let src = pattern(w, h);
        let full = vec![255u8; w * h];
        assert_eq!(
            flip_object_rgba8(&src, w, h, &full, false).unwrap(),
            flip_object_rgba8(&src, w, h, &[], false).unwrap()
        );
        assert_eq!(
            flip_object_rgba8(&src, w, h, &full, true).unwrap(),
            flip_object_rgba8(&src, w, h, &[], true).unwrap()
        );
    }

    #[test]
    fn an_l_shape_mirrors_with_its_outline_and_clears_what_it_vacates() {
        // The L's box is the whole 4 x 3 image. Flipped left to right, the L becomes a J.
        let (w, h) = (4, 3);
        let coverage = mask_from(&["#...", "#...", "####"]);
        let src = pattern(w, h);
        let out = flip_object_rgba8(&src, w, h, &coverage, false).unwrap();
        let selected = flip_coverage(&coverage, w, h, false).unwrap();
        assert_eq!(selected, mask_from(&["...#", "...#", "####"]));
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let expected = if selected[i] == 255 {
                    at(&src, w, w - 1 - x, y)
                } else if coverage[i] == 255 {
                    [0, 0, 0, 0]
                } else {
                    at(&src, w, x, y)
                };
                assert_eq!(at(&out, w, x, y), expected, "pixel ({x}, {y})");
            }
        }
        // The vacated column of the L is transparent; the rest of its box keeps its pixels.
        assert_eq!(at(&out, w, 0, 0), [0, 0, 0, 0]);
        assert_eq!(at(&out, w, 1, 1), at(&src, w, 1, 1));
        assert_eq!(at(&out, w, 3, 0), at(&src, w, 0, 0));
    }

    #[test]
    fn an_l_shape_flips_top_to_bottom() {
        let (w, h) = (3, 4);
        let coverage = mask_from(&["###", "#..", "#..", "#.."]);
        let src = pattern(w, h);
        let out = flip_object_rgba8(&src, w, h, &coverage, true).unwrap();
        let selected = flip_coverage(&coverage, w, h, true).unwrap();
        assert_eq!(selected, mask_from(&["#..", "#..", "#..", "###"]));
        assert_eq!(at(&out, w, 1, 0), [0, 0, 0, 0]);
        assert_eq!(at(&out, w, 2, 0), [0, 0, 0, 0]);
        assert_eq!(at(&out, w, 1, 3), at(&src, w, 1, 0));
        assert_eq!(at(&out, w, 0, 1), at(&src, w, 0, 2));
        assert_eq!(at(&out, w, 1, 1), at(&src, w, 1, 1));
    }

    /// An antialiased ellipse in the left part of an 8 x 6 box, as the selection rasterizer gives
    /// it: full inside, partial on the edge, zero outside.
    fn ellipse() -> Vec<u8> {
        (0..48)
            .map(|i| {
                let (x, y) = ((i % 8) as f64 + 0.5, (i / 8) as f64 + 0.5);
                let d = ((x - 2.0) / 2.0).powi(2) + ((y - 3.0) / 2.5).powi(2);
                (((1.2 - d) / 0.4).clamp(0.0, 1.0) * 255.0).round() as u8
            })
            .collect()
    }

    #[test]
    fn an_antialiased_ellipse_lifts_and_drops_its_edge_by_coverage() {
        let (w, h) = (8, 6);
        let coverage = ellipse();
        assert!(coverage.iter().any(|&c| c > 0 && c < 255));
        let src = pattern(w, h);
        let out = flip_object_rgba8(&src, w, h, &coverage, false).unwrap();
        let selected = flip_coverage(&coverage, w, h, false).unwrap();
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                let (c, m) = (coverage[i] as u32, selected[i] as u32);
                let px = at(&src, w, x, y);
                let base = match c {
                    0 => px,
                    255 => [0, 0, 0, 0],
                    _ => [px[0], px[1], px[2], 255 - ((255 * c + 127) / 255) as u8],
                };
                let top = at(&src, w, w - 1 - x, y);
                let mix =
                    |k: usize| ((base[k] as u32 * (255 - m) + top[k] as u32 * m + 127) / 255) as u8;
                assert_eq!(
                    at(&out, w, x, y),
                    [mix(0), mix(1), mix(2), mix(3)],
                    "({x}, {y})"
                );
            }
        }
        // The mirrored ellipse lands on the right; what it vacated on the left is transparent.
        let centre_left = 2 * w + 2;
        assert_eq!(coverage[centre_left], 255);
        assert_eq!(selected[centre_left], 0);
        assert_eq!(at(&out, w, 2, 2), [0, 0, 0, 0]);
        assert_eq!(at(&out, w, 5, 2), at(&src, w, 2, 2));
        // An unselected pixel that nothing lands on keeps its value.
        assert_eq!(at(&out, w, 0, 0), at(&src, w, 0, 0));
    }

    #[test]
    fn a_half_covered_pixel_under_its_own_mirror_keeps_its_colour() {
        // One pixel wide, so every pixel is its own mirror. As with Move Selected Pixels, the
        // half lifted out (alpha 255 -> 127) and the half dropped back over it by coverage give
        // alpha 191; the colour is kept, and a transparent pixel stays as it was.
        let src = vec![10, 20, 30, 255, 40, 50, 60, 0];
        let out = flip_object_rgba8(&src, 1, 2, &[128, 128], false).unwrap();
        assert_eq!(&out[0..4], &[10, 20, 30, 191]);
        assert_eq!(&out[4..8], &[40, 50, 60, 0]);
    }

    #[test]
    fn rejects_mismatched_buffers() {
        let src = pattern(2, 2);
        assert!(flip_object_rgba8(&src[..8], 2, 2, &[], false).is_err());
        assert!(flip_object_rgba8(&src, 2, 2, &[255; 3], false).is_err());
        assert!(flip_coverage(&[255; 3], 2, 2, true).is_err());
    }
}
