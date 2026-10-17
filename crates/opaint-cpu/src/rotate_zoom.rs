//! Rotate / Zoom (FX-NOSUB-ROTZOOM-01): the layer rolls in 3-D, then pans, zooms and tiles. The layer
//! is a plane in front of a pinhole camera, `focal` away, where `focal` is the larger side of the
//! region. The roll turns the plane by its tilt (`amount`) about an in-plane axis at the tilt
//! direction, and then by `angle` about the view axis. Each output pixel casts a ray through the
//! camera, finds where it meets the plane, and reads the layer there with bilinear or nearest
//! sampling. Rays that miss the plane, and reads outside the source under the None tiling, are
//! transparent. The Quality averages `Quality²` rotated-grid offsets, as the distortion engine does.
//! `packages/effects/src/rotate-zoom-wgsl.ts` is the WGSL twin and runs the same f32 operations in
//! the same order.

use crate::distort::{premultiply, push_straight, rgss_offsets, sample, tap, EdgeMode, Texel};

/// The values of a plan: the 3x3 rotation (row-major), the focal length, the pan in pixels and the zoom.
pub const PLAN_LEN: usize = 13;

/// The largest pan on each axis, in pan units (FX-NOSUB-ROTZOOM-01). Ten units span half the region.
const PAN_LIMIT: f32 = 10.0;
const ZOOM_MIN: f32 = 0.06;
const ZOOM_MAX: f32 = 16.0;

/// Rays whose plane point lies farther than this from the origin read as transparent. Rays that
/// graze the horizon would otherwise overflow the integer taps.
const FAR_LIMIT: f32 = 1.0e6;
/// A ray whose denominator is below this runs parallel to the plane.
const PARALLEL_LIMIT: f32 = 1.0e-7;

type Mat3 = [[f64; 3]; 3];

fn multiply(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

/// The rotation by `angle` radians about a unit `axis` (Rodrigues' formula).
fn rotation_about(axis: [f64; 3], angle: f64) -> Mat3 {
    let (sin, cos) = angle.sin_cos();
    let t = 1.0 - cos;
    let [x, y, z] = axis;
    [
        [t * x * x + cos, t * x * y - sin * z, t * x * z + sin * y],
        [t * x * y + sin * z, t * y * y + cos, t * y * z - sin * x],
        [t * x * z - sin * y, t * y * z + sin * x, t * z * z + cos],
    ]
}

/// The plan of a Rotate / Zoom over a `width` x `height` region. `roll` is `[angle, direction,
/// tilt]` in degrees (-180..=180, -180..=180 and 0..=90), `pan` is `[x, y]` in pan units (-10..=10),
/// and `zoom` is 0.06..=16. Requires finite values.
pub fn rotate_zoom_plan(
    width: usize,
    height: usize,
    roll: [f32; 3],
    pan: [f32; 2],
    zoom: f32,
) -> Result<[f32; PLAN_LEN], String> {
    if width == 0 || height == 0 {
        return Err("the region must not be empty".to_owned());
    }
    let [angle, direction, tilt] = roll;
    if !(-180.0..=180.0).contains(&angle)
        || !(-180.0..=180.0).contains(&direction)
        || !(0.0..=90.0).contains(&tilt)
    {
        return Err("the roll must be -180..180, -180..180 and 0..90 degrees".to_owned());
    }
    if !(-PAN_LIMIT..=PAN_LIMIT).contains(&pan[0]) || !(-PAN_LIMIT..=PAN_LIMIT).contains(&pan[1]) {
        return Err("the pan must be -10..10 on each axis".to_owned());
    }
    if !(ZOOM_MIN..=ZOOM_MAX).contains(&zoom) {
        return Err("the zoom must be 0.06..16".to_owned());
    }
    let tilt_direction = f64::from(direction).to_radians();
    let tilt_axis = [tilt_direction.cos(), tilt_direction.sin(), 0.0];
    let tilted = rotation_about(tilt_axis, f64::from(tilt).to_radians());
    let rolled = multiply(
        &rotation_about([0.0, 0.0, 1.0], f64::from(angle).to_radians()),
        &tilted,
    );
    let mut plan = [0.0f32; PLAN_LEN];
    for (slot, value) in plan.iter_mut().zip(rolled.iter().flatten()) {
        *slot = *value as f32;
    }
    let half_width = width as f64 / 2.0;
    let half_height = height as f64 / 2.0;
    plan[9] = width.max(height) as f32;
    plan[10] = (f64::from(pan[0]) / f64::from(PAN_LIMIT) * half_width) as f32;
    plan[11] = (f64::from(pan[1]) / f64::from(PAN_LIMIT) * half_height) as f32;
    plan[12] = zoom;
    Ok(plan)
}

/// Where the ray through `scene` (a region pixel position) meets the layer, as continuous source
/// coordinates, or `None` when it misses. The operations match `rotate_zoom.wgsl` in order.
fn source_position(plan: &[f32; PLAN_LEN], size: [f32; 2], scene: [f32; 2]) -> Option<[f32; 2]> {
    let focal = plan[9];
    let qx = (scene[0] - size[0] / 2.0 - plan[10]) / plan[12];
    let qy = (scene[1] - size[1] / 2.0 - plan[11]) / plan[12];
    let (rx, ry) = (qx / focal, qy / focal);
    // The plane's normal is the third column of the rotation, and the plane is `focal` away.
    let denom = plan[2] * rx + plan[5] * ry + plan[8];
    if denom.abs() < PARALLEL_LIMIT {
        return None;
    }
    let t = plan[8] * focal / denom;
    if t.is_nan() || t <= 0.0 {
        return None;
    }
    let (x, y, z) = (t * rx, t * ry, t - focal);
    let u = plan[0] * x + plan[3] * y + plan[6] * z + size[0] / 2.0;
    let v = plan[1] * x + plan[4] * y + plan[7] * z + size[1] / 2.0;
    let inside = u.abs() <= FAR_LIMIT && v.abs() <= FAR_LIMIT;
    if inside {
        Some([u, v])
    } else {
        None
    }
}

/// The nearest texel at a continuous source position, under the edge mode.
fn nearest_texel(
    plane: &[Texel],
    width: usize,
    height: usize,
    s: [f32; 2],
    edge: EdgeMode,
) -> Texel {
    tap(
        plane,
        width,
        height,
        s[0].floor() as isize,
        s[1].floor() as isize,
        edge,
    )
    .unwrap_or([0.0; 4])
}

/// Rotate / Zoom of a straight-alpha RGBA8 region. `plan` is from `rotate_zoom_plan`. `quality` is
/// 1-8, `sampling` is 0 for Bilinear and 1 for Nearest Neighbor, and `tiling` is 0 for None
/// (transparent), 1 for Repeat and 2 for Mirror.
pub fn rotate_zoom_rgba8(
    src: &[u8],
    width: usize,
    height: usize,
    plan: &[f32],
    quality: u8,
    sampling: u8,
    tiling: u8,
) -> Result<Vec<u8>, String> {
    if src.len() != width * height * 4 {
        return Err(format!("source must be {width}x{height} RGBA8"));
    }
    let plan: &[f32; PLAN_LEN] = plan
        .try_into()
        .map_err(|_| format!("the plan must hold {PLAN_LEN} values"))?;
    let nearest = match sampling {
        0 => false,
        1 => true,
        other => return Err(format!("sampling must be 0 or 1, got {other}")),
    };
    let edge = match tiling {
        0 => EdgeMode::Transparent,
        1 => EdgeMode::Wrap,
        2 => EdgeMode::Reflect,
        other => return Err(format!("tiling must be 0-2, got {other}")),
    };
    let offsets = rgss_offsets(quality)?;
    let plane = premultiply(src);
    let size = [width as f32, height as f32];
    let count = offsets.len() as f32;
    let mut out = Vec::with_capacity(src.len());
    for y in 0..height {
        for x in 0..width {
            let mut acc = [0.0f32; 4];
            for offset in &offsets {
                let scene = [x as f32 + 0.5 + offset[0], y as f32 + 0.5 + offset[1]];
                let Some(source) = source_position(plan, size, scene) else {
                    continue;
                };
                let texel = if nearest {
                    nearest_texel(&plane, width, height, source, edge)
                } else {
                    sample(&plane, width, height, source, edge)
                };
                for (total, value) in acc.iter_mut().zip(texel) {
                    *total += value;
                }
            }
            push_straight(&mut out, acc.map(|total| total / count));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(width: usize, height: usize, alpha: u8) -> Vec<u8> {
        let mut px = Vec::new();
        for y in 0..height {
            for x in 0..width {
                px.extend([
                    (x * 37 % 256) as u8,
                    (y * 53 % 256) as u8,
                    ((x + y) * 11 % 256) as u8,
                    alpha,
                ]);
            }
        }
        px
    }

    /// Renders at Quality 1. `modes` is `(sampling, tiling)`.
    fn render(
        src: &[u8],
        (width, height): (usize, usize),
        (roll, pan, zoom): ([f32; 3], [f32; 2], f32),
        (sampling, tiling): (u8, u8),
    ) -> Vec<u8> {
        let plan = rotate_zoom_plan(width, height, roll, pan, zoom).unwrap();
        rotate_zoom_rgba8(src, width, height, &plan, 1, sampling, tiling).unwrap()
    }

    #[test]
    fn the_plan_is_the_identity_at_rest() {
        let plan = rotate_zoom_plan(40, 24, [0.0; 3], [0.0; 2], 1.0).unwrap();
        assert_eq!(
            plan,
            [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 40.0, 0.0, 0.0, 1.0]
        );
    }

    #[test]
    fn rest_reproduces_the_image_for_every_sampling_and_tiling() {
        let src = gradient(5, 4, 255);
        for sampling in 0..=1 {
            for tiling in 0..=2 {
                let out = render(&src, (5, 4), ([0.0; 3], [0.0; 2], 1.0), (sampling, tiling));
                assert_eq!(out, src, "sampling {sampling}, tiling {tiling}");
            }
        }
    }

    #[test]
    fn a_quarter_turn_maps_pixels_exactly_with_nearest_neighbor() {
        // Destination (x, y) reads source (y, N - 1 - x) for a 90 degree roll of a square image.
        let size = 3;
        let src = gradient(size, size, 255);
        let out = render(
            &src,
            (size, size),
            ([90.0, 0.0, 0.0], [0.0; 2], 1.0),
            (1, 0),
        );
        for y in 0..size {
            for x in 0..size {
                let from = ((size - 1 - x) * size + y) * 4;
                let to = (y * size + x) * 4;
                assert_eq!(&out[to..to + 4], &src[from..from + 4], "({x}, {y})");
            }
        }
    }

    #[test]
    fn pan_moves_the_layer_and_leaves_the_gap_transparent() {
        // A pan of 10 units moves the layer by half its width to the right.
        let src = gradient(8, 4, 255);
        let out = render(&src, (8, 4), ([0.0; 3], [10.0, 0.0], 1.0), (1, 0));
        for y in 0..4 {
            for x in 0..8 {
                let to = (y * 8 + x) * 4;
                if x < 4 {
                    assert_eq!(out[to + 3], 0, "({x}, {y}) should be the gap");
                } else {
                    let from = (y * 8 + (x - 4)) * 4;
                    assert_eq!(&out[to..to + 4], &src[from..from + 4], "({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn zoom_scales_about_the_center() {
        // Zoom 2 reads the source at the center plus half the offset from the center.
        let size = 4;
        let src = gradient(size, size, 255);
        let out = render(&src, (size, size), ([0.0; 3], [0.0; 2], 2.0), (1, 0));
        let source_of = |v: usize| ((v as f32 + 0.5 - 2.0) / 2.0 + 2.0).floor() as usize;
        for y in 0..size {
            for x in 0..size {
                let from = (source_of(y) * size + source_of(x)) * 4;
                let to = (y * size + x) * 4;
                assert_eq!(&out[to..to + 4], &src[from..from + 4], "({x}, {y})");
            }
        }
    }

    #[test]
    fn a_tilt_leaves_transparent_corners_only_under_none() {
        let src = gradient(8, 8, 255);
        let tilted = ([0.0, 0.0, 45.0], [0.0; 2], 1.0);
        let none = render(&src, (8, 8), tilted, (0, 0));
        assert!(none.as_chunks::<4>().0.iter().any(|px| px[3] == 0));
        for tiling in [1, 2] {
            let tiled = render(&src, (8, 8), tilted, (0, tiling));
            assert!(tiled.as_chunks::<4>().0.iter().all(|px| px[3] == 255));
        }
    }

    #[test]
    fn rejects_bad_plans_inputs_and_modes() {
        assert!(rotate_zoom_plan(0, 4, [0.0; 3], [0.0; 2], 1.0).is_err());
        assert!(rotate_zoom_plan(4, 4, [200.0, 0.0, 0.0], [0.0; 2], 1.0).is_err());
        assert!(rotate_zoom_plan(4, 4, [0.0, 0.0, 95.0], [0.0; 2], 1.0).is_err());
        assert!(rotate_zoom_plan(4, 4, [0.0; 3], [11.0, 0.0], 1.0).is_err());
        assert!(rotate_zoom_plan(4, 4, [0.0; 3], [0.0; 2], 0.05).is_err());
        assert!(rotate_zoom_plan(4, 4, [f32::NAN, 0.0, 0.0], [0.0; 2], 1.0).is_err());
        let plan = rotate_zoom_plan(4, 4, [0.0; 3], [0.0; 2], 1.0).unwrap();
        let src = gradient(4, 4, 255);
        assert!(rotate_zoom_rgba8(&src, 4, 4, &plan[..12], 1, 0, 0).is_err());
        assert!(rotate_zoom_rgba8(&src, 4, 4, &plan, 1, 2, 0).is_err());
        assert!(rotate_zoom_rgba8(&src, 4, 4, &plan, 1, 0, 3).is_err());
        assert!(rotate_zoom_rgba8(&src, 4, 4, &plan, 0, 0, 0).is_err());
        assert!(rotate_zoom_rgba8(&src[..8], 4, 4, &plan, 1, 0, 0).is_err());
    }
}
