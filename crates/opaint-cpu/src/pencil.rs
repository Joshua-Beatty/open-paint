//! Pencil (TL-PENCIL-01): freeform one-pixel aliased lines with a blend mode.
//!
//! Each pointer sample lands on the pixel that contains it. Consecutive pixels are joined by
//! Bresenham lines, and a joint pixel is painted once, so a semi-transparent color is not
//! composited twice where two segments meet. The paint math is the brush's (`brush::paint_pixel`).

use crate::brush::{paint_for, paint_pixel};
use wasm_bindgen::prelude::*;

/// The pixels on the line from `from` to `to`, both included, in order from `from`.
fn line_cells(from: (i64, i64), to: (i64, i64)) -> Vec<(i64, i64)> {
    let (mut x, mut y) = from;
    let dx = (to.0 - from.0).abs();
    let dy = -(to.1 - from.1).abs();
    let sx = if from.0 < to.0 { 1 } else { -1 };
    let sy = if from.1 < to.1 { 1 } else { -1 };
    let mut err = dx + dy;
    let mut cells = vec![(x, y)];
    while (x, y) != to {
        let doubled = 2 * err;
        if doubled >= dy {
            err += dy;
            x += sx;
        }
        if doubled <= dx {
            err += dx;
            y += sy;
        }
        cells.push((x, y));
    }
    cells
}

/// Paints the polyline `points` (canvas pixels) on a straight-alpha RGBA8 buffer of `width` ×
/// `height` pixels. Pixels outside the buffer are skipped. `color` is straight RGBA and `blend` a
/// blend value as for the brush (0-13 or 14 for Overwrite).
pub fn pencil_stroke(
    dst: &mut [u8],
    width: usize,
    height: usize,
    points: &[(f32, f32)],
    color: [u8; 4],
    blend: u8,
) -> Result<(), String> {
    let cells: Vec<(i64, i64)> = points
        .iter()
        .map(|&(x, y)| (x.floor() as i64, y.floor() as i64))
        .collect();
    pencil_cells(dst, width, height, (0, 0), &cells, false, color, blend)
}

/// Paints the polyline through the pixel `cells` (image pixels) on a straight-alpha RGBA8 buffer
/// of `width` × `height` pixels whose top-left pixel is image pixel `origin`. When `joined`, the
/// first cell is the end of the line already painted, so only the segment from it is painted, and
/// a stroke painted a few cells at a time matches `pencil_stroke` over all of them.
#[allow(clippy::too_many_arguments)]
pub(crate) fn pencil_cells(
    dst: &mut [u8],
    width: usize,
    height: usize,
    origin: (i64, i64),
    cells: &[(i64, i64)],
    joined: bool,
    color: [u8; 4],
    blend: u8,
) -> Result<(), String> {
    if dst.len() != width * height * 4 {
        return Err("pencil target must be width × height RGBA8".to_owned());
    }
    let paint = paint_for(blend)?;
    let mut paint_cell = |(x, y): (i64, i64)| {
        let (x, y) = (x - origin.0, y - origin.1);
        if x < 0 || y < 0 || x as usize >= width || y as usize >= height {
            return;
        }
        let i = (y as usize * width + x as usize) * 4;
        let pixel: [u8; 4] = dst[i..i + 4].try_into().expect("four bytes per pixel");
        dst[i..i + 4].copy_from_slice(&paint_pixel(pixel, 255, color, paint));
    };
    let Some(&first) = cells.first() else {
        return Ok(());
    };
    if !joined {
        paint_cell(first);
    }
    for pair in cells.windows(2) {
        for cell in line_cells(pair[0], pair[1]).into_iter().skip(1) {
            paint_cell(cell);
        }
    }
    Ok(())
}

/// Paints a pencil stroke onto a straight-alpha RGBA8 buffer in place. `path` is flat `x, y` pairs in
/// canvas pixels. The color is straight RGBA, and `blend` is the blend value (0-13, or 14 for Overwrite).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn pencil_stroke_rgba8(
    dst: &mut [u8],
    width: u32,
    height: u32,
    path: &[f32],
    r: u8,
    g: u8,
    b: u8,
    a: u8,
    blend: u8,
) -> Result<(), JsError> {
    if !path.len().is_multiple_of(2) {
        return Err(JsError::new("path must be x, y pairs"));
    }
    let points: Vec<(f32, f32)> = path
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| (c[0], c[1]))
        .collect();
    pencil_stroke(
        dst,
        width as usize,
        height as usize,
        &points,
        [r, g, b, a],
        blend,
    )
    .map_err(|message| JsError::new(&message))
}

/// Paints the polyline through pixel `cells` (flat `x, y` pairs in image pixels) onto a
/// straight-alpha RGBA8 buffer whose top-left pixel is image pixel (`origin_x`, `origin_y`), as
/// `pencil_cells` does. A live Pencil stroke paints only its new samples with it, `joined` to the
/// last cell it painted.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn pencil_cells_rgba8(
    dst: &mut [u8],
    width: u32,
    height: u32,
    origin_x: i32,
    origin_y: i32,
    cells: &[i32],
    joined: bool,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
    blend: u8,
) -> Result<(), JsError> {
    if !cells.len().is_multiple_of(2) {
        return Err(JsError::new("cells must be x, y pairs"));
    }
    let cells: Vec<(i64, i64)> = cells
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| (i64::from(c[0]), i64::from(c[1])))
        .collect();
    pencil_cells(
        dst,
        width as usize,
        height as usize,
        (i64::from(origin_x), i64::from(origin_y)),
        &cells,
        joined,
        [r, g, b, a],
        blend,
    )
    .map_err(|message| JsError::new(&message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blend::{composite_pixel, BlendMode};

    fn canvas(width: usize, height: usize) -> Vec<u8> {
        vec![0; width * height * 4]
    }

    fn alpha(dst: &[u8], width: usize, x: usize, y: usize) -> u8 {
        dst[(y * width + x) * 4 + 3]
    }

    #[test]
    fn a_click_paints_the_pixel_under_the_pointer() {
        let mut dst = canvas(4, 4);
        pencil_stroke(&mut dst, 4, 4, &[(2.7, 1.2)], [9, 8, 7, 255], 0).expect("stroke");
        let painted: Vec<(usize, usize)> = (0..16)
            .filter(|&i| alpha(&dst, 4, i % 4, i / 4) != 0)
            .map(|i| (i % 4, i / 4))
            .collect();
        assert_eq!(painted, vec![(2, 1)]);
        assert_eq!(&dst[(4 + 2) * 4..][..4], &[9, 8, 7, 255]);
    }

    #[test]
    fn a_horizontal_and_a_diagonal_segment_paint_one_pixel_per_step() {
        let mut dst = canvas(6, 6);
        pencil_stroke(&mut dst, 6, 6, &[(0.0, 0.0), (3.0, 0.0)], [1, 2, 3, 255], 0).expect("row");
        for x in 0..4 {
            assert_eq!(alpha(&dst, 6, x, 0), 255, "x = {x}");
        }
        assert_eq!(alpha(&dst, 6, 4, 0), 0);

        let mut diagonal = canvas(6, 6);
        pencil_stroke(
            &mut diagonal,
            6,
            6,
            &[(0.0, 0.0), (3.0, 3.0)],
            [1, 2, 3, 255],
            0,
        )
        .expect("diagonal");
        for i in 0..4 {
            assert_eq!(alpha(&diagonal, 6, i, i), 255);
        }
        let painted = diagonal
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|px| px[3] != 0)
            .count();
        assert_eq!(painted, 4);
    }

    #[test]
    fn a_joint_pixel_is_painted_once() {
        // A translucent Normal color would be composited twice at the joint (2, 0) if it were shared.
        let color = [200, 50, 10, 128];
        let mut dst = canvas(5, 1);
        pencil_stroke(
            &mut dst,
            5,
            1,
            &[(0.0, 0.0), (2.0, 0.0), (4.0, 0.0)],
            color,
            BlendMode::Normal as u8,
        )
        .expect("polyline");
        let once = composite_pixel([0; 4], color, BlendMode::Normal, 255);
        assert_eq!(&dst[2 * 4..][..4], &once);
        assert_eq!(&dst[4 * 4..][..4], &once);
    }

    #[test]
    fn repeated_samples_add_nothing() {
        let color = [200, 50, 10, 128];
        let mut once = canvas(3, 1);
        pencil_stroke(&mut once, 3, 1, &[(1.0, 0.0)], color, 0).expect("single");
        let mut repeated = canvas(3, 1);
        pencil_stroke(
            &mut repeated,
            3,
            1,
            &[(1.0, 0.0), (1.4, 0.2), (1.0, 0.0)],
            color,
            0,
        )
        .expect("repeated");
        assert_eq!(once, repeated);
    }

    #[test]
    fn overwrite_replaces_the_destination_and_multiply_keeps_it() {
        let mut dst = [40, 90, 200, 255].repeat(4);
        pencil_stroke(&mut dst, 4, 1, &[(0.0, 0.0), (3.0, 0.0)], [1, 2, 3, 4], 14)
            .expect("overwrite");
        assert_eq!(dst, [1, 2, 3, 4].repeat(4));

        let mut kept = [40, 90, 200, 255].repeat(4);
        pencil_stroke(
            &mut kept,
            4,
            1,
            &[(0.0, 0.0), (3.0, 0.0)],
            [255, 255, 255, 255],
            BlendMode::Multiply as u8,
        )
        .expect("multiply");
        assert_eq!(kept, [40, 90, 200, 255].repeat(4));
    }

    #[test]
    fn pixels_outside_the_buffer_are_skipped() {
        let mut dst = canvas(3, 3);
        pencil_stroke(
            &mut dst,
            3,
            3,
            &[(-4.0, -4.0), (5.0, 1.0), (1.0, 1.0)],
            [1, 1, 1, 255],
            0,
        )
        .expect("clipped");
        assert_eq!(alpha(&dst, 3, 1, 1), 255);
    }

    #[test]
    fn painting_cells_a_few_at_a_time_at_another_origin_matches_the_whole_stroke() {
        let color = [200, 50, 10, 128];
        let points: Vec<(f32, f32)> = (0..30)
            .map(|i| {
                let t = i as f32;
                (
                    2.5 + (t * 0.9).sin() * 8.0 + t,
                    10.0 + (t * 0.5).cos() * 7.0,
                )
            })
            .collect();
        let (w, h) = (40, 24);
        let mut whole = canvas(w, h);
        pencil_stroke(&mut whole, w, h, &points, color, 0).expect("whole");

        let cells: Vec<(i64, i64)> = points
            .iter()
            .map(|&(x, y)| (x.floor() as i64, y.floor() as i64))
            .collect();
        let (ox, oy) = (3, 2);
        let (bw, bh) = (w - 3, h - 2);
        let mut part = canvas(bw, bh);
        let mut last: Option<(i64, i64)> = None;
        for chunk in cells.chunks(4) {
            let mut run: Vec<(i64, i64)> = last.into_iter().collect();
            run.extend_from_slice(chunk);
            pencil_cells(&mut part, bw, bh, (ox, oy), &run, last.is_some(), color, 0)
                .expect("part");
            last = chunk.last().copied();
        }
        for y in oy as usize..h {
            let row = &whole[(y * w + ox as usize) * 4..][..bw * 4];
            assert_eq!(
                &part[(y - oy as usize) * bw * 4..][..bw * 4],
                row,
                "row {y}"
            );
        }
        assert!(whole.iter().any(|&v| v != 0));
    }

    #[test]
    fn rejects_bad_targets_blend_values_and_odd_paths() {
        assert!(pencil_stroke(&mut [0; 8], 2, 2, &[(0.0, 0.0)], [0; 4], 0).is_err());
        assert!(pencil_stroke(&mut canvas(2, 2), 2, 2, &[(0.0, 0.0)], [0; 4], 15).is_err());
    }
}
