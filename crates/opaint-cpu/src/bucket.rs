//! Paint Bucket fill (TL-BUCKET-01, TL-OPT-FILL, TL-OPT-AA, TL-OPT-BLEND).
//!
//! The stencil is one byte per pixel from the flood (`magic_wand::wand_mask`): 255 inside the fill
//! region and 0 outside it. With antialiasing on, the stencil edge is feathered: a pixel inside the
//! stencil takes the mean of its 3 × 3 neighborhood, counting only pixels inside the image. The
//! fill paints each covered pixel with the Paintbrush's paint math (`brush::paint_pixel`), so the
//! blend modes, Overwrite and the hatch patterns behave the same in both tools.

use crate::brush::{paint_for, paint_pixel, source_at, BrushSettings, HATCH_COUNT};
use wasm_bindgen::prelude::*;

/// The coverage of each stencil pixel after the 1-pixel edge feather (TL-BUCKET-01). Pixels
/// outside the stencil stay 0, and a pixel whose 3 × 3 neighborhood lies inside it stays 255.
pub fn feathered(mask: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut out = vec![0u8; width * height];
    for y in 0..height {
        for x in 0..width {
            if mask[y * width + x] == 0 {
                continue;
            }
            let mut sum = 0u32;
            let mut count = 0u32;
            for ny in y.saturating_sub(1)..=(y + 1).min(height - 1) {
                for nx in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                    sum += u32::from(mask[ny * width + nx]);
                    count += 1;
                }
            }
            out[y * width + x] = ((sum + count / 2) / count) as u8;
        }
    }
    out
}

/// Fills the stencil `mask` (one byte per pixel) into the straight-alpha RGBA8 buffer `dst` of
/// `width` × `height` pixels. Solid fills paint `brush.r, g, b, a`. A hatch paints the foreground
/// on its set pixels and the background on the clear ones. The other brush fields are not read.
pub fn bucket_fill(
    dst: &mut [u8],
    width: usize,
    height: usize,
    mask: &[u8],
    brush: &BrushSettings,
) -> Result<(), String> {
    if dst.len() != width * height * 4 {
        return Err("bucket target must be width × height RGBA8".to_owned());
    }
    if mask.len() != width * height {
        return Err("bucket stencil must be one byte per pixel".to_owned());
    }
    if brush.hatch > HATCH_COUNT {
        return Err(format!("unknown hatch pattern {}", brush.hatch));
    }
    let paint = paint_for(brush.blend)?;
    let coverage = if brush.antialias {
        feathered(mask, width, height)
    } else {
        mask.to_vec()
    };
    for y in 0..height {
        for x in 0..width {
            let c = u32::from(coverage[y * width + x]);
            if c == 0 {
                continue;
            }
            let i = (y * width + x) * 4;
            let pixel: [u8; 4] = dst[i..i + 4].try_into().expect("four bytes per pixel");
            let src = source_at(brush, x, y);
            dst[i..i + 4].copy_from_slice(&paint_pixel(pixel, c, src, paint));
        }
    }
    Ok(())
}

/// Fills a stencil onto a straight-alpha RGBA8 buffer in place (see `bucket_fill`).
#[wasm_bindgen]
pub fn bucket_fill_rgba8(
    dst: &mut [u8],
    width: u32,
    height: u32,
    mask: &[u8],
    brush: &BrushSettings,
) -> Result<(), JsError> {
    bucket_fill(dst, width as usize, height as usize, mask, brush).map_err(|m| JsError::new(&m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blend::BlendMode;
    use crate::brush::{BrushSettings, HATCH_PATTERNS, OVERWRITE};

    const RED: [u8; 4] = [255, 0, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];

    fn solid(color: [u8; 4], antialias: bool) -> BrushSettings {
        BrushSettings {
            r: color[0],
            g: color[1],
            b: color[2],
            a: color[3],
            antialias,
            ..BrushSettings::default()
        }
    }

    fn blank(width: usize, height: usize, color: [u8; 4]) -> Vec<u8> {
        color.repeat(width * height)
    }

    fn pixel(buffer: &[u8], width: usize, x: usize, y: usize) -> [u8; 4] {
        let i = (y * width + x) * 4;
        [buffer[i], buffer[i + 1], buffer[i + 2], buffer[i + 3]]
    }

    #[test]
    fn a_full_stencil_keeps_full_coverage_at_the_image_edge() {
        let mask = vec![255u8; 9];
        assert_eq!(feathered(&mask, 3, 3), vec![255u8; 9]);
    }

    #[test]
    fn a_lone_stencil_pixel_is_feathered_by_its_neighborhood() {
        let mut mask = vec![0u8; 9];
        mask[4] = 255;
        let coverage = feathered(&mask, 3, 3);
        // One set pixel in a 3 × 3 neighborhood: (255 + 4) / 9 = 28.
        assert_eq!(coverage[4], 28);
        assert_eq!(coverage[0], 0);
        assert!(coverage.iter().enumerate().all(|(i, &v)| i == 4 || v == 0));
    }

    #[test]
    fn a_solid_fill_paints_only_the_stencil() {
        let (width, height) = (4, 2);
        let mut dst = blank(width, height, BLUE);
        let mask = [255, 255, 0, 0, 0, 255, 0, 0];
        bucket_fill(&mut dst, width, height, &mask, &solid(RED, false)).expect("fill");
        assert_eq!(pixel(&dst, width, 0, 0), RED);
        assert_eq!(pixel(&dst, width, 1, 0), RED);
        assert_eq!(pixel(&dst, width, 1, 1), RED);
        assert_eq!(pixel(&dst, width, 2, 0), BLUE);
        assert_eq!(pixel(&dst, width, 0, 1), BLUE);
    }

    #[test]
    fn an_aliased_fill_has_no_partial_edge() {
        let (width, height) = (3, 3);
        let mut dst = blank(width, height, BLUE);
        let mut mask = vec![0u8; 9];
        mask[4] = 255;
        bucket_fill(&mut dst, width, height, &mask, &solid(RED, false)).expect("fill");
        assert_eq!(pixel(&dst, width, 1, 1), RED);
        assert_eq!(pixel(&dst, width, 0, 1), BLUE);
    }

    #[test]
    fn an_antialiased_fill_blends_the_feathered_edge() {
        let (width, height) = (3, 3);
        let mut dst = blank(width, height, BLUE);
        let mut mask = vec![0u8; 9];
        mask[4] = 255;
        bucket_fill(&mut dst, width, height, &mask, &solid(RED, true)).expect("fill");
        // The center is covered by 28 of 255, so red mixes into blue by 28 / 255 (rounding ±1).
        let center = pixel(&dst, width, 1, 1);
        assert!(center[0].abs_diff(28) <= 1, "red {}", center[0]);
        assert!(center[2].abs_diff(255 - 28) <= 1, "blue {}", center[2]);
        assert_eq!(center[3], 255);
    }

    #[test]
    fn a_hatch_paints_the_foreground_and_background_by_the_pattern() {
        let (width, height) = (8, 8);
        let mut dst = blank(width, height, [0, 0, 0, 0]);
        let mask = vec![255u8; width * height];
        let brush = BrushSettings {
            hatch: 3,
            back_r: 0,
            back_g: 255,
            back_b: 0,
            back_a: 255,
            antialias: false,
            ..solid(RED, false)
        };
        bucket_fill(&mut dst, width, height, &mask, &brush).expect("fill");
        let pattern = HATCH_PATTERNS[2];
        for y in 0..height {
            for x in 0..width {
                let set = (pattern[y % 8] >> (7 - x)) & 1 == 1;
                let expected = if set { RED } else { [0, 255, 0, 255] };
                assert_eq!(pixel(&dst, width, x, y), expected, "pixel {x},{y}");
            }
        }
    }

    #[test]
    fn overwrite_replaces_the_destination_alpha() {
        let mut dst = blank(1, 1, [9, 9, 9, 0]);
        let brush = BrushSettings {
            blend: OVERWRITE,
            ..solid([10, 20, 30, 128], false)
        };
        bucket_fill(&mut dst, 1, 1, &[255], &brush).expect("fill");
        assert_eq!(dst, vec![10, 20, 30, 128]);
    }

    #[test]
    fn a_multiply_fill_darkens_the_destination() {
        let mut dst = blank(1, 1, [200, 100, 50, 255]);
        let brush = BrushSettings {
            blend: BlendMode::Multiply as u8,
            ..solid([255, 255, 255, 255], false)
        };
        bucket_fill(&mut dst, 1, 1, &[255], &brush).expect("fill");
        assert_eq!(dst, vec![200, 100, 50, 255]);
    }

    #[test]
    fn a_bad_length_an_unknown_hatch_or_an_unknown_blend_is_an_error() {
        let mut dst = blank(2, 2, RED);
        let mask = [255u8; 4];
        assert!(bucket_fill(&mut dst[..7], 2, 2, &mask, &solid(RED, false)).is_err());
        assert!(bucket_fill(&mut dst, 2, 2, &mask[..3], &solid(RED, false)).is_err());
        let hatch = BrushSettings {
            hatch: 9,
            ..solid(RED, false)
        };
        assert!(bucket_fill(&mut dst, 2, 2, &mask, &hatch).is_err());
        let blend = BrushSettings {
            blend: 99,
            ..solid(RED, false)
        };
        assert!(bucket_fill(&mut dst, 2, 2, &mask, &blend).is_err());
    }
}
