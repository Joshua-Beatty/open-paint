//! Clone Stamp brush (TL-BRUSH-CS-01, TL-BRUSH-01).
//!
//! The stroke stamps the brush tip along its path, as the Paintbrush does, but each covered pixel
//! takes its color from the source pixels instead of the brush color. The caller samples the source
//! at the stroke's offset, so the kernel sees one source pixel per destination pixel. Each dab is
//! composited with the brush's blend mode (or Overwrite), so the tip's coverage fades the source in.

use crate::brush::{
    check_live_buffers, paint_for, paint_pixel, stroke_coverage, stroke_points, visit_dabs,
    BrushSettings, StrokePoint,
};
use wasm_bindgen::prelude::*;

/// Clones a stroke from `source` onto the straight-alpha RGBA8 buffer `dst`, both `width` × `height`
/// pixels, in place. `source` is the pixel of the source under each destination pixel, read before
/// the stroke. The brush gives the tip, the path and the blend mode.
pub fn clone_stamp(
    dst: &mut [u8],
    source: &[u8],
    width: usize,
    height: usize,
    points: &[StrokePoint],
    brush: &BrushSettings,
) -> Result<(), String> {
    let len = width * height * 4;
    if dst.len() != len || source.len() != len {
        return Err("clone target and source must be width × height RGBA8".to_owned());
    }
    let paint = paint_for(brush.blend)?;
    let cover = stroke_coverage(width, height, points, brush);
    for (index, &c) in cover.iter().enumerate() {
        if c == 0 {
            continue;
        }
        let i = index * 4;
        let pixel: [u8; 4] = dst[i..i + 4].try_into().expect("four bytes per pixel");
        let src: [u8; 4] = source[i..i + 4].try_into().expect("four bytes per pixel");
        dst[i..i + 4].copy_from_slice(&paint_pixel(pixel, u32::from(c), src, paint));
    }
    Ok(())
}

/// Clones a stroke onto a straight-alpha RGBA8 buffer in place (see `clone_stamp`). `path` is flat
/// `x, y, pressure` triples in canvas pixels, and `source` holds the source pixels of the buffer.
#[wasm_bindgen]
pub fn clone_stroke_rgba8(
    dst: &mut [u8],
    source: &[u8],
    width: u32,
    height: u32,
    path: &[f32],
    brush: &BrushSettings,
) -> Result<(), JsError> {
    let points = stroke_points(path).map_err(|m| JsError::new(&m))?;
    clone_stamp(dst, source, width as usize, height as usize, &points, brush)
        .map_err(|m| JsError::new(&m))
}

/// Clones `dabs` (flat `x, y, diameter` triples in image pixels, in order) from `source` onto
/// `dst`, all `width` × `height` with their top-left pixel at image pixel `origin`. `original`
/// holds the pixels before the stroke and `cover` the stroke's coverage so far: where a dab
/// raises the coverage, the pixel is cloned again from its original with the new coverage.
/// Stamping a stroke's planned dabs a few at a time this way matches `clone_stamp` over the whole
/// stroke.
#[allow(clippy::too_many_arguments)]
pub(crate) fn clone_stamp_dabs(
    dst: &mut [u8],
    original: &[u8],
    source: &[u8],
    cover: &mut [u8],
    width: usize,
    height: usize,
    origin: (usize, usize),
    dabs: &[f32],
    brush: &BrushSettings,
) -> Result<(), String> {
    check_live_buffers(dst, original, cover, width, height)?;
    if source.len() != width * height * 4 {
        return Err("clone target and source must be width × height RGBA8".to_owned());
    }
    let paint = paint_for(brush.blend)?;
    visit_dabs(width, height, origin, dabs, brush, |x, y, c| {
        let cell = &mut cover[y * width + x];
        if c <= u32::from(*cell) {
            return;
        }
        *cell = c.min(255) as u8;
        let i = (y * width + x) * 4;
        let pixel: [u8; 4] = original[i..i + 4].try_into().expect("four bytes per pixel");
        let src: [u8; 4] = source[i..i + 4].try_into().expect("four bytes per pixel");
        dst[i..i + 4].copy_from_slice(&paint_pixel(pixel, c, src, paint));
    })
}

/// Clones `dabs` onto a straight-alpha RGBA8 buffer in place (see `clone_stamp_dabs`). A live
/// Clone Stamp stroke stamps only the dabs new since the last frame with it.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn clone_stamp_dabs_rgba8(
    dst: &mut [u8],
    original: &[u8],
    source: &[u8],
    cover: &mut [u8],
    width: u32,
    height: u32,
    origin_x: u32,
    origin_y: u32,
    dabs: &[f32],
    brush: &BrushSettings,
) -> Result<(), JsError> {
    clone_stamp_dabs(
        dst,
        original,
        source,
        cover,
        width as usize,
        height as usize,
        (origin_x as usize, origin_y as usize),
        dabs,
        brush,
    )
    .map_err(|m| JsError::new(&m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::OVERWRITE;

    const RED: [u8; 4] = [255, 0, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];
    const CLEAR: [u8; 4] = [0, 0, 0, 0];

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

    #[test]
    fn the_stroke_copies_the_source_pixel_under_each_dab() {
        let mut dst = blank(8, 8, CLEAR);
        let mut source = blank(8, 8, CLEAR);
        let i = (4 * 8 + 4) * 4;
        source[i..i + 4].copy_from_slice(&BLUE);
        clone_stamp(
            &mut dst,
            &source,
            8,
            8,
            &[point(4.5, 4.5)],
            &hard_brush(1.0),
        )
        .expect("clone");
        assert_eq!(pixel(&dst, 8, 4, 4), BLUE);
        assert_eq!(
            pixel(&dst, 8, 0, 0),
            CLEAR,
            "outside the stroke is untouched"
        );
    }

    #[test]
    fn a_stroke_follows_the_source_it_is_given_not_the_brush_color() {
        let mut dst = blank(8, 8, RED);
        let source = blank(8, 8, BLUE);
        clone_stamp(
            &mut dst,
            &source,
            8,
            8,
            &[point(1.0, 4.0), point(6.0, 4.0)],
            &hard_brush(2.0),
        )
        .expect("clone");
        assert_eq!(pixel(&dst, 8, 3, 4), BLUE);
    }

    #[test]
    fn a_clear_source_under_normal_blend_leaves_the_destination_alone() {
        let mut dst = blank(8, 8, RED);
        let source = blank(8, 8, CLEAR);
        clone_stamp(
            &mut dst,
            &source,
            8,
            8,
            &[point(4.0, 4.0)],
            &hard_brush(4.0),
        )
        .expect("clone");
        assert_eq!(dst, blank(8, 8, RED));
    }

    #[test]
    fn overwrite_replaces_the_destination_with_the_source() {
        let mut dst = blank(8, 8, RED);
        let source = blank(8, 8, CLEAR);
        let brush = BrushSettings {
            blend: OVERWRITE,
            ..hard_brush(4.0)
        };
        clone_stamp(&mut dst, &source, 8, 8, &[point(4.0, 4.0)], &brush).expect("clone");
        assert_eq!(pixel(&dst, 8, 4, 4), CLEAR);
        assert_eq!(pixel(&dst, 8, 0, 0), RED);
    }

    #[test]
    fn a_soft_tip_fades_the_source_in_at_its_rim() {
        let mut dst = blank(16, 16, RED);
        let source = blank(16, 16, BLUE);
        let brush = BrushSettings {
            size: 12.0,
            hardness: 0.0,
            smooth: false,
            antialias: true,
            pressure: false,
            ..BrushSettings::default()
        };
        clone_stamp(&mut dst, &source, 16, 16, &[point(8.0, 8.0)], &brush).expect("clone");
        assert_eq!(pixel(&dst, 16, 8, 8), BLUE);
        let rim = pixel(&dst, 16, 13, 8);
        assert!(
            rim[2] > 0 && rim[2] < 255 && rim[0] > 0,
            "rim {rim:?} is partly cloned"
        );
    }

    #[test]
    fn cloning_planned_dabs_in_chunks_at_another_origin_matches_the_whole_stroke() {
        use crate::brush::DabPlanner;
        let (w, h) = (40, 30);
        let mut source = blank(w, h, CLEAR);
        for (i, px) in source.chunks_mut(4).enumerate() {
            px.copy_from_slice(&[(i * 7) as u8, (i * 3) as u8, 200, (100 + i % 156) as u8]);
        }
        let brush = BrushSettings {
            size: 6.0,
            hardness: 0.5,
            antialias: true,
            smooth: true,
            ..BrushSettings::default()
        };
        let points: Vec<StrokePoint> = (0..12)
            .map(|i| point(6.0 + i as f32 * 2.5, 8.0 + (i as f32 * 0.8).sin() * 6.0))
            .collect();
        let mut whole = blank(w, h, RED);
        clone_stamp(&mut whole, &source, w, h, &points, &brush).expect("clone");

        let (ox, oy) = (2, 1);
        let (bw, bh) = (w - ox, h - oy);
        let crop = |buffer: &[u8]| -> Vec<u8> {
            (0..bh)
                .flat_map(|y| buffer[((y + oy) * w + ox) * 4..][..bw * 4].to_vec())
                .collect()
        };
        let part_source = crop(&source);
        let mut part = blank(bw, bh, RED);
        let original = part.clone();
        let mut cover = vec![0u8; bw * bh];
        let mut planner = DabPlanner::new(&brush);
        let path: Vec<f32> = points.iter().flat_map(|p| [p.x, p.y, p.pressure]).collect();
        let mut stamp = |part: &mut Vec<u8>, dabs: &[f32]| {
            let (src, origin) = (&part_source, (ox, oy));
            clone_stamp_dabs(
                part, &original, src, &mut cover, bw, bh, origin, dabs, &brush,
            )
            .expect("clone");
        };
        for chunk in path.chunks(9) {
            let dabs = planner.push(chunk).expect("triples");
            stamp(&mut part, &dabs);
        }
        stamp(&mut part, &planner.finish());
        assert_eq!(part, crop(&whole));
        assert_ne!(whole, blank(w, h, RED));
    }

    #[test]
    fn rejects_buffers_of_the_wrong_size() {
        let mut dst = blank(8, 8, RED);
        let short = [0u8; 8];
        let result = clone_stamp(&mut dst, &short, 8, 8, &[point(4.0, 4.0)], &hard_brush(4.0));
        assert!(result.is_err());
    }
}
