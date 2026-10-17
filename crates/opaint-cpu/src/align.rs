//! Align Object (FX-OBJ-ALIGN): moves everything non-transparent inside the selection, as one
//! rigid block, to one of the aligned positions inside the selection's bounding box.
//!
//! The work has two parts. `align_object_box` scans the source once for the object box. The
//! translation, `align_object_translate_rgba8`, then copies pixels by one whole-pixel offset. The
//! WGSL twin in `packages/effects` takes the same box and offset, so both backends match exactly.
//!
//! The frame is the whole image passed in: the host crops the layer to the selection's bounding
//! box first. `coverage` is the aliased selection over that image, one byte per pixel, where any
//! nonzero byte is selected. An empty `coverage` selects every pixel.

use crate::artistic::check_image;

/// The number of positions (FX-OBJ-ALIGN-04). Codes are the table rows: 0 Center to 15 Original.
pub const ALIGN_POSITIONS: u32 = 16;

/// The tight bounding rectangle of the object, with exclusive right and bottom edges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObjectBox {
    pub x1: usize,
    pub y1: usize,
    pub x2: usize,
    pub y2: usize,
}

fn check_coverage(coverage: &[u8], width: usize, height: usize) -> Result<(), String> {
    if coverage.is_empty() || coverage.len() == width * height {
        Ok(())
    } else {
        Err(format!(
            "coverage must be empty or one byte per pixel of {width}x{height}"
        ))
    }
}

fn selected(coverage: &[u8], index: usize) -> bool {
    coverage.is_empty() || coverage[index] > 0
}

/// The object box (FX-OBJ-ALIGN-03): the bounds of every selected pixel whose alpha is above 0,
/// or `None` when there is none. Every row and column is examined, including the last ones.
pub fn align_object_box(
    src: &[u8],
    width: usize,
    height: usize,
    coverage: &[u8],
) -> Result<Option<ObjectBox>, String> {
    check_image(src, width, height)?;
    check_coverage(coverage, width, height)?;
    let mut found: Option<ObjectBox> = None;
    for y in 0..height {
        let row = y * width;
        let mut first = None;
        let mut last = 0;
        for x in 0..width {
            let i = row + x;
            if src[i * 4 + 3] > 0 && selected(coverage, i) {
                first.get_or_insert(x);
                last = x;
            }
        }
        let Some(first) = first else { continue };
        found = Some(match found {
            None => ObjectBox {
                x1: first,
                y1: y,
                x2: last + 1,
                y2: y + 1,
            },
            Some(b) => ObjectBox {
                x1: b.x1.min(first),
                y1: b.y1,
                x2: b.x2.max(last + 1),
                y2: y + 1,
            },
        });
    }
    Ok(found)
}

/// Whether aligning changes nothing (FX-OBJ-ALIGN-06): there is no object, or the object box is
/// the whole frame.
pub fn align_object_is_noop(object: Option<ObjectBox>, width: usize, height: usize) -> bool {
    match object {
        None => true,
        Some(b) => b.x1 == 0 && b.y1 == 0 && b.x2 == width && b.y2 == height,
    }
}

fn check_box(object: ObjectBox, width: usize, height: usize) -> Result<(), String> {
    if object.x1 < object.x2 && object.y1 < object.y2 && object.x2 <= width && object.y2 <= height {
        Ok(())
    } else {
        Err(format!(
            "object box {object:?} must be non-empty and inside {width}x{height}"
        ))
    }
}

/// The offset `(dx, dy)` that moves the object box to `position` inside a `width` x `height`
/// frame (FX-OBJ-ALIGN-04). Centering uses integer halves, rounding down.
pub fn align_object_offset(
    object: ObjectBox,
    width: usize,
    height: usize,
    position: u32,
) -> Result<(i64, i64), String> {
    check_box(object, width, height)?;
    let as_i = |v: usize| v as i64;
    let (x1, y1) = (as_i(object.x1), as_i(object.y1));
    let (w, h) = (as_i(object.x2 - object.x1), as_i(object.y2 - object.y1));
    let (frame_w, frame_h) = (as_i(width), as_i(height));
    let cx = frame_w / 2 - w / 2;
    let cy = frame_h / 2 - h / 2;
    let (left, top, right, bottom) = (0, 0, frame_w - w, frame_h - h);
    let (nx, ny) = match position {
        0 => (cx, cy),
        1 => (left, top),
        2 => (left, bottom),
        3 => (right, top),
        4 => (right, bottom),
        5 => (left, cy),
        6 => (right, cy),
        7 => (cx, top),
        8 => (cx, bottom),
        9 => (left, y1),
        10 => (cx, y1),
        11 => (right, y1),
        12 => (x1, top),
        13 => (x1, cy),
        14 => (x1, bottom),
        15 => (x1, y1),
        _ => return Err(format!("position must be 0..16, got {position}")),
    };
    Ok((nx - x1, ny - y1))
}

/// Moves the object in `object` to `position` (FX-OBJ-ALIGN-05). Selected pixels take the object
/// pixel that lands on them, or become transparent (0, 0, 0, 0). Unselected pixels keep their
/// value. With `faint`, moved pixels are drawn opaque (FX-OBJ-ALIGN-07, preview only). When the
/// object box is the whole frame, the image is returned unchanged.
pub fn align_object_translate_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    coverage: &[u8],
    object: ObjectBox,
    position: u32,
    faint: bool,
) -> Result<Vec<u8>, String> {
    check_image(src, width, height)?;
    check_coverage(coverage, width, height)?;
    let (dx, dy) = align_object_offset(object, width, height, position)?;
    if align_object_is_noop(Some(object), width, height) {
        return Ok(src.to_vec());
    }
    let pixels = src.as_chunks::<4>().0;
    let mut out = Vec::with_capacity(src.len());
    let (x1, y1, x2, y2) = (
        object.x1 as i64,
        object.y1 as i64,
        object.x2 as i64,
        object.y2 as i64,
    );
    for y in 0..height {
        for x in 0..width {
            let i = y * width + x;
            if !selected(coverage, i) {
                out.extend_from_slice(&pixels[i]);
                continue;
            }
            let (sx, sy) = (x as i64 - dx, y as i64 - dy);
            let mut moved = [0u8; 4];
            if (x1..x2).contains(&sx) && (y1..y2).contains(&sy) {
                let j = sy as usize * width + sx as usize;
                let source = pixels[j];
                if source[3] > 0 && selected(coverage, j) {
                    moved = source;
                    if faint {
                        moved[3] = 255;
                    }
                }
            }
            out.extend_from_slice(&moved);
        }
    }
    Ok(out)
}

/// Align Object in one call: scans for the object box, then moves it. With no object, or an
/// object box equal to the frame, the image is returned unchanged.
pub fn align_object_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    coverage: &[u8],
    position: u32,
    faint: bool,
) -> Result<Vec<u8>, String> {
    if position >= ALIGN_POSITIONS {
        return Err(format!("position must be 0..16, got {position}"));
    }
    match align_object_box(src, width, height, coverage)? {
        None => Ok(src.to_vec()),
        Some(object) => {
            align_object_translate_rgba8(src, width, height, coverage, object, position, faint)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: [u8; 4] = [200, 10, 20, 255];
    const FAINT: [u8; 4] = [30, 40, 50, 1];

    fn clear(width: usize, height: usize) -> Vec<u8> {
        vec![0; width * height * 4]
    }

    fn put(img: &mut [u8], width: usize, x: usize, y: usize, rgba: [u8; 4]) {
        let i = (y * width + x) * 4;
        img[i..i + 4].copy_from_slice(&rgba);
    }

    fn at(img: &[u8], width: usize, x: usize, y: usize) -> [u8; 4] {
        let i = (y * width + x) * 4;
        [img[i], img[i + 1], img[i + 2], img[i + 3]]
    }

    /// The positions of the opaque-or-not object pixels (alpha > 0) of an image.
    fn object_pixels(img: &[u8], width: usize) -> Vec<(usize, usize)> {
        img.as_chunks::<4>()
            .0
            .iter()
            .enumerate()
            .filter(|(_, px)| px[3] > 0)
            .map(|(i, _)| (i % width, i / width))
            .collect()
    }

    fn bx(x1: usize, y1: usize, x2: usize, y2: usize) -> ObjectBox {
        ObjectBox { x1, y1, x2, y2 }
    }

    #[test]
    fn the_box_is_the_tight_bounds_of_every_pixel_above_zero_alpha() {
        let mut src = clear(10, 8);
        put(&mut src, 10, 3, 2, RED);
        put(&mut src, 10, 6, 5, FAINT);
        put(&mut src, 10, 4, 4, [9, 9, 9, 0]);
        assert_eq!(
            align_object_box(&src, 10, 8, &[]).unwrap(),
            Some(bx(3, 2, 7, 6))
        );
    }

    #[test]
    fn an_empty_layer_has_no_object() {
        let src = clear(5, 4);
        assert_eq!(align_object_box(&src, 5, 4, &[]).unwrap(), None);
        assert_eq!(align_object_rgba8(&src, 5, 4, &[], 0, false).unwrap(), src);
    }

    #[test]
    fn an_object_only_in_the_last_row_is_found() {
        let mut src = clear(6, 5);
        put(&mut src, 6, 2, 4, RED);
        assert_eq!(
            align_object_box(&src, 6, 5, &[]).unwrap(),
            Some(bx(2, 4, 3, 5))
        );
        let out = align_object_rgba8(&src, 6, 5, &[], 1, false).unwrap();
        assert_eq!(object_pixels(&out, 6), vec![(0, 0)]);
    }

    #[test]
    fn an_object_only_in_the_top_row_or_left_column_is_found() {
        let mut top = clear(6, 5);
        put(&mut top, 6, 1, 0, RED);
        put(&mut top, 6, 4, 0, RED);
        assert_eq!(
            align_object_box(&top, 6, 5, &[]).unwrap(),
            Some(bx(1, 0, 5, 1))
        );
        let out = align_object_rgba8(&top, 6, 5, &[], 4, false).unwrap();
        assert_eq!(object_pixels(&out, 6), vec![(2, 4), (5, 4)]);

        let mut left = clear(6, 5);
        put(&mut left, 6, 0, 1, RED);
        put(&mut left, 6, 0, 3, RED);
        assert_eq!(
            align_object_box(&left, 6, 5, &[]).unwrap(),
            Some(bx(0, 1, 1, 4))
        );
        let out = align_object_rgba8(&left, 6, 5, &[], 6, false).unwrap();
        assert_eq!(object_pixels(&out, 6), vec![(5, 1), (5, 3)]);
    }

    #[test]
    fn an_object_in_the_right_column_or_bottom_right_corner_is_found() {
        let mut src = clear(6, 5);
        put(&mut src, 6, 5, 4, RED);
        assert_eq!(
            align_object_box(&src, 6, 5, &[]).unwrap(),
            Some(bx(5, 4, 6, 5))
        );
    }

    #[test]
    fn every_position_follows_the_table() {
        // Frame 10 x 11; object 3 x 4 at (5, 2). cx = 5 - 1 = 4, cy = 5 - 2 = 3.
        let object = bx(5, 2, 8, 6);
        let expected: [(i64, i64); 16] = [
            (4, 3), // Center
            (0, 0), // Top Left
            (0, 7), // Bottom Left
            (7, 0), // Top Right
            (7, 7), // Bottom Right
            (0, 3), // Middle Left
            (7, 3), // Middle Right
            (4, 0), // Middle Top
            (4, 7), // Middle Bottom
            (0, 2), // Left
            (4, 2), // Center Horizontally
            (7, 2), // Right
            (5, 0), // Top
            (5, 3), // Center Vertically
            (5, 7), // Bottom
            (5, 2), // Original Position
        ];
        for (position, (nx, ny)) in expected.into_iter().enumerate() {
            let (dx, dy) = align_object_offset(object, 10, 11, position as u32).unwrap();
            assert_eq!((5 + dx, 2 + dy), (nx, ny), "position {position}");
        }
        assert!(align_object_offset(object, 10, 11, 16).is_err());
    }

    #[test]
    fn centering_puts_the_odd_pixel_by_the_integer_formula() {
        // W = 10, w = 3: 4 px on the left, 3 on the right.
        let (dx, _) = align_object_offset(bx(0, 0, 3, 1), 10, 2, 10).unwrap();
        assert_eq!(dx, 4);
        // W = 11, w = 4: 3 px on the left, 4 on the right.
        let (dx, _) = align_object_offset(bx(7, 0, 11, 1), 11, 2, 10).unwrap();
        assert_eq!(7 + dx, 3);
    }

    #[test]
    fn all_sixteen_positions_move_the_pixels_as_one_block() {
        let (w, h) = (9, 7);
        let mut src = clear(w, h);
        put(&mut src, w, 1, 1, RED);
        put(&mut src, w, 2, 2, FAINT);
        let object = align_object_box(&src, w, h, &[]).unwrap().unwrap();
        for position in 0..ALIGN_POSITIONS {
            let (dx, dy) = align_object_offset(object, w, h, position).unwrap();
            let out = align_object_rgba8(&src, w, h, &[], position, false).unwrap();
            let (rx, ry) = ((1 + dx) as usize, (1 + dy) as usize);
            let (fx, fy) = ((2 + dx) as usize, (2 + dy) as usize);
            assert_eq!(at(&out, w, rx, ry), RED, "position {position}");
            assert_eq!(at(&out, w, fx, fy), FAINT, "position {position}");
            assert_eq!(
                object_pixels(&out, w).len(),
                2,
                "position {position} moves, not copies"
            );
        }
    }

    #[test]
    fn vacated_pixels_become_transparent_black() {
        let mut src = clear(5, 5);
        for y in 0..5 {
            for x in 0..5 {
                put(&mut src, 5, x, y, [255, 255, 255, 0]);
            }
        }
        put(&mut src, 5, 4, 4, RED);
        let out = align_object_rgba8(&src, 5, 5, &[], 1, false).unwrap();
        assert_eq!(at(&out, 5, 0, 0), RED);
        assert_eq!(at(&out, 5, 4, 4), [0, 0, 0, 0]);
        assert_eq!(at(&out, 5, 2, 2), [0, 0, 0, 0]);
    }

    #[test]
    fn original_position_keeps_every_visible_pixel() {
        let mut src = clear(6, 6);
        put(&mut src, 6, 2, 3, RED);
        put(&mut src, 6, 4, 1, FAINT);
        let out = align_object_rgba8(&src, 6, 6, &[], 15, false).unwrap();
        assert_eq!(out, src);
    }

    #[test]
    fn faint_pixels_are_drawn_opaque_with_their_color() {
        let mut src = clear(6, 6);
        put(&mut src, 6, 2, 3, FAINT);
        put(&mut src, 6, 3, 3, RED);
        let out = align_object_rgba8(&src, 6, 6, &[], 1, true).unwrap();
        assert_eq!(at(&out, 6, 0, 0), [30, 40, 50, 255]);
        assert_eq!(at(&out, 6, 1, 0), RED);
    }

    #[test]
    fn a_filled_frame_or_border_is_left_unchanged() {
        let filled: Vec<u8> = RED.iter().copied().cycle().take(4 * 3 * 4).collect();
        let object = align_object_box(&filled, 4, 3, &[]).unwrap();
        assert!(align_object_is_noop(object, 4, 3));
        assert_eq!(
            align_object_rgba8(&filled, 4, 3, &[], 1, true).unwrap(),
            filled
        );

        let mut border = clear(5, 4);
        put(&mut border, 5, 0, 1, RED);
        put(&mut border, 5, 4, 2, RED);
        put(&mut border, 5, 2, 0, RED);
        put(&mut border, 5, 2, 3, RED);
        let object = align_object_box(&border, 5, 4, &[]).unwrap();
        assert!(align_object_is_noop(object, 5, 4));
        assert_eq!(
            align_object_rgba8(&border, 5, 4, &[], 0, false).unwrap(),
            border
        );
    }

    #[test]
    fn a_full_width_object_still_moves_vertically() {
        let mut src = clear(4, 6);
        for x in 0..4 {
            put(&mut src, 4, x, 1, RED);
        }
        let object = align_object_box(&src, 4, 6, &[]).unwrap();
        assert!(!align_object_is_noop(object, 4, 6));
        let out = align_object_rgba8(&src, 4, 6, &[], 4, false).unwrap();
        assert!((0..4).all(|x| at(&out, 4, x, 5) == RED));
        assert!((0..4).all(|x| at(&out, 4, x, 1) == [0, 0, 0, 0]));
    }

    #[test]
    fn only_selected_pixels_are_found_moved_or_cleared() {
        // A 6 x 6 frame where the top-right 3 x 3 and the right column are not selected.
        let (w, h) = (6, 6);
        let mut coverage = vec![255u8; w * h];
        for y in 0..3 {
            for x in 3..6 {
                coverage[y * w + x] = 0;
            }
        }
        for y in 0..h {
            coverage[y * w + 5] = 0;
        }
        let mut src = clear(w, h);
        put(&mut src, w, 4, 1, [1, 2, 3, 255]); // outside: never moved or cleared
        put(&mut src, w, 1, 4, RED); // the object
        put(&mut src, w, 5, 5, [7, 7, 7, 255]); // outside, in the bottom right corner
        assert_eq!(
            align_object_box(&src, w, h, &coverage).unwrap(),
            Some(bx(1, 4, 2, 5))
        );
        // Top Right puts the object at (5, 0), which is not selected: it is clipped away.
        let out = align_object_rgba8(&src, w, h, &coverage, 3, false).unwrap();
        assert_eq!(at(&out, w, 4, 1), [1, 2, 3, 255]);
        assert_eq!(at(&out, w, 5, 5), [7, 7, 7, 255]);
        assert_eq!(at(&out, w, 5, 0), [0, 0, 0, 0]);
        assert_eq!(at(&out, w, 1, 4), [0, 0, 0, 0]);
        assert_eq!(object_pixels(&out, w), vec![(4, 1), (5, 5)]);
        // Bottom Left lands inside the selection.
        let out = align_object_rgba8(&src, w, h, &coverage, 2, false).unwrap();
        assert_eq!(at(&out, w, 0, 5), RED);
        assert_eq!(at(&out, w, 1, 4), [0, 0, 0, 0]);
    }

    #[test]
    fn a_fully_transparent_selection_has_no_object() {
        let mut src = clear(4, 4);
        put(&mut src, 4, 3, 3, RED);
        let mut coverage = vec![255u8; 16];
        coverage[15] = 0;
        assert_eq!(align_object_box(&src, 4, 4, &coverage).unwrap(), None);
        assert_eq!(
            align_object_rgba8(&src, 4, 4, &coverage, 0, false).unwrap(),
            src
        );
    }

    #[test]
    fn rejects_bad_arguments() {
        let src = clear(2, 2);
        assert!(align_object_box(&src[..8], 2, 2, &[]).is_err());
        assert!(align_object_box(&src, 2, 2, &[255; 3]).is_err());
        assert!(align_object_rgba8(&src, 2, 2, &[], 16, false).is_err());
        assert!(align_object_translate_rgba8(&src, 2, 2, &[], bx(0, 0, 3, 1), 0, false).is_err());
        assert!(align_object_translate_rgba8(&src, 2, 2, &[], bx(1, 0, 1, 1), 0, false).is_err());
    }
}
