//! Morphology (FX-DIST-MORPH): grayscale erode and dilate over a rectangular kernel. Each premultiplied
//! channel takes the minimum (Erode) or maximum (Dilate) over a window of `2·Width` × `2·Height`
//! pixels, centered on the pixel. The window is separable, so a horizontal pass and a vertical pass
//! each take a 1-D window. A 1-D window uses van Herk / Gil-Werman block extrema, so its cost does not
//! grow with the kernel. Outside the image the edge pixel repeats (Clamp).
//! `packages/effects/src/morphology-wgsl.ts` is the WGSL twin. It takes the window directly, which
//! gives the same result, because min and max are exact.

use crate::distort::{premultiply, push_straight, Texel};

/// The operation (FX-DIST-MORPH-02 Mode), by its code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Erode = 0,
    Dilate = 1,
}

impl Operation {
    pub fn from_code(code: u8) -> Result<Self, String> {
        match code {
            0 => Ok(Self::Erode),
            1 => Ok(Self::Dilate),
            other => Err(format!("morphology mode must be 0-1, got {other}")),
        }
    }

    fn combine(self, a: f32, b: f32) -> f32 {
        match self {
            Self::Erode => a.min(b),
            Self::Dilate => a.max(b),
        }
    }
}

/// The window extremum of one line. Output `i` combines `values[clamp(j)]` for `j` in
/// `i - half ..= i + half - 1`, a window of `2 · half` samples.
fn window_line(values: &[f32], half: usize, op: Operation) -> Vec<f32> {
    let n = values.len();
    let span = 2 * half;
    // Padded index `j` holds the sample at `j - half`, so output `i` covers padded `[i, i + span)`.
    let padded: Vec<f32> = (0..n + span - 1)
        .map(|j| values[(j as isize - half as isize).clamp(0, n as isize - 1) as usize])
        .collect();
    let m = padded.len();
    // `forward[j]` combines the block start up to `j`, and `backward[j]` combines `j` up to the block
    // end. A window of one block length spans at most two blocks, so the two extrema cover it.
    let mut forward = padded.clone();
    for j in 1..m {
        if j % span != 0 {
            forward[j] = op.combine(forward[j - 1], padded[j]);
        }
    }
    let mut backward = padded.clone();
    for j in (0..m - 1).rev() {
        if (j + 1) % span != 0 {
            backward[j] = op.combine(backward[j + 1], padded[j]);
        }
    }
    (0..n)
        .map(|i| op.combine(backward[i], forward[i + span - 1]))
        .collect()
}

/// One separable pass over every row (`horizontal`) or column of the premultiplied plane.
fn filter_axis(
    plane: &[Texel],
    width: usize,
    height: usize,
    half: usize,
    op: Operation,
    horizontal: bool,
) -> Vec<Texel> {
    let (lines, length) = if horizontal {
        (height, width)
    } else {
        (width, height)
    };
    let index = |line: usize, i: usize| {
        if horizontal {
            line * width + i
        } else {
            i * width + line
        }
    };
    let mut out = vec![[0.0f32; 4]; plane.len()];
    for line in 0..lines {
        for channel in 0..4 {
            let values: Vec<f32> = (0..length)
                .map(|i| plane[index(line, i)][channel])
                .collect();
            for (i, value) in window_line(&values, half, op).into_iter().enumerate() {
                out[index(line, i)][channel] = value;
            }
        }
    }
    out
}

/// Morphology of a straight-alpha RGBA8 image (FX-DIST-MORPH-03). `kernel` holds Width and Height,
/// and the window spans twice each. `op` is the mode code: 0 Erode, 1 Dilate.
pub fn morphology_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    kernel: [usize; 2],
    op: u8,
) -> Result<Vec<u8>, String> {
    let op = Operation::from_code(op)?;
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    if kernel.contains(&0) {
        return Err(format!(
            "kernel width and height must be at least 1, got {}x{}",
            kernel[0], kernel[1]
        ));
    }
    if width == 0 || height == 0 {
        return Ok(Vec::new());
    }
    let plane = premultiply(src);
    let rows = filter_axis(&plane, width, height, kernel[0], op, true);
    let filtered = filter_axis(&rows, width, height, kernel[1], op, false);
    let mut out = Vec::with_capacity(src.len());
    for texel in filtered {
        push_straight(&mut out, texel);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noisy(width: usize, height: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                let h = (x * 7919 + y * 104_729 + 13) % 251;
                let alpha = if (x + 2 * y) % 5 == 0 { 0 } else { 255 - (h % 40) as u8 };
                out.extend_from_slice(&[
                    (x * 37 % 256) as u8,
                    (y * 61 % 256) as u8,
                    h as u8,
                    alpha,
                ]);
            }
        }
        out
    }

    /// The window taken one pixel at a time, as the definition reads.
    fn brute_force(
        src: &[u8],
        width: usize,
        height: usize,
        kernel: [usize; 2],
        op: Operation,
    ) -> Vec<u8> {
        let plane = premultiply(src);
        let mut out = Vec::with_capacity(src.len());
        for y in 0..height {
            for x in 0..width {
                let mut acc: Option<Texel> = None;
                for dy in 0..2 * kernel[1] {
                    let sy = (y as isize - kernel[1] as isize + dy as isize)
                        .clamp(0, height as isize - 1) as usize;
                    for dx in 0..2 * kernel[0] {
                        let sx = (x as isize - kernel[0] as isize + dx as isize)
                            .clamp(0, width as isize - 1) as usize;
                        let texel = plane[sy * width + sx];
                        acc = Some(match acc {
                            None => texel,
                            Some(prev) => [0, 1, 2, 3].map(|c| op.combine(prev[c], texel[c])),
                        });
                    }
                }
                push_straight(&mut out, acc.unwrap());
            }
        }
        out
    }

    #[test]
    fn the_windows_match_a_brute_force_definition() {
        let (w, h) = (13usize, 9usize);
        let src = noisy(w, h);
        for kernel in [[1, 1], [2, 3], [5, 5], [7, 2], [13, 4], [20, 1]] {
            for op in [0u8, 1] {
                let expected = brute_force(&src, w, h, kernel, Operation::from_code(op).unwrap());
                let out = morphology_rgba8(&src, w, h, kernel, op).unwrap();
                assert_eq!(out, expected, "kernel {kernel:?} op {op}");
            }
        }
    }

    #[test]
    fn the_line_window_handles_block_boundaries() {
        let values = [1.0, 5.0, 2.0, 8.0, 3.0];
        let dilate = window_line(&values, 1, Operation::Dilate);
        assert_eq!(dilate, [1.0, 5.0, 5.0, 8.0, 8.0]);
        let erode = window_line(&values, 1, Operation::Erode);
        assert_eq!(erode, [1.0, 1.0, 2.0, 2.0, 3.0]);
    }

    #[test]
    fn a_dilated_pixel_grows_to_the_window_it_falls_in() {
        let (w, h) = (7usize, 7usize);
        let mut src = [0u8, 0, 0, 255].repeat(w * h);
        src[(3 * w + 3) * 4..(3 * w + 3) * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
        let out = morphology_rgba8(&src, w, h, [1, 1], 1).unwrap();
        for y in 0..h {
            for x in 0..w {
                let lit = (3..=4).contains(&x) && (3..=4).contains(&y);
                let at = (y * w + x) * 4;
                let expected = if lit { 255 } else { 0 };
                assert_eq!(out[at], expected, "x {x} y {y}");
            }
        }
    }

    #[test]
    fn erode_removes_a_pixel_narrower_than_the_kernel() {
        let (w, h) = (7usize, 7usize);
        let mut src = [0u8, 0, 0, 255].repeat(w * h);
        src[(3 * w + 3) * 4..(3 * w + 3) * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
        let out = morphology_rgba8(&src, w, h, [1, 1], 0).unwrap();
        assert!(out.as_chunks::<4>().0.iter().all(|px| px[0] == 0 && px[3] == 255));
    }

    #[test]
    fn dilate_grows_the_alpha_of_a_transparent_edge() {
        let mut src = [0u8; 20];
        src[8..12].copy_from_slice(&[200, 0, 0, 255]);
        let out = morphology_rgba8(&src, 5, 1, [1, 1], 1).unwrap();
        let alpha: Vec<u8> = out.as_chunks::<4>().0.iter().map(|px| px[3]).collect();
        assert_eq!(alpha, [0, 0, 255, 255, 0]);
    }

    #[test]
    fn uniform_images_are_unchanged_by_either_mode() {
        let src = [30u8, 60, 90, 255].repeat(11 * 9);
        for op in [0u8, 1] {
            let out = morphology_rgba8(&src, 11, 9, [4, 3], op).unwrap();
            assert_eq!(out, src, "op {op}");
        }
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        let src = noisy(2, 2);
        assert!(morphology_rgba8(&src, 2, 2, [1, 1], 2).is_err());
        assert!(morphology_rgba8(&src, 2, 2, [0, 1], 1).is_err());
        assert!(morphology_rgba8(&src, 3, 2, [1, 1], 1).is_err());
    }
}
