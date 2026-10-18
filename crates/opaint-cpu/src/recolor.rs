//! Recolor brush (TL-BRUSH-RC-01, TL-ALG-TOL).
//!
//! The stroke's coverage masks the layer. Each covered pixel within the tolerance of the basis
//! color is shifted channel by channel by (fill − basis), clamped to 0-255, so the shading of the
//! pixel is kept. A partly covered pixel takes the same fraction of the shift. The tolerance test
//! reads the pixel before the stroke, so overlapping dabs shift a pixel once.

use crate::brush::{stroke_coverage, stroke_points, BrushSettings, StrokePoint};
use crate::magic_wand::{distance, threshold};
use wasm_bindgen::prelude::*;

/// The recolor of one stroke: the basis color that is matched, the fill color that replaces it,
/// the threshold `T` of TL-ALG-TOL and the alpha mode (`straight` compares straight channels).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Recolor {
    pub basis: [u8; 4],
    pub fill: [u8; 4],
    pub limit: u32,
    pub straight: bool,
}

/// Recolors a stroke onto a straight-alpha RGBA8 buffer of `width` × `height` pixels, in place. The
/// brush gives the stroke's tip and its path, and `spec` gives the colors and the tolerance.
pub fn recolor(
    dst: &mut [u8],
    width: usize,
    height: usize,
    points: &[StrokePoint],
    brush: &BrushSettings,
    spec: &Recolor,
) -> Result<(), String> {
    if dst.len() != width * height * 4 {
        return Err("recolor target must be width × height RGBA8".to_owned());
    }
    let cover = stroke_coverage(width, height, points, brush);
    recolor_covered(dst, &cover, spec);
    Ok(())
}

/// Recolors the pixels of `dst` under a stroke whose coverage is `cover`, one byte per pixel.
/// Each pixel's result depends only on the pixel and its coverage, so a part of a buffer recolors
/// the same as the whole.
fn recolor_covered(dst: &mut [u8], cover: &[u8], spec: &Recolor) {
    for (i, &c) in cover.iter().enumerate() {
        if c == 0 {
            continue;
        }
        let at = i * 4;
        let pixel: [u8; 4] = dst[at..at + 4].try_into().expect("four bytes per pixel");
        if distance(pixel, spec.basis, spec.straight) > spec.limit {
            continue;
        }
        let c = u32::from(c);
        let painted: [u8; 4] = std::array::from_fn(|k| {
            let shifted = (i32::from(pixel[k]) + i32::from(spec.fill[k]) - i32::from(spec.basis[k]))
                .clamp(0, 255) as u32;
            ((u32::from(pixel[k]) * (255 - c) + shifted * c + 127) / 255) as u8
        });
        dst[at..at + 4].copy_from_slice(&painted);
    }
}

/// The Recolor settings of one stroke, as the color engine passes them: the basis and fill colors,
/// the tolerance `0..=1` (TL-ALG-TOL) and the alpha mode.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RecolorSettings {
    pub basis_r: u8,
    pub basis_g: u8,
    pub basis_b: u8,
    pub basis_a: u8,
    pub fill_r: u8,
    pub fill_g: u8,
    pub fill_b: u8,
    pub fill_a: u8,
    /// Tolerance `0..=1`, squared into the threshold `T` by `magic_wand::threshold`.
    pub tolerance: f64,
    /// Compare straight channels instead of premultiplied ones (TL-OPT-TOL alpha mode).
    pub straight: bool,
}

impl Default for RecolorSettings {
    /// Black basis and fill at full alpha, with the factory tolerance of 50 % (TL-OPT-FLOOD).
    fn default() -> Self {
        Self {
            basis_r: 0,
            basis_g: 0,
            basis_b: 0,
            basis_a: 255,
            fill_r: 0,
            fill_g: 0,
            fill_b: 0,
            fill_a: 255,
            tolerance: 0.5,
            straight: false,
        }
    }
}

#[wasm_bindgen]
impl RecolorSettings {
    #[wasm_bindgen(constructor)]
    pub fn new() -> RecolorSettings {
        Self::default()
    }
}

impl From<&RecolorSettings> for Recolor {
    fn from(settings: &RecolorSettings) -> Self {
        Recolor {
            basis: [
                settings.basis_r,
                settings.basis_g,
                settings.basis_b,
                settings.basis_a,
            ],
            fill: [
                settings.fill_r,
                settings.fill_g,
                settings.fill_b,
                settings.fill_a,
            ],
            limit: threshold(settings.tolerance),
            straight: settings.straight,
        }
    }
}

/// Recolors a stroke onto a straight-alpha RGBA8 buffer in place (see `recolor`). `path` is flat
/// `x, y, pressure` triples in canvas pixels.
#[wasm_bindgen]
pub fn recolor_rgba8(
    dst: &mut [u8],
    width: u32,
    height: u32,
    path: &[f32],
    brush: &BrushSettings,
    settings: &RecolorSettings,
) -> Result<(), JsError> {
    let points = stroke_points(path).map_err(|m| JsError::new(&m))?;
    recolor(
        dst,
        width as usize,
        height as usize,
        &points,
        brush,
        &Recolor::from(settings),
    )
    .map_err(|m| JsError::new(&m))
}

/// Recolors a straight-alpha RGBA8 buffer in place under the stroke coverage `cover` (one byte
/// per pixel, the same size), as `recolor` does with the coverage of a whole stroke. A live
/// Recolor stroke keeps its per-pixel values (`brush_cover_dabs`), turns them into coverage
/// (`brush_values_coverage`) and recolors only where it changed.
#[wasm_bindgen]
pub fn recolor_cover_rgba8(
    dst: &mut [u8],
    cover: &[u8],
    width: u32,
    height: u32,
    settings: &RecolorSettings,
) -> Result<(), JsError> {
    let pixels = width as usize * height as usize;
    if dst.len() != pixels * 4 || cover.len() != pixels {
        return Err(JsError::new(
            "recolor target must be width × height RGBA8 with one coverage byte per pixel",
        ));
    }
    recolor_covered(dst, cover, &Recolor::from(settings));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: [u8; 4] = [255, 0, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];

    fn hard_brush(size: f32) -> BrushSettings {
        BrushSettings {
            size,
            hardness: 1.0,
            smooth: false,
            antialias: false,
            pressure: false,
            ..BrushSettings::default()
        }
    }

    fn point(x: f32, y: f32) -> StrokePoint {
        StrokePoint {
            x,
            y,
            pressure: 1.0,
        }
    }

    fn blank(width: usize, height: usize, color: [u8; 4]) -> Vec<u8> {
        color.repeat(width * height)
    }

    fn pixel(buffer: &[u8], width: usize, x: usize, y: usize) -> [u8; 4] {
        let i = (y * width + x) * 4;
        [buffer[i], buffer[i + 1], buffer[i + 2], buffer[i + 3]]
    }

    fn spec(basis: [u8; 4], fill: [u8; 4], limit: u32) -> Recolor {
        Recolor {
            basis,
            fill,
            limit,
            straight: false,
        }
    }

    #[test]
    fn a_matching_pixel_under_the_stroke_takes_the_fill_offset() {
        let mut dst = blank(8, 8, RED);
        recolor(
            &mut dst,
            8,
            8,
            &[point(4.0, 4.0)],
            &hard_brush(4.0),
            &spec(RED, BLUE, 0),
        )
        .expect("recolor");
        assert_eq!(pixel(&dst, 8, 4, 4), BLUE);
        assert_eq!(pixel(&dst, 8, 0, 0), RED, "outside the stroke is untouched");
    }

    #[test]
    fn shading_survives_the_shift_and_the_channels_clamp() {
        let mut dst = blank(8, 8, [120, 0, 0, 255]);
        let bright = (4 * 8 + 4) * 4;
        dst[bright..bright + 4].copy_from_slice(&[250, 0, 0, 255]);
        recolor(
            &mut dst,
            8,
            8,
            &[point(4.0, 4.0)],
            &hard_brush(4.0),
            &spec([100, 0, 0, 255], [200, 50, 0, 255], 255),
        )
        .expect("recolor");
        assert_eq!(pixel(&dst, 8, 3, 4), [220, 50, 0, 255]);
        assert_eq!(
            pixel(&dst, 8, 4, 4),
            [255, 50, 0, 255],
            "250 + 100 clamps to 255"
        );
    }

    #[test]
    fn pixels_outside_the_tolerance_keep_their_color() {
        let mut dst = blank(8, 8, [120, 0, 0, 255]);
        recolor(
            &mut dst,
            8,
            8,
            &[point(4.0, 4.0)],
            &hard_brush(4.0),
            &spec([100, 0, 0, 255], [200, 50, 0, 255], 0),
        )
        .expect("recolor");
        assert_eq!(dst, blank(8, 8, [120, 0, 0, 255]));
    }

    #[test]
    fn a_soft_tip_shifts_partly_at_its_rim() {
        let mut dst = blank(16, 16, RED);
        let brush = BrushSettings {
            size: 12.0,
            hardness: 0.0,
            smooth: false,
            antialias: true,
            pressure: false,
            ..BrushSettings::default()
        };
        recolor(
            &mut dst,
            16,
            16,
            &[point(8.5, 8.5)],
            &brush,
            &spec(RED, BLUE, 255),
        )
        .expect("recolor");
        assert_eq!(pixel(&dst, 16, 8, 8), BLUE);
        let rim = pixel(&dst, 16, 13, 8);
        assert!(
            rim[0] > 0 && rim[0] < 255,
            "rim red {rim:?} is partly shifted"
        );
        assert_eq!(pixel(&dst, 16, 0, 0), RED);
    }

    #[test]
    fn overlapping_dabs_shift_a_pixel_once() {
        let mut dst = blank(8, 8, [100, 0, 0, 255]);
        recolor(
            &mut dst,
            8,
            8,
            &[point(4.0, 4.0), point(5.0, 4.0)],
            &hard_brush(4.0),
            &spec([100, 0, 0, 255], [150, 0, 0, 255], 0),
        )
        .expect("recolor");
        assert_eq!(pixel(&dst, 8, 4, 4), [150, 0, 0, 255]);
    }

    #[test]
    fn the_alpha_mode_decides_whether_clear_pixels_of_other_colors_match() {
        let clear_red = [255, 0, 0, 0];
        let clear_black = [0, 0, 0, 0];
        let premultiplied = spec(clear_black, BLUE, 100);
        let mut joined = blank(8, 8, clear_red);
        recolor(
            &mut joined,
            8,
            8,
            &[point(4.0, 4.0)],
            &hard_brush(4.0),
            &premultiplied,
        )
        .expect("recolor");
        assert_eq!(pixel(&joined, 8, 4, 4), [255, 0, 255, 255]);

        let straight = Recolor {
            straight: true,
            ..premultiplied
        };
        let mut separate = blank(8, 8, clear_red);
        recolor(
            &mut separate,
            8,
            8,
            &[point(4.0, 4.0)],
            &hard_brush(4.0),
            &straight,
        )
        .expect("recolor");
        assert_eq!(pixel(&separate, 8, 4, 4), clear_red);
    }

    #[test]
    fn recoloring_a_part_under_its_coverage_matches_the_whole_stroke() {
        use crate::brush::{cover_dabs, plan_dabs, stroke_values_coverage};
        let (w, h) = (24, 16);
        let mut original = blank(w, h, RED);
        for x in 0..w {
            let i = (5 * w + x) * 4;
            original[i..i + 4].copy_from_slice(&[200, 30, 0, 255]);
        }
        let brush = BrushSettings {
            size: 7.0,
            hardness: 0.4,
            antialias: true,
            ..BrushSettings::default()
        };
        let points = [point(3.0, 4.0), point(12.5, 7.0), point(20.0, 5.0)];
        let spec = spec(RED, BLUE, 80);
        let mut whole = original.clone();
        recolor(&mut whole, w, h, &points, &brush, &spec).expect("recolor");

        // The part from (6, 2) to (18, 12), covered segment by segment (each pair of joined
        // dabs), then recolored.
        let (ox, oy, pw, ph) = (6, 2, 12, 10);
        let dabs: Vec<f32> = plan_dabs(&points, &brush)
            .iter()
            .flat_map(|d| [d.x, d.y, d.diameter])
            .collect();
        assert!(dabs.len() >= 6);
        let mut values = vec![0u32; pw * ph * 2];
        let last = dabs.len() / 3 - 2;
        for (i, pair) in dabs.windows(6).step_by(3).enumerate() {
            cover_dabs(
                &mut values,
                pw,
                ph,
                (ox, oy),
                pair,
                &brush,
                i == 0,
                i == last,
            )
            .expect("cover");
        }
        let cover = stroke_values_coverage(&values, &brush);
        let mut part: Vec<u8> = (0..ph)
            .flat_map(|y| original[((y + oy) * w + ox) * 4..][..pw * 4].to_vec())
            .collect();
        recolor_covered(&mut part, &cover, &spec);
        for y in 0..ph {
            assert_eq!(
                &part[y * pw * 4..][..pw * 4],
                &whole[((y + oy) * w + ox) * 4..][..pw * 4],
                "row {y}"
            );
        }
        assert_ne!(whole, original);
    }

    #[test]
    fn the_settings_convert_their_tolerance_to_the_threshold() {
        let settings = RecolorSettings {
            tolerance: 0.5,
            ..RecolorSettings::default()
        };
        assert_eq!(Recolor::from(&settings).limit, 64);
        assert_eq!(Recolor::from(&settings).fill, [0, 0, 0, 255]);
    }

    #[test]
    fn rejects_a_target_of_the_wrong_size() {
        let brush = hard_brush(4.0);
        let result = recolor(
            &mut [0; 8],
            8,
            8,
            &[point(4.0, 4.0)],
            &brush,
            &spec(RED, BLUE, 0),
        );
        assert!(result.is_err());
    }
}
