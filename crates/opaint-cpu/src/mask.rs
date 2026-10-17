//! Polygon-set rasterization for selection masks (DOC-SEL-01, DOC-SEL-03).
//!
//! Rings are closed lists of `x, y` pairs in pixel units, combined with the even-odd rule.
//! Aliased masks sample each pixel center once, so a pixel is selected when its center is inside.
//! Antialiased masks store the covered fraction of each pixel, scaled to 0-255. Horizontal coverage
//! is exact on every sub-scanline, and `SUBSAMPLES` evenly spaced sub-scanlines per row sample the
//! vertical extent.

/// Sub-scanlines per pixel row for antialiased masks. A power of two, so every weight is exact.
const SUBSAMPLES: usize = 16;

#[derive(Clone, Copy)]
struct Edge {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
}

/// Rasterizes the even-odd fill of a polygon set into a row-major `width` x `height` mask with one
/// byte per pixel. `coords` holds every ring's `x, y` pairs in order, and `counts[i]` is the vertex
/// count of ring `i`. Rings with fewer than three vertices contribute nothing.
pub fn rasterize_polygons(
    coords: &[f64],
    counts: &[u32],
    width: usize,
    height: usize,
    antialiased: bool,
) -> Result<Vec<u8>, String> {
    let vertices: usize = counts.iter().map(|&n| n as usize).sum();
    if coords.len() != vertices * 2 {
        return Err("polygon coordinates do not match the vertex counts".to_string());
    }
    if coords.iter().any(|v| !v.is_finite()) {
        return Err("polygon coordinates must be finite".to_string());
    }
    let mut mask = vec![0u8; width * height];
    let edges = ring_edges(coords, counts);
    if edges.is_empty() || width == 0 {
        return Ok(mask);
    }

    let samples = if antialiased { SUBSAMPLES } else { 1 };
    let weight = 1.0 / samples as f64;
    let max_x = width as f64;
    let mut coverage = vec![0.0f64; width];
    let mut interior = vec![0.0f64; width + 1];
    let mut crossings = Vec::new();
    for row in 0..height {
        let out = &mut mask[row * width..(row + 1) * width];
        coverage.fill(0.0);
        interior.fill(0.0);
        for sample in 0..samples {
            let y = row as f64 + (sample as f64 + 0.5) * weight;
            crossings_at(&edges, y, &mut crossings);
            for pair in crossings.as_chunks::<2>().0 {
                let a = pair[0].clamp(0.0, max_x);
                let b = pair[1].clamp(0.0, max_x);
                if a >= b {
                    continue;
                }
                if antialiased {
                    add_span(&mut coverage, &mut interior, a, b, weight);
                } else {
                    let start = (a - 0.5).ceil() as usize;
                    let end = ((b - 0.5).ceil() as usize).min(width);
                    if start < end {
                        out[start..end].fill(255);
                    }
                }
            }
        }
        if antialiased {
            let mut running = 0.0;
            for ((px, &partial), &full) in out.iter_mut().zip(&coverage).zip(&interior) {
                running += full;
                let value = ((partial + running) * 255.0 + 0.5)
                    .floor()
                    .clamp(0.0, 255.0);
                *px = value as u8;
            }
        }
    }
    Ok(mask)
}

/// Non-horizontal edges of every ring with at least three vertices, closing each ring.
fn ring_edges(coords: &[f64], counts: &[u32]) -> Vec<Edge> {
    let mut edges = Vec::new();
    let mut start = 0;
    for &count in counts {
        let n = count as usize;
        if n >= 3 {
            let points = coords[start * 2..(start + n) * 2].as_chunks::<2>().0;
            for (i, p) in points.iter().enumerate() {
                let q = points[(i + 1) % n];
                if p[1] != q[1] {
                    edges.push(Edge {
                        x0: p[0],
                        y0: p[1],
                        x1: q[0],
                        y1: q[1],
                    });
                }
            }
        }
        start += n;
    }
    edges
}

/// Sorted x positions where the horizontal line at `y` crosses the edges. Each edge counts on
/// `[top, bottom)`, so a vertex shared by two edges is counted once.
fn crossings_at(edges: &[Edge], y: f64, out: &mut Vec<f64>) {
    out.clear();
    for e in edges {
        let (top, bottom) = if e.y0 < e.y1 {
            (e.y0, e.y1)
        } else {
            (e.y1, e.y0)
        };
        if y >= top && y < bottom {
            out.push(e.x0 + (y - e.y0) * (e.x1 - e.x0) / (e.y1 - e.y0));
        }
    }
    out.sort_by(f64::total_cmp);
}

/// Adds the horizontal span `[a, b)` of one sub-scanline. Partial end pixels go to `coverage`,
/// and the full pixels between them go through the `interior` difference array.
fn add_span(coverage: &mut [f64], interior: &mut [f64], a: f64, b: f64, weight: f64) {
    let first = a.floor() as usize;
    let last = b.floor() as usize;
    if first == last {
        coverage[first] += (b - a) * weight;
        return;
    }
    coverage[first] += (first as f64 + 1.0 - a) * weight;
    if last < coverage.len() {
        coverage[last] += (b - last as f64) * weight;
    }
    if first + 1 < last {
        interior[first + 1] += weight;
        interior[last] -= weight;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raster(rings: &[&[f64]], width: usize, height: usize, aa: bool) -> Vec<u8> {
        let coords: Vec<f64> = rings.iter().flat_map(|r| r.iter().copied()).collect();
        let counts: Vec<u32> = rings.iter().map(|r| (r.len() / 2) as u32).collect();
        rasterize_polygons(&coords, &counts, width, height, aa).unwrap()
    }

    #[test]
    fn fractional_vertical_edges_give_exact_coverage() {
        // x from 1.5 to 3.25 covers half of column 1, all of column 2 and a quarter of column 3.
        let rect: &[f64] = &[1.5, 0.0, 3.25, 0.0, 3.25, 2.0, 1.5, 2.0];
        assert_eq!(
            raster(&[rect], 4, 2, true),
            [0, 128, 255, 64, 0, 128, 255, 64]
        );
    }

    #[test]
    fn fractional_horizontal_edges_give_exact_coverage() {
        // Rows from 0.25 to 1.0 cover 12 of the 16 sub-scanlines.
        let rect: &[f64] = &[0.0, 0.25, 1.0, 0.25, 1.0, 1.0, 0.0, 1.0];
        assert_eq!(raster(&[rect], 1, 1, true), [191]);
    }

    #[test]
    fn aliased_samples_pixel_centers_of_a_triangle() {
        let triangle: &[f64] = &[0.0, 0.0, 4.0, 0.0, 0.0, 4.0];
        assert_eq!(
            raster(&[triangle], 4, 4, false),
            [255, 255, 255, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0]
        );
    }

    #[test]
    fn even_odd_fill_leaves_a_hole() {
        let outer: &[f64] = &[0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0];
        let inner: &[f64] = &[1.0, 1.0, 3.0, 1.0, 3.0, 3.0, 1.0, 3.0];
        assert_eq!(
            raster(&[outer, inner], 4, 4, false),
            [
                255, 255, 255, 255, //
                255, 0, 0, 255, //
                255, 0, 0, 255, //
                255, 255, 255, 255,
            ]
        );
        let aa = raster(&[outer, inner], 4, 4, true);
        assert_eq!(aa[5], 0);
        assert_eq!(aa[0], 255);
    }

    #[test]
    fn fully_covered_pixels_are_255_and_outside_is_zero() {
        let square: &[f64] = &[0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0];
        let mask = raster(&[square], 6, 4, true);
        for row in mask.chunks(6) {
            assert_eq!(row, [255, 255, 255, 255, 0, 0]);
        }
    }

    #[test]
    fn empty_and_degenerate_rings_select_nothing() {
        assert_eq!(raster(&[], 3, 2, true), [0; 6]);
        assert_eq!(raster(&[&[0.0, 0.0, 2.0, 2.0]], 3, 2, false), [0; 6]);
    }

    #[test]
    fn rejects_mismatched_or_non_finite_input() {
        assert!(rasterize_polygons(&[0.0, 0.0], &[3], 1, 1, true).is_err());
        assert!(
            rasterize_polygons(&[f64::NAN, 0.0, 1.0, 0.0, 0.0, 1.0], &[3], 1, 1, true).is_err()
        );
    }

    #[test]
    fn zero_sized_mask_is_empty() {
        let square: &[f64] = &[0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 4.0];
        assert!(raster(&[square], 0, 4, true).is_empty());
    }
}
