//! Pixelate (FX-DIST-PIXELATE). The source is scaled down to one sample per cell, on a grid
//! anchored at a point, and the cells are scaled back up. The cells are kept as premultiplied RGBA8,
//! so the result is the same on every backend. `packages/effects/src/pixelate-wgsl.ts` is the WGSL
//! twin, and it uses the same grid, filters and f32 operations in the same order.

use crate::distort::{premultiply, push_straight, sample, to_u8, EdgeMode, Texel};
use crate::transform::catmull_rom;

/// The most samples per axis of the multisampled Scale Down filters (a cell averages up to 8 × 8).
const MAX_MULTISAMPLE: usize = 8;

/// The Scale Down interpolation (FX-DIST-PIXELATE-02), by its code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScaleDown {
    NearestNeighbor = 0,
    Bilinear = 1,
    Bicubic = 2,
    MultisampleBilinear = 3,
    BicubicHighQuality = 4,
    Anisotropic = 5,
}

impl ScaleDown {
    pub fn from_code(code: u8) -> Result<Self, String> {
        match code {
            0 => Ok(Self::NearestNeighbor),
            1 => Ok(Self::Bilinear),
            2 => Ok(Self::Bicubic),
            3 => Ok(Self::MultisampleBilinear),
            4 => Ok(Self::BicubicHighQuality),
            5 => Ok(Self::Anisotropic),
            other => Err(format!("scale down must be 0-5, got {other}")),
        }
    }
}

/// The Scale Up interpolation (FX-DIST-PIXELATE-02), by its code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScaleUp {
    NearestNeighbor = 0,
    Bilinear = 1,
    Bicubic = 2,
}

impl ScaleUp {
    pub fn from_code(code: u8) -> Result<Self, String> {
        match code {
            0 => Ok(Self::NearestNeighbor),
            1 => Ok(Self::Bilinear),
            2 => Ok(Self::Bicubic),
            other => Err(format!("scale up must be 0-2, got {other}")),
        }
    }
}

/// The anchor point and cell size (FX-DIST-PIXELATE-03 step 1), as `[ax, ay, cell]`. `anchor` is the
/// Anchor control from (-1, -1) to (1, 1), over a `width` × `height` region.
pub fn pixelate_plan(width: f32, height: f32, anchor: [f32; 2], cell: f32) -> [f32; 3] {
    [
        width * (1.0 + anchor[0]) / 2.0,
        height * (1.0 + anchor[1]) / 2.0,
        cell,
    ]
}

/// The cells that cover the image, as `[first column, first row, columns, rows]`. Cell `k` on an
/// axis spans `[a + k·cell, a + (k + 1)·cell)`, and the grid holds every cell that a pixel center
/// falls in.
pub fn pixelate_grid(width: usize, height: usize, plan: [f32; 3]) -> [i32; 4] {
    let [ax, ay, cell] = plan;
    let (x0, x1) = axis_cells(width, ax, cell);
    let (y0, y1) = axis_cells(height, ay, cell);
    [x0, y0, x1 - x0 + 1, y1 - y0 + 1]
}

fn axis_cells(len: usize, anchor: f32, cell: f32) -> (i32, i32) {
    let first = ((0.5 - anchor) / cell).floor() as i32;
    let last = ((len as f32 - 0.5 - anchor) / cell).floor() as i32;
    (first, last)
}

/// A texel of the plane, with the coordinates clamped to the image (the Clamp edge).
fn texel_at(plane: &[Texel], width: usize, height: usize, x: isize, y: isize) -> Texel {
    let cx = x.clamp(0, width as isize - 1) as usize;
    let cy = y.clamp(0, height as isize - 1) as usize;
    plane[cy * width + cx]
}

/// Catmull-Rom sample of the plane at `s`, with the 4 × 4 taps around it (clamped to the image).
fn catmull_sample(plane: &[Texel], width: usize, height: usize, s: [f32; 2]) -> Texel {
    let u = [s[0] - 0.5, s[1] - 0.5];
    let base = [u[0].floor(), u[1].floor()];
    let wx = catmull_rom(u[0] - base[0]);
    let wy = catmull_rom(u[1] - base[1]);
    let (bx, by) = (base[0] as isize, base[1] as isize);
    let mut out = [0.0f32; 4];
    for (j, weight_y) in wy.iter().enumerate() {
        for (i, weight_x) in wx.iter().enumerate() {
            let texel = texel_at(
                plane,
                width,
                height,
                bx - 1 + i as isize,
                by - 1 + j as isize,
            );
            let weight = weight_x * weight_y;
            for (total, value) in out.iter_mut().zip(texel) {
                *total += weight * value;
            }
        }
    }
    out
}

/// The average of an evenly spaced `grid` × `grid` set of samples inside the cell at `lo`, each
/// bilinear or Catmull-Rom.
fn multisample(
    plane: &[Texel],
    width: usize,
    height: usize,
    lo: [f32; 2],
    cell: f32,
    cubic: bool,
) -> Texel {
    let grid = (cell.ceil() as usize).clamp(1, MAX_MULTISAMPLE);
    let step = cell / grid as f32;
    let mut acc = [0.0f32; 4];
    for b in 0..grid {
        for a in 0..grid {
            let s = [
                lo[0] + (a as f32 + 0.5) * step,
                lo[1] + (b as f32 + 0.5) * step,
            ];
            let texel = if cubic {
                catmull_sample(plane, width, height, s)
            } else {
                sample(plane, width, height, s, EdgeMode::Clamp)
            };
            for (total, value) in acc.iter_mut().zip(texel) {
                *total += value;
            }
        }
    }
    let count = (grid * grid) as f32;
    acc.map(|total| total / count)
}

/// The exact area average over `[lo, hi)`: each source pixel counts by its overlap with the cell.
fn area(plane: &[Texel], width: usize, height: usize, lo: [f32; 2], hi: [f32; 2]) -> Texel {
    let (x0, x1) = (lo[0].floor() as isize, hi[0].ceil() as isize - 1);
    let (y0, y1) = (lo[1].floor() as isize, hi[1].ceil() as isize - 1);
    let mut acc = [0.0f32; 4];
    let mut total = 0.0f32;
    for y in y0..=y1 {
        let wy = (y as f32 + 1.0).min(hi[1]) - (y as f32).max(lo[1]);
        for x in x0..=x1 {
            let wx = (x as f32 + 1.0).min(hi[0]) - (x as f32).max(lo[0]);
            let weight = wx * wy;
            let texel = texel_at(plane, width, height, x, y);
            for (sum, value) in acc.iter_mut().zip(texel) {
                *sum += weight * value;
            }
            total += weight;
        }
    }
    acc.map(|sum| sum / total)
}

/// One cell's premultiplied color under the Scale Down filter. `lo` is the cell's corner in source
/// pixels.
fn cell_texel(
    plane: &[Texel],
    width: usize,
    height: usize,
    lo: [f32; 2],
    cell: f32,
    filter: ScaleDown,
) -> Texel {
    let center = [lo[0] + cell * 0.5, lo[1] + cell * 0.5];
    match filter {
        ScaleDown::NearestNeighbor => texel_at(
            plane,
            width,
            height,
            center[0].floor() as isize,
            center[1].floor() as isize,
        ),
        ScaleDown::Bilinear => sample(plane, width, height, center, EdgeMode::Clamp),
        ScaleDown::Bicubic => catmull_sample(plane, width, height, center),
        ScaleDown::MultisampleBilinear => multisample(plane, width, height, lo, cell, false),
        ScaleDown::BicubicHighQuality => multisample(plane, width, height, lo, cell, true),
        ScaleDown::Anisotropic => area(plane, width, height, lo, [lo[0] + cell, lo[1] + cell]),
    }
}

/// The cell grid, scaled down to one premultiplied RGBA8 sample per cell.
fn scale_down(
    plane: &[Texel],
    width: usize,
    height: usize,
    plan: [f32; 3],
    grid: [i32; 4],
    filter: ScaleDown,
) -> Vec<[u8; 4]> {
    let [ax, ay, cell] = plan;
    let [x0, y0, cols, rows] = grid;
    let (cols, rows) = (cols as usize, rows as usize);
    let mut cells = Vec::with_capacity(cols * rows);
    for j in 0..rows {
        let lo_y = ay + ((y0 + j as i32) as f32) * cell;
        for i in 0..cols {
            let lo_x = ax + ((x0 + i as i32) as f32) * cell;
            let texel = cell_texel(plane, width, height, [lo_x, lo_y], cell, filter);
            cells.push(texel.map(to_u8));
        }
    }
    cells
}

/// The scaled-up color of the point `s` in cell units, where cell `j` spans `[j, j + 1)`.
fn up_texel(cells: &[Texel], cols: usize, rows: usize, s: [f32; 2], filter: ScaleUp) -> Texel {
    match filter {
        ScaleUp::NearestNeighbor => texel_at(
            cells,
            cols,
            rows,
            s[0].floor() as isize,
            s[1].floor() as isize,
        ),
        ScaleUp::Bilinear => sample(cells, cols, rows, s, EdgeMode::Clamp),
        ScaleUp::Bicubic => catmull_sample(cells, cols, rows, s),
    }
}

/// Pixelate of a straight-alpha RGBA8 image (FX-DIST-PIXELATE-03). `plan` is `[ax, ay, cell]` from
/// `pixelate_plan`, and `down` and `up` are the codes of `ScaleDown` and `ScaleUp`.
pub fn pixelate_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    plan: &[f32],
    down: u8,
    up: u8,
) -> Result<Vec<u8>, String> {
    let plan: [f32; 3] = plan
        .try_into()
        .map_err(|_| format!("a Pixelate plan needs 3 values, got {}", plan.len()))?;
    let down = ScaleDown::from_code(down)?;
    let up = ScaleUp::from_code(up)?;
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    if !(plan[2].is_finite() && plan[2] >= 1.0) {
        return Err(format!("cell size must be at least 1, got {}", plan[2]));
    }
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }
    let grid = pixelate_grid(width, height, plan);
    let [x0, y0, cols, rows] = grid;
    let (cols, rows) = (cols as usize, rows as usize);
    let plane = premultiply(src);
    let cells: Vec<Texel> = scale_down(&plane, width, height, plan, grid, down)
        .iter()
        .map(|cell| cell.map(|value| f32::from(value) / 255.0))
        .collect();
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let ux = (x as f32 + 0.5 - plan[0]) / plan[2] - x0 as f32;
            let uy = (y as f32 + 0.5 - plan[1]) / plan[2] - y0 as f32;
            let texel = up_texel(&cells, cols, rows, [ux, uy], up);
            push_straight(&mut out, texel);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_DOWN: [u8; 6] = [0, 1, 2, 3, 4, 5];
    const ALL_UP: [u8; 3] = [0, 1, 2];

    fn ramp(width: usize, height: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                out.extend_from_slice(&[
                    (x * 23 % 256) as u8,
                    (y * 47 % 256) as u8,
                    ((x + y) * 11 % 256) as u8,
                    255,
                ]);
            }
        }
        out
    }

    #[test]
    fn the_anchor_is_placed_over_the_region() {
        assert_eq!(
            pixelate_plan(40.0, 24.0, [0.0, 0.0], 8.0),
            [20.0, 12.0, 8.0]
        );
        assert_eq!(
            pixelate_plan(40.0, 24.0, [-1.0, 1.0], 8.0),
            [0.0, 24.0, 8.0]
        );
    }

    #[test]
    fn the_grid_holds_every_cell_a_pixel_center_falls_in() {
        assert_eq!(pixelate_grid(40, 24, [0.0, 0.0, 8.0]), [0, 0, 5, 3]);
        for anchor in [[0.0, 0.0], [0.3, -0.2], [-1.0, 1.0]] {
            for cell in [2.0f32, 5.0, 13.0] {
                let (w, h) = (37usize, 21usize);
                let plan = pixelate_plan(w as f32, h as f32, anchor, cell);
                let [x0, y0, cols, rows] = pixelate_grid(w, h, plan);
                for x in 0..w {
                    let k = ((x as f32 + 0.5 - plan[0]) / cell).floor() as i32 - x0;
                    assert!((0..cols).contains(&k), "x {x} cell {k}");
                }
                for y in 0..h {
                    let k = ((y as f32 + 0.5 - plan[1]) / cell).floor() as i32 - y0;
                    assert!((0..rows).contains(&k), "y {y} cell {k}");
                }
            }
        }
    }

    #[test]
    fn a_cell_of_one_pixel_returns_an_opaque_image_under_every_filter() {
        let src = ramp(7, 5);
        for down in ALL_DOWN {
            for up in ALL_UP {
                let out = pixelate_rgba8(&src, 7, 5, &[0.0, 0.0, 1.0], down, up).unwrap();
                assert_eq!(out, src, "down {down} up {up}");
            }
        }
    }

    #[test]
    fn uniform_images_stay_uniform_under_every_filter() {
        let src = [30u8, 60, 90, 255].repeat(11 * 9);
        for down in ALL_DOWN {
            for up in ALL_UP {
                let plan = pixelate_plan(11.0, 9.0, [0.2, -0.4], 3.0);
                let out = pixelate_rgba8(&src, 11, 9, &plan, down, up).unwrap();
                assert_eq!(out, src, "down {down} up {up}");
            }
        }
    }

    #[test]
    fn nearest_cells_are_flat_blocks_of_the_sample_at_their_center() {
        let mut src = Vec::new();
        for x in 0..8u8 {
            src.extend_from_slice(&[x * 30, 0, 0, 255]);
        }
        let out = pixelate_rgba8(&src, 8, 1, &[0.0, 0.0, 4.0], 0, 0).unwrap();
        // Cell 0 samples its center (x = 2, red 60), and cell 1 samples x = 6 (red 180).
        for x in 0..4 {
            assert_eq!(out[x * 4], 60);
        }
        for x in 4..8 {
            assert_eq!(out[x * 4], 180);
        }
    }

    #[test]
    fn an_anisotropic_cell_is_the_exact_average_of_its_pixels() {
        let src = [
            0u8, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
        ];
        let out = pixelate_rgba8(&src, 4, 1, &[0.0, 0.0, 2.0], 5, 0).unwrap();
        assert_eq!(out[0], 128, "{out:?}");
        assert_eq!(out[4], 128, "{out:?}");
        assert_eq!(out[8], 128);
        assert_eq!(out[12], 128);
    }

    #[test]
    fn transparent_images_stay_transparent() {
        let src = [200u8, 100, 50, 0].repeat(12);
        for down in ALL_DOWN {
            let out = pixelate_rgba8(&src, 4, 3, &[1.0, 1.0, 3.0], down, 2).unwrap();
            assert!(out.iter().all(|&v| v == 0), "down {down}");
        }
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        let src = ramp(2, 2);
        assert!(pixelate_rgba8(&src, 2, 2, &[0.0, 0.0], 0, 0).is_err());
        assert!(pixelate_rgba8(&src, 2, 2, &[0.0, 0.0, 2.0], 6, 0).is_err());
        assert!(pixelate_rgba8(&src, 2, 2, &[0.0, 0.0, 2.0], 0, 3).is_err());
        assert!(pixelate_rgba8(&src, 2, 2, &[0.0, 0.0, 0.5], 0, 0).is_err());
        assert!(pixelate_rgba8(&src, 3, 2, &[0.0, 0.0, 2.0], 0, 0).is_err());
    }
}
