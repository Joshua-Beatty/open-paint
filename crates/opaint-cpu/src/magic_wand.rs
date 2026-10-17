//! Magic Wand flood selection (TL-SEL-WAND-01) and the tolerance math it shares with the
//! Paint Bucket and Recolor (TL-ALG-TOL).
//!
//! A pixel joins the selection when its distance to the seed pixel is at most the threshold. The
//! distance compares premultiplied colors over 50 % gray (the default) or straight channels.
//! Contiguous mode grows the region from the seed through 4-way neighbors. Global mode tests every
//! pixel of the image.

use wasm_bindgen::prelude::*;

/// Flag of `magic_wand_mask`: compare straight (unpremultiplied) channels (TL-OPT-TOL alpha mode).
pub const FLAG_STRAIGHT: u8 = 1;
/// Flag of `magic_wand_mask`: select every matching pixel, not only the region joined to the seed.
pub const FLAG_GLOBAL: u8 = 2;

/// The threshold `T` of a tolerance `t` in [0, 1] (TL-ALG-TOL step 1). `b` is `t · 255` rounded
/// half away from zero, and `T = b · b / 255` in whole numbers.
pub fn threshold(tolerance: f64) -> u32 {
    let b = (tolerance.clamp(0.0, 1.0) * 255.0).round() as u32;
    b * b / 255
}

/// The color distance of two straight-alpha RGBA8 pixels (TL-ALG-TOL step 2). Identical pixels
/// are 0, and any other pair is at least 1. Premultiplied mode treats two fully transparent pixels
/// as equal.
pub fn distance(x: [u8; 4], y: [u8; 4], straight: bool) -> u32 {
    if x == y {
        return 0;
    }
    if !straight && x[3] == 0 && y[3] == 0 {
        return 0;
    }
    let (vx, vy) = if straight {
        (normalized(x), normalized(y))
    } else {
        (over_gray(x), over_gray(y))
    };
    let sum: f64 = (0..4).map(|c| (vx[c] - vy[c]).powi(2)).sum();
    ((sum.sqrt() * 0.5 * 255.0).round() as u32).max(1)
}

fn normalized(p: [u8; 4]) -> [f64; 4] {
    p.map(|c| f64::from(c) / 255.0)
}

/// The premultiplied color composited over 50 % gray, with alpha kept: v = c · a + 0.5 (1 − a).
fn over_gray(p: [u8; 4]) -> [f64; 4] {
    let [r, g, b, a] = normalized(p);
    let gray = 0.5 * (1.0 - a);
    [r * a + gray, g * a + gray, b * a + gray, a]
}

/// The selection of a flood from `seed` over a straight-alpha RGBA8 image of `width` x `height`
/// pixels, as one byte per pixel (255 selected, 0 not). The comparisons are always against the
/// seed pixel's color (TL-ALG-TOL step 4).
pub fn wand_mask(
    pixels: &[u8],
    width: usize,
    height: usize,
    seed: (usize, usize),
    tolerance: f64,
    flags: u8,
) -> Result<Vec<u8>, String> {
    if pixels.len() != width * height * 4 {
        return Err("magic wand pixels must be width x height RGBA8".to_owned());
    }
    let (sx, sy) = seed;
    if sx >= width || sy >= height {
        return Err("magic wand seed is outside the image".to_owned());
    }
    let straight = flags & FLAG_STRAIGHT != 0;
    let limit = threshold(tolerance);
    let pixel = |i: usize| -> [u8; 4] {
        [
            pixels[i * 4],
            pixels[i * 4 + 1],
            pixels[i * 4 + 2],
            pixels[i * 4 + 3],
        ]
    };
    let seed_color = pixel(sy * width + sx);
    let matches = |i: usize| distance(pixel(i), seed_color, straight) <= limit;

    let mut mask = vec![0u8; width * height];
    if flags & FLAG_GLOBAL != 0 {
        for (i, cell) in mask.iter_mut().enumerate() {
            if matches(i) {
                *cell = 255;
            }
        }
        return Ok(mask);
    }

    // Scanline flood fill: each popped seed fills its whole run of matching pixels, then the runs
    // touching it on the rows above and below are queued.
    let mut stack = vec![(sx, sy)];
    while let Some((x, y)) = stack.pop() {
        let row = y * width;
        if mask[row + x] != 0 || !matches(row + x) {
            continue;
        }
        let mut left = x;
        while left > 0 && mask[row + left - 1] == 0 && matches(row + left - 1) {
            left -= 1;
        }
        let mut right = x;
        while right + 1 < width && mask[row + right + 1] == 0 && matches(row + right + 1) {
            right += 1;
        }
        mask[row + left..=row + right].fill(255);
        let neighbors = [y.checked_sub(1), (y + 1 < height).then_some(y + 1)];
        for ny in neighbors.into_iter().flatten() {
            let next = ny * width;
            let mut nx = left;
            while nx <= right {
                if mask[next + nx] == 0 && matches(next + nx) {
                    stack.push((nx, ny));
                    while nx <= right && mask[next + nx] == 0 && matches(next + nx) {
                        nx += 1;
                    }
                } else {
                    nx += 1;
                }
            }
        }
    }
    Ok(mask)
}

/// The Magic Wand selection mask (see `wand_mask`) of a straight-alpha RGBA8 image. `flags` holds
/// `FLAG_STRAIGHT` and `FLAG_GLOBAL`.
#[wasm_bindgen]
pub fn magic_wand_mask(
    pixels: &[u8],
    width: u32,
    height: u32,
    seed_x: u32,
    seed_y: u32,
    tolerance: f64,
    flags: u8,
) -> Result<Vec<u8>, JsError> {
    wand_mask(
        pixels,
        width as usize,
        height as usize,
        (seed_x as usize, seed_y as usize),
        tolerance,
        flags,
    )
    .map_err(|message| JsError::new(&message))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: [u8; 4] = [255, 0, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];

    fn image(rows: &[&[[u8; 4]]]) -> (Vec<u8>, usize, usize) {
        let width = rows[0].len();
        let pixels = rows
            .iter()
            .flat_map(|row| row.iter().flatten().copied())
            .collect();
        (pixels, width, rows.len())
    }

    fn selected(mask: &[u8]) -> Vec<bool> {
        mask.iter().map(|&v| v == 255).collect()
    }

    #[test]
    fn the_threshold_is_the_squared_response_of_the_slider() {
        assert_eq!(threshold(0.0), 0);
        assert_eq!(threshold(1.0), 255);
        assert_eq!(threshold(0.5), 64);
        assert_eq!(threshold(0.01), 0);
        assert_eq!(threshold(-3.0), 0);
        assert_eq!(threshold(7.0), 255);
    }

    #[test]
    fn identical_pixels_are_zero_and_other_pairs_are_at_least_one() {
        assert_eq!(distance(RED, RED, false), 0);
        assert_eq!(distance(RED, RED, true), 0);
        assert_eq!(
            distance([100, 100, 100, 255], [100, 100, 101, 255], true),
            1
        );
        assert_eq!(
            distance([100, 100, 100, 255], [100, 100, 101, 255], false),
            1
        );
    }

    #[test]
    fn opaque_black_and_white_are_the_maximum_premultiplied_distance() {
        // ||(0,0,0,1) - (1,1,1,1)|| = sqrt(3), times 0.5 * 255 and rounded.
        assert_eq!(distance([0, 0, 0, 255], [255, 255, 255, 255], false), 221);
        assert_eq!(distance([0, 0, 0, 255], [255, 255, 255, 255], true), 221);
    }

    #[test]
    fn premultiplied_mode_ignores_the_color_of_transparent_pixels() {
        let clear = [0, 0, 0, 0];
        let other_clear = [255, 255, 255, 0];
        assert_eq!(distance(clear, other_clear, false), 0);
        assert!(distance(clear, other_clear, true) > 0);
    }

    #[test]
    fn premultiplied_mode_judges_a_faint_pixel_by_its_visible_color() {
        // Half-transparent red and the same red at full alpha differ in the premultiplied colors.
        let half = [255, 0, 0, 128];
        assert!(distance(half, RED, false) > distance(half, half, false));
        assert!(distance(half, RED, false) > 0);
    }

    #[test]
    fn tolerance_zero_selects_only_identical_pixels() {
        let (pixels, width, height) = image(&[&[RED, [254, 0, 0, 255], BLUE]]);
        let mask = wand_mask(&pixels, width, height, (0, 0), 0.0, 0).expect("mask");
        assert_eq!(selected(&mask), vec![true, false, false]);
    }

    #[test]
    fn tolerance_one_selects_everything() {
        let (pixels, width, height) = image(&[&[RED, BLUE, [0, 0, 0, 0]]]);
        let mask = wand_mask(&pixels, width, height, (1, 0), 1.0, 0).expect("mask");
        assert_eq!(selected(&mask), vec![true, true, true]);
    }

    #[test]
    fn contiguous_mode_stops_at_the_region_and_global_mode_takes_every_match() {
        let (pixels, width, height) = image(&[&[RED, RED, BLUE, RED, RED]]);
        let contiguous = wand_mask(&pixels, width, height, (0, 0), 0.0, 0).expect("mask");
        assert_eq!(selected(&contiguous), vec![true, true, false, false, false]);
        let global = wand_mask(&pixels, width, height, (0, 0), 0.0, FLAG_GLOBAL).expect("mask");
        assert_eq!(selected(&global), vec![true, true, false, true, true]);
    }

    #[test]
    fn contiguous_mode_follows_a_snake_through_rows_above_and_below() {
        let (pixels, width, height) = image(&[
            &[RED, RED, RED, RED, RED],
            &[BLUE, BLUE, BLUE, BLUE, RED],
            &[RED, RED, RED, RED, RED],
        ]);
        let mask = wand_mask(&pixels, width, height, (0, 0), 0.0, 0).expect("mask");
        assert!(mask
            .iter()
            .enumerate()
            .all(|(i, &v)| (v == 255) == (pixels[i * 4 + 2] == 0)));
        assert_eq!(mask.iter().filter(|&&v| v == 255).count(), 11);
    }

    #[test]
    fn diagonal_neighbors_are_not_connected() {
        let (pixels, width, height) = image(&[&[RED, BLUE], &[BLUE, RED]]);
        let mask = wand_mask(&pixels, width, height, (0, 0), 0.0, 0).expect("mask");
        assert_eq!(selected(&mask), vec![true, false, false, false]);
    }

    #[test]
    fn straight_mode_separates_transparent_pixels_that_premultiplied_mode_joins() {
        let (pixels, width, height) = image(&[&[[0, 0, 0, 0], [255, 255, 255, 0]]]);
        let premultiplied = wand_mask(&pixels, width, height, (0, 0), 0.0, 0).expect("mask");
        assert_eq!(selected(&premultiplied), vec![true, true]);
        let straight = wand_mask(&pixels, width, height, (0, 0), 0.0, FLAG_STRAIGHT).expect("mask");
        assert_eq!(selected(&straight), vec![true, false]);
    }

    #[test]
    fn a_seed_outside_the_image_or_a_wrong_length_is_an_error() {
        let (pixels, width, height) = image(&[&[RED]]);
        assert!(wand_mask(&pixels, width, height, (1, 0), 0.5, 0).is_err());
        assert!(wand_mask(&pixels, width, height, (0, 0), 0.5, 0).is_ok());
        assert!(wand_mask(&pixels[..3], width, height, (0, 0), 0.5, 0).is_err());
    }
}
