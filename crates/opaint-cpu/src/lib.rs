use wasm_bindgen::prelude::*;

pub mod adjust;
pub mod align;
pub mod artistic;
pub mod avif;
pub mod blend;
pub mod blur;
pub mod bmff;
pub mod bmp;
pub mod bokeh;
pub mod brush;
pub mod brush_field;
pub mod bucket;
pub mod clone_stamp;
pub mod clouds;
pub mod fractal;
pub mod dds;
pub mod directional_blur;
pub mod radial_zoom_blur;
pub mod distort;
pub mod flip;
pub mod gif;
pub mod gradient;
pub mod ifd;
pub mod jpeg;
pub mod jxl;
pub mod lz4;
pub mod magic_wand;
pub mod mask;
pub mod mix;
pub mod morphology;
pub mod neighborhood_blur;
pub mod noise;
pub mod object;
pub mod pencil;
pub mod photo;
pub mod pixelate;
pub mod png;
pub mod png_decode;
pub mod quantize;
pub mod recolor;
pub mod resample;
pub mod rng;
pub mod rotate_zoom;
pub mod srgb;
pub mod stylize;
pub mod tga;
pub mod tiff;
pub mod transform;
pub mod turbulence;
pub mod webp;

/// Compresses bytes into an LZ4 block (see `lz4`) for history spill (ARC-05-01).
#[wasm_bindgen]
pub fn lz4_compress(src: &[u8]) -> Vec<u8> {
    lz4::compress(src)
}

/// Decompresses an LZ4 block that must expand to exactly `uncompressed_len` bytes.
#[wasm_bindgen]
pub fn lz4_decompress(src: &[u8], uncompressed_len: u32) -> Result<Vec<u8>, JsError> {
    lz4::decompress(src, uncompressed_len as usize).map_err(|message| JsError::new(&message))
}

/// Gaussian blur of a straight-alpha RGBA8 image (FX-BLUR-GAUSS, see `blur`). Returns the new
/// pixels; `radius` 0 returns them unchanged.
#[wasm_bindgen]
pub fn gaussian_blur_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    radius: f32,
    gamma_boost: f32,
    quality: u8,
) -> Result<Vec<u8>, JsError> {
    blur::blur_rgba8(
        src,
        width as usize,
        height as usize,
        radius,
        gamma_boost,
        quality,
    )
    .map_err(|message| JsError::new(&message))
}

/// The 1-D Gaussian weights shared by the reference and the WGSL twin: `2R + 1` values for
/// `R = ceil(3 sigma)`, normalized to sum 1.
#[wasm_bindgen]
pub fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    blur::kernel(sigma)
}

/// Downsample factor the blur uses before blurring at `quality` and `sigma` (1 = none).
#[wasm_bindgen]
pub fn gaussian_downsample_factor(quality: u8, sigma: f32) -> u32 {
    blur::downsample_factor(quality, sigma) as u32
}

/// The Square Blur box weights for `radius` (FX-BLUR-SQUARE-03), shared with the WGSL twin.
#[wasm_bindgen]
pub fn box_kernel(radius: f32) -> Vec<f32> {
    blur::box_kernel(radius)
}

/// Square Blur (FX-BLUR-SQUARE) of a straight-alpha RGBA8 image (see `blur::box_blur_rgba8`).
/// Returns the new pixels; `radius` 0 returns them unchanged.
#[wasm_bindgen]
pub fn box_blur_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    radius: f32,
    gamma_boost: f32,
) -> Result<Vec<u8>, JsError> {
    blur::box_blur_rgba8(src, width as usize, height as usize, radius, gamma_boost)
        .map_err(|message| JsError::new(&message))
}

/// The Bokeh Blur tap half-width for `radius` (FX-BLUR-BOKEH-03), shared with the WGSL twin.
#[wasm_bindgen]
pub fn bokeh_half_width(radius: f32) -> u32 {
    bokeh::half_width(radius) as u32
}

/// The Bokeh Blur kernel (FX-BLUR-BOKEH-03): the vertical weights, then the horizontal weights, of
/// each term as `re, im` pairs (see `bokeh::Plan::flatten`). Shared with the WGSL twin.
#[wasm_bindgen]
pub fn bokeh_plan(radius: f32, quality: u8) -> Result<Vec<f32>, JsError> {
    bokeh::plan_values(radius, quality).map_err(|message| JsError::new(&message))
}

/// Bokeh Blur (FX-BLUR-BOKEH) of a straight-alpha RGBA8 image (see `bokeh::bokeh_blur_rgba8`).
#[wasm_bindgen]
pub fn bokeh_blur_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    radius: f32,
    gamma_boost: f32,
    quality: u8,
) -> Result<Vec<u8>, JsError> {
    bokeh::bokeh_blur_rgba8(
        src,
        width as usize,
        height as usize,
        radius,
        gamma_boost,
        quality,
    )
    .map_err(|message| JsError::new(&message))
}

/// The Sketch Blur scan offsets (FX-BLUR-SKETCH-03), flattened to `dx, dy` pairs.
#[wasm_bindgen]
pub fn sketch_offsets(radius: f32, smoothness: u32) -> Result<Vec<i32>, JsError> {
    neighborhood_blur::sketch_offsets(radius, smoothness).map_err(|message| JsError::new(&message))
}

/// The Sketch Blur P² constants for a percentile (FX-BLUR-SKETCH-03), as the 11 values of
/// `neighborhood_blur::sketch_plan`.
#[wasm_bindgen]
pub fn sketch_plan(percentile: u32) -> Result<Vec<i32>, JsError> {
    neighborhood_blur::sketch_plan(percentile)
        .map(|plan| plan.to_vec())
        .map_err(|message| JsError::new(&message))
}

/// Sketch Blur (FX-BLUR-SKETCH) of a straight-alpha RGBA8 image.
#[wasm_bindgen]
pub fn sketch_blur_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    radius: f32,
    percentile: u32,
    smoothness: u32,
) -> Result<Vec<u8>, JsError> {
    neighborhood_blur::sketch_blur_rgba8(
        src,
        width as usize,
        height as usize,
        radius,
        percentile,
        smoothness,
    )
    .map_err(|message| JsError::new(&message))
}

/// The rotated-grid sub-pixel offsets of the distortion engine (FX-A-00-04), flattened to x, y pairs.
#[wasm_bindgen]
pub fn rgss_offsets(quality: u8) -> Result<Vec<f32>, JsError> {
    distort::rgss_offsets(quality)
        .map(|offsets| offsets.iter().flatten().copied().collect())
        .map_err(|message| JsError::new(&message))
}

/// The distortion engine with an affine sample map (`matrix` = a, b, c, d, e, f), reading the
/// premultiplied source with bilinear filtering and `edge` 0-3 (see `distort`).
#[wasm_bindgen]
pub fn distort_affine_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    edge: u8,
    matrix: &[f32],
) -> Result<Vec<u8>, JsError> {
    let edge = distort::EdgeMode::from_code(edge).map_err(|message| JsError::new(&message))?;
    distort::distort_affine_rgba8(
        src,
        width as usize,
        height as usize,
        quality,
        edge,
        matrix,
    )
    .map_err(|message| JsError::new(&message))
}

/// The Bulge plan of a `width` × `height` region (FX-DIST-BULGE-03): `[cx, cy, radius, strength]`.
#[wasm_bindgen]
pub fn bulge_plan(
    width: f32,
    height: f32,
    center: &[f32],
    strength: f32,
) -> Result<Vec<f32>, JsError> {
    Ok(distort::bulge_plan(width, height, pair(center, "center")?, strength).to_vec())
}

/// The Twist plan (FX-DIST-TWIST-03): `[cx, cy, limit, gain]`. `document` is the document's
/// `[width, height]`, which scales the Size.
#[wasm_bindgen]
pub fn twist_plan(
    width: f32,
    height: f32,
    document: &[f32],
    center: &[f32],
    amount: f32,
    size: f32,
) -> Result<Vec<f32>, JsError> {
    Ok(distort::twist_plan(
        width,
        height,
        pair(document, "document")?,
        pair(center, "center")?,
        amount,
        size,
    )
    .to_vec())
}

/// Bulge through the distortion engine (FX-DIST-BULGE), with the plan from `bulge_plan`.
#[wasm_bindgen]
pub fn bulge_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    edge: u8,
    plan: &[f32],
) -> Result<Vec<u8>, JsError> {
    let edge = distort::EdgeMode::from_code(edge).map_err(|message| JsError::new(&message))?;
    distort::bulge_rgba8(src, width as usize, height as usize, quality, edge, plan)
        .map_err(|message| JsError::new(&message))
}

/// Twist through the distortion engine (FX-DIST-TWIST), with the plan from `twist_plan`.
#[wasm_bindgen]
pub fn twist_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    edge: u8,
    plan: &[f32],
) -> Result<Vec<u8>, JsError> {
    let edge = distort::EdgeMode::from_code(edge).map_err(|message| JsError::new(&message))?;
    distort::twist_rgba8(src, width as usize, height as usize, quality, edge, plan)
        .map_err(|message| JsError::new(&message))
}

/// The Polar Inversion plan (FX-DIST-POLAR-03): `[cx, cy, radius, scale]`. `document` is the
/// document's `[width, height]`, which scales the Scale.
#[wasm_bindgen]
pub fn polar_plan(
    width: f32,
    height: f32,
    document: &[f32],
    center: &[f32],
    scale: f32,
) -> Result<Vec<f32>, JsError> {
    Ok(distort::polar_plan(
        width,
        height,
        pair(document, "document")?,
        pair(center, "center")?,
        scale,
    )
    .to_vec())
}

/// Polar Inversion through the distortion engine (FX-DIST-POLAR), with the plan from `polar_plan`.
#[wasm_bindgen]
pub fn polar_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    edge: u8,
    plan: &[f32],
) -> Result<Vec<u8>, JsError> {
    let edge = distort::EdgeMode::from_code(edge).map_err(|message| JsError::new(&message))?;
    distort::polar_rgba8(src, width as usize, height as usize, quality, edge, plan)
        .map_err(|message| JsError::new(&message))
}

/// The Tile Reflection plan (FX-DIST-TILE-03): `[ox, oy, cos, sin, k, lambda]`. `origin` is the
/// center of the source bounds in region coordinates.
#[wasm_bindgen]
pub fn tile_plan(
    origin: &[f32],
    angle: f32,
    tile_size: f32,
    curvature: f32,
) -> Result<Vec<f32>, JsError> {
    Ok(distort::tile_plan(pair(origin, "origin")?, angle, tile_size, curvature).to_vec())
}

/// Tile Reflection through the distortion engine (FX-DIST-TILE), with the plan from `tile_plan`.
#[wasm_bindgen]
pub fn tile_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    edge: u8,
    plan: &[f32],
) -> Result<Vec<u8>, JsError> {
    let edge = distort::EdgeMode::from_code(edge).map_err(|message| JsError::new(&message))?;
    distort::tile_rgba8(src, width as usize, height as usize, quality, edge, plan)
        .map_err(|message| JsError::new(&message))
}

/// The fixed permutation tables of Crystalize and Dents (FX-DIST-CRYSTAL-03): 256 bytes, then 256.
#[wasm_bindgen]
pub fn distort_permutations() -> Vec<u8> {
    distort::permutation_tables()
}

/// The Crystalize plan (FX-DIST-CRYSTAL-03): `[cell, s0, s1, s2, s3]`. `seed` is the effective seed
/// of `crystalize_seed`.
#[wasm_bindgen]
pub fn crystal_plan(cell: f32, seed: u32) -> Vec<f32> {
    distort::crystal_plan(cell, seed).to_vec()
}

/// Crystalize through the distortion engine (FX-DIST-CRYSTAL), with the plan from `crystal_plan`.
#[wasm_bindgen]
pub fn crystalize_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    plan: &[f32],
) -> Result<Vec<u8>, JsError> {
    distort::crystalize_rgba8(src, width as usize, height as usize, quality, plan)
        .map_err(|message| JsError::new(&message))
}

/// The Dents plan (FX-DIST-DENTS-03) over a `width` × `height` region. `settings` is
/// `[scale, refraction, detail, turbulence, angle]`, and `seed` the effective seed of `dents_seed`.
#[wasm_bindgen]
pub fn dents_plan(
    width: f32,
    height: f32,
    settings: &[f32],
    seed: u32,
) -> Result<Vec<f32>, JsError> {
    let settings: [f32; 5] = settings
        .try_into()
        .map_err(|_| JsError::new(&format!("settings need 5 values, got {}", settings.len())))?;
    Ok(distort::dents_plan(width, height, settings, seed).to_vec())
}

/// Dents through the distortion engine (FX-DIST-DENTS), with the plan from `dents_plan`.
#[wasm_bindgen]
pub fn dents_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    plan: &[f32],
) -> Result<Vec<u8>, JsError> {
    distort::dents_rgba8(src, width as usize, height as usize, quality, plan)
        .map_err(|message| JsError::new(&message))
}

/// Frosted Glass through the distortion engine (FX-DIST-FROST), with `plan` = `[min, max, diffusion]`
/// and one effective seed per sample map (see `frost_seed`). The edge mode is Reflect.
#[wasm_bindgen]
pub fn frost_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    plan: &[f32],
    seeds: &[u32],
) -> Result<Vec<u8>, JsError> {
    distort::frost_rgba8(src, width as usize, height as usize, plan, seeds)
        .map_err(|message| JsError::new(&message))
}

/// The Pixelate plan (FX-DIST-PIXELATE-03) over a `width` × `height` region, as `[ax, ay, cell]`.
/// `anchor` is the Anchor control, from (-1, -1) to (1, 1).
#[wasm_bindgen]
pub fn pixelate_plan(
    width: f32,
    height: f32,
    anchor: &[f32],
    cell: f32,
) -> Result<Vec<f32>, JsError> {
    let anchor = pair(anchor, "anchor")?;
    Ok(pixelate::pixelate_plan(width, height, anchor, cell).to_vec())
}

/// The cells that cover a Pixelate region, as `[first column, first row, columns, rows]`.
#[wasm_bindgen]
pub fn pixelate_grid(width: u32, height: u32, plan: &[f32]) -> Result<Vec<i32>, JsError> {
    let plan: [f32; 3] = plan.try_into().map_err(|_| {
        JsError::new(&format!(
            "a Pixelate plan needs 3 values, got {}",
            plan.len()
        ))
    })?;
    Ok(pixelate::pixelate_grid(width as usize, height as usize, plan).to_vec())
}

/// Pixelate through the cells (FX-DIST-PIXELATE), with the plan from `pixelate_plan` and the codes
/// of the Scale Down and Scale Up interpolations.
#[wasm_bindgen]
pub fn pixelate_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    plan: &[f32],
    down: u8,
    up: u8,
) -> Result<Vec<u8>, JsError> {
    pixelate::pixelate_rgba8(src, width as usize, height as usize, plan, down, up)
        .map_err(|message| JsError::new(&message))
}

/// Morphology (FX-DIST-MORPH) over a `2·kernel_width` × `2·kernel_height` window. `mode` is 0 for
/// Erode and 1 for Dilate.
#[wasm_bindgen]
pub fn morphology_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    kernel_width: u32,
    kernel_height: u32,
    mode: u8,
) -> Result<Vec<u8>, JsError> {
    morphology::morphology_rgba8(
        src,
        width as usize,
        height as usize,
        [kernel_width as usize, kernel_height as usize],
        mode,
    )
    .map_err(|message| JsError::new(&message))
}

/// The Fragment Blur offsets (FX-BLUR-FRAG-03), flattened to `dx, dy` pairs in pixels.
#[wasm_bindgen]
pub fn fragment_offsets(count: u32, distance: f32, rotation: f32) -> Result<Vec<f32>, JsError> {
    directional_blur::fragment_offsets(count, distance, rotation)
        .map_err(|message| JsError::new(&message))
}

/// Fragment Blur (FX-BLUR-FRAG) of a straight-alpha RGBA8 image, with `count` copies.
#[wasm_bindgen]
pub fn fragment_blur_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    count: u32,
    distance: f32,
    rotation: f32,
) -> Result<Vec<u8>, JsError> {
    directional_blur::fragment_blur_rgba8(
        src,
        width as usize,
        height as usize,
        count,
        distance,
        rotation,
    )
    .map_err(|message| JsError::new(&message))
}

/// The Motion Blur kernel (FX-BLUR-MOTION-03), flattened to `dx, dy, weight` triples. Empty when the
/// distance is 0 or less.
#[wasm_bindgen]
pub fn motion_plan(distance: f32, angle: f32, centered: bool) -> Result<Vec<f32>, JsError> {
    directional_blur::motion_plan(distance, angle, centered)
        .map_err(|message| JsError::new(&message))
}

/// Motion Blur (FX-BLUR-MOTION) of a straight-alpha RGBA8 image, with the edge mode 0-3 (see `distort`).
#[wasm_bindgen]
pub fn motion_blur_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    distance: f32,
    angle: f32,
    centered: bool,
    edge: u8,
) -> Result<Vec<u8>, JsError> {
    let edge = distort::EdgeMode::from_code(edge).map_err(|message| JsError::new(&message))?;
    directional_blur::motion_blur_rgba8(
        src,
        width as usize,
        height as usize,
        distance,
        angle,
        centered,
        edge,
    )
    .map_err(|message| JsError::new(&message))
}

/// Median Blur (FX-BLUR-MEDIAN) of a straight-alpha RGBA8 image.
#[wasm_bindgen]
pub fn median_blur_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    radius: u32,
    percentile: u32,
    quality: u32,
) -> Result<Vec<u8>, JsError> {
    neighborhood_blur::median_blur_rgba8(
        src,
        width as usize,
        height as usize,
        radius,
        percentile,
        quality,
    )
    .map_err(|message| JsError::new(&message))
}

/// The Surface Blur weight slope `k` for a Threshold (FX-BLUR-SURFACE-03).
#[wasm_bindgen]
pub fn surface_slope(threshold: u32) -> Result<f32, JsError> {
    neighborhood_blur::surface_slope(threshold).map_err(|message| JsError::new(&message))
}

/// The Add Noise deviate table (FX-NOISE-ADD-03), 16384 entries.
#[wasm_bindgen]
pub fn add_noise_table() -> Vec<i32> {
    noise::add_noise_table()
}

/// Add Noise (FX-NOISE-ADD) of a straight-alpha RGBA8 image, with the effective seed.
#[wasm_bindgen]
pub fn add_noise_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    intensity: u32,
    saturation: u32,
    coverage: f32,
    seed: u32,
) -> Result<Vec<u8>, JsError> {
    noise::add_noise_rgba8(
        src,
        width as usize,
        height as usize,
        intensity,
        saturation,
        coverage,
        seed,
    )
    .map_err(|message| JsError::new(&message))
}

/// Reduce Noise (FX-NOISE-REDUCE) of a straight-alpha RGBA8 image.
#[wasm_bindgen]
pub fn reduce_noise_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    radius: u32,
    strength: f32,
) -> Result<Vec<u8>, JsError> {
    noise::reduce_noise_rgba8(src, width as usize, height as usize, radius, strength)
        .map_err(|message| JsError::new(&message))
}

/// Surface Blur (FX-BLUR-SURFACE) of a straight-alpha RGBA8 image.
#[wasm_bindgen]
pub fn surface_blur_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    radius: u32,
    threshold: u32,
) -> Result<Vec<u8>, JsError> {
    neighborhood_blur::surface_blur_rgba8(src, width as usize, height as usize, radius, threshold)
        .map_err(|message| JsError::new(&message))
}

/// The Radial Blur rotations (FX-BLUR-RADIAL-03), flattened to `cos, sin` pairs.
#[wasm_bindgen]
pub fn radial_plan(angle: f32, quality: f32) -> Result<Vec<f32>, JsError> {
    radial_zoom_blur::radial_plan(angle, quality).map_err(|message| JsError::new(&message))
}

/// Radial Blur (FX-BLUR-RADIAL) of a straight-alpha RGBA8 image about `center`, from a `radial_plan`.
#[wasm_bindgen]
pub fn radial_blur_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    center: &[f32],
    plan: &[f32],
) -> Result<Vec<u8>, JsError> {
    radial_zoom_blur::radial_blur_rgba8(
        src,
        width as usize,
        height as usize,
        pair(center, "center")?,
        plan,
    )
    .map_err(|message| JsError::new(&message))
}

/// The Zoom Blur scales (FX-BLUR-ZOOM-03), flattened to `scale, weight` pairs. Empty at distance 1.
#[wasm_bindgen]
pub fn zoom_plan(distance: f32, focus: f32, quality: f32) -> Result<Vec<f32>, JsError> {
    radial_zoom_blur::zoom_plan(distance, focus, quality).map_err(|message| JsError::new(&message))
}

/// Zoom Blur (FX-BLUR-ZOOM) of a straight-alpha RGBA8 image about `center`, from a `zoom_plan`.
#[wasm_bindgen]
pub fn zoom_blur_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    center: &[f32],
    plan: &[f32],
) -> Result<Vec<u8>, JsError> {
    radial_zoom_blur::zoom_blur_rgba8(
        src,
        width as usize,
        height as usize,
        pair(center, "center")?,
        plan,
    )
    .map_err(|message| JsError::new(&message))
}

/// The Clouds permutation table (FX-RENDER-CLOUDS-01), 256 entries, for the WGSL twin.
#[wasm_bindgen]
pub fn clouds_permutation() -> Vec<u32> {
    clouds::cloud_permutation()
}

/// Clouds (FX-RENDER-CLOUDS-01) composited onto a straight-alpha RGBA8 image. `plan` is the flat
/// parameter array of `CloudsParams::from_plan`.
#[wasm_bindgen]
pub fn clouds_rgba8(src: &[u8], width: u32, height: u32, plan: &[f32]) -> Result<Vec<u8>, JsError> {
    let params = clouds::CloudsParams::from_plan(plan).map_err(|message| JsError::new(&message))?;
    clouds::clouds_rgba8(src, width as usize, height as usize, &params)
        .map_err(|message| JsError::new(&message))
}

/// The Turbulence base frequencies and stitch values for a period and tile size (FX-RENDER-TURB-01):
/// `[freq_x, freq_y, width, wrap_x, height, wrap_y]`.
#[wasm_bindgen]
pub fn turbulence_plan(period: f32, tile: u32) -> Result<Vec<f32>, JsError> {
    turbulence::turbulence_plan(period, tile)
        .map(|plan| plan.to_vec())
        .map_err(|message| JsError::new(&message))
}

/// The Turbulence lattice selector table (514 entries) for a seed.
#[wasm_bindgen]
pub fn turbulence_lattice(seed: u32) -> Vec<u32> {
    turbulence::turbulence_lattice(seed)
}

/// The Turbulence gradient table (4 x 514 x 2 values) for a seed.
#[wasm_bindgen]
pub fn turbulence_gradients(seed: u32) -> Vec<f32> {
    turbulence::turbulence_gradients(seed)
}

/// Turbulence (FX-RENDER-TURB-01) composited onto a straight-alpha RGBA8 image. `plan` is the flat
/// parameter array of `TurbulenceParams::from_plan`.
#[wasm_bindgen]
pub fn turbulence_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    plan: &[f32],
) -> Result<Vec<u8>, JsError> {
    let params = turbulence::TurbulenceParams::from_plan(plan)
        .map_err(|message| JsError::new(&message))?;
    turbulence::turbulence_rgba8(src, width as usize, height as usize, &params)
        .map_err(|message| JsError::new(&message))
}

/// Julia (FX-RENDER-JULIA-01) composited onto a straight-alpha RGBA8 image. `plan` is the flat
/// parameter array of `FractalParams::from_plan`.
#[wasm_bindgen]
pub fn julia_rgba8(src: &[u8], width: u32, height: u32, plan: &[f32]) -> Result<Vec<u8>, JsError> {
    let params = fractal::FractalParams::from_plan(plan).map_err(|message| JsError::new(&message))?;
    fractal::julia_rgba8(src, width as usize, height as usize, &params)
        .map_err(|message| JsError::new(&message))
}

/// Mandelbrot (FX-RENDER-MANDEL-01) composited onto a straight-alpha RGBA8 image. `plan` is the flat
/// parameter array of `fractal::mandelbrot_from_plan`: the Julia values, then Invert Colors as 0 or 1.
#[wasm_bindgen]
pub fn mandelbrot_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    plan: &[f32],
) -> Result<Vec<u8>, JsError> {
    let (params, invert) =
        fractal::mandelbrot_from_plan(plan).map_err(|message| JsError::new(&message))?;
    fractal::mandelbrot_rgba8(src, width as usize, height as usize, &params, invert)
        .map_err(|message| JsError::new(&message))
}

fn pair(values: &[f32], name: &str) -> Result<[f32; 2], JsError> {
    <[f32; 2]>::try_from(values)
        .map_err(|_| JsError::new(&format!("{name} needs 2 values, got {}", values.len())))
}

/// Per-pixel random noise (FX-A-00-05): three draws per pixel as RGB, opaque alpha.
#[wasm_bindgen]
pub fn noise_rgba8(width: u32, height: u32, seed: u32) -> Vec<u8> {
    rng::noise_rgba8(width as usize, height as usize, seed)
}

/// Add Noise seed: `userSeed XOR instanceSeed`.
#[wasm_bindgen]
pub fn add_noise_seed(user: u32, instance: u32) -> u32 {
    rng::add_noise_seed(user, instance)
}

/// Crystalize seed: `userSeed * 1566083941 + instanceSeed` (low 8 bits of the instance seed).
#[wasm_bindgen]
pub fn crystalize_seed(user: u32, instance: u32) -> u32 {
    rng::crystalize_seed(user, instance)
}

/// Dents seed: `(userSeed + instanceSeed) mod 256`.
#[wasm_bindgen]
pub fn dents_seed(user: u32, instance: u32) -> u32 {
    rng::dents_seed(user, instance)
}

/// Frosted Glass seed for one sample map: `userSeed XOR (instanceSeed XOR mapRandom)`.
#[wasm_bindgen]
pub fn frost_seed(user: u32, instance: u32, map_random: u32) -> u32 {
    rng::frost_seed(user, instance, map_random)
}

/// The per-map random values of Frosted Glass, generated once per effect instance.
#[wasm_bindgen]
pub fn frost_map_randoms(instance: u32, count: u32) -> Vec<u32> {
    rng::frost_map_randoms(instance, count as usize)
}

/// Inverts the color channels of a straight-alpha RGBA8 image (ADJ-INVCOL, see `adjust`). Alpha is kept.
#[wasm_bindgen]
pub fn invert_colors_rgba8(src: &[u8]) -> Result<Vec<u8>, JsError> {
    adjust::invert_colors(src).map_err(|message| JsError::new(&message))
}

/// Inverts the alpha channel of a straight-alpha RGBA8 image (ADJ-INVALPHA, see `adjust`). Color is kept.
#[wasm_bindgen]
pub fn invert_alpha_rgba8(src: &[u8]) -> Result<Vec<u8>, JsError> {
    adjust::invert_alpha(src).map_err(|message| JsError::new(&message))
}

/// Replaces each color with its luma (ADJ-BW, see `adjust`). Alpha is kept.
#[wasm_bindgen]
pub fn black_and_white_rgba8(src: &[u8]) -> Result<Vec<u8>, JsError> {
    adjust::black_and_white(src).map_err(|message| JsError::new(&message))
}

/// Sepia toning of a straight-alpha RGBA8 image at `intensity` 0-100 (ADJ-SEPIA, see `adjust`).
/// Alpha is kept.
#[wasm_bindgen]
pub fn sepia_rgba8(src: &[u8], intensity: f32) -> Result<Vec<u8>, JsError> {
    adjust::sepia(src, intensity).map_err(|message| JsError::new(&message))
}

/// The R, G and B sepia exponents for `intensity` (see `adjust::sepia_exponents`), shared with the WGSL twin.
#[wasm_bindgen]
pub fn sepia_exponents(intensity: f32) -> Vec<f32> {
    adjust::sepia_exponents(intensity).to_vec()
}

/// Brightness / Contrast of a straight-alpha RGBA8 image, both -100..=100 (ADJ-BC, see `adjust`).
/// Alpha is kept.
#[wasm_bindgen]
pub fn brightness_contrast_rgba8(
    src: &[u8],
    brightness: f32,
    contrast: f32,
) -> Result<Vec<u8>, JsError> {
    adjust::brightness_contrast(src, brightness, contrast).map_err(|message| JsError::new(&message))
}

/// Ink Sketch (FX-ART-INK) of a straight-alpha RGBA8 image (see `artistic::ink_sketch_rgba8`).
#[wasm_bindgen]
pub fn ink_sketch_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    ink_outline: f32,
    coloring: f32,
) -> Result<Vec<u8>, JsError> {
    artistic::ink_sketch_rgba8(
        src,
        width as usize,
        height as usize,
        ink_outline,
        coloring,
    )
    .map_err(|message| JsError::new(&message))
}

/// Glow (FX-PHOTO-GLOW) of a straight-alpha RGBA8 image (see `photo::glow_rgba8`).
#[wasm_bindgen]
pub fn glow_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    radius: f32,
    brightness: f32,
    contrast: f32,
) -> Result<Vec<u8>, JsError> {
    photo::glow_rgba8(
        src,
        width as usize,
        height as usize,
        radius,
        brightness,
        contrast,
    )
    .map_err(|message| JsError::new(&message))
}

/// Soften Portrait (FX-PHOTO-SOFTEN) of a straight-alpha RGBA8 image (see
/// `photo::soften_portrait_rgba8`).
#[wasm_bindgen]
pub fn soften_portrait_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    softness: f32,
    lighting: f32,
    warmth: f32,
) -> Result<Vec<u8>, JsError> {
    photo::soften_portrait_rgba8(
        src,
        width as usize,
        height as usize,
        softness,
        lighting,
        warmth,
    )
    .map_err(|message| JsError::new(&message))
}

/// Sharpen (FX-PHOTO-SHARPEN) of a straight-alpha RGBA8 image (see `photo::sharpen_rgba8`).
#[wasm_bindgen]
pub fn sharpen_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    amount: f32,
    threshold: f32,
) -> Result<Vec<u8>, JsError> {
    photo::sharpen_rgba8(
        src,
        width as usize,
        height as usize,
        amount,
        threshold,
    )
    .map_err(|message| JsError::new(&message))
}

/// Red Eye Removal (FX-PHOTO-REDEYE) of a straight-alpha RGBA8 image, with one selection coverage
/// byte per pixel (see `photo::red_eye_rgba8`).
#[wasm_bindgen]
pub fn red_eye_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    coverage: &[u8],
    strength: f32,
) -> Result<Vec<u8>, JsError> {
    photo::red_eye_rgba8(
        src,
        width as usize,
        height as usize,
        coverage,
        strength,
    )
    .map_err(|message| JsError::new(&message))
}

/// Edge Detect (FX-STYL-EDGE) of a straight-alpha RGBA8 image (see `stylize::edge_detect_rgba8`).
#[wasm_bindgen]
pub fn edge_detect_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    strength: f32,
    blurring: f32,
    prewitt: bool,
    overlay: bool,
) -> Result<Vec<u8>, JsError> {
    stylize::edge_detect_rgba8(
        src,
        width as usize,
        height as usize,
        strength,
        blurring,
        prewitt,
        overlay,
    )
    .map_err(|message| JsError::new(&message))
}

/// The gain of Edge Detect's gradient magnitude (see `stylize::edge_gain`).
#[wasm_bindgen]
pub fn edge_detect_gain(strength: f32, prewitt: bool) -> f32 {
    stylize::edge_gain(strength, prewitt)
}

/// The Gaussian weights of Edge Detect's pre-blur (see `stylize::edge_blur_weights`).
#[wasm_bindgen]
pub fn edge_blur_weights(blurring: f32) -> Vec<f32> {
    stylize::edge_blur_weights(blurring)
}

/// Emboss (FX-STYL-EMBOSS) of a straight-alpha RGBA8 image (see `stylize::emboss_rgba8`).
#[wasm_bindgen]
pub fn emboss_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    angle: f32,
) -> Result<Vec<u8>, JsError> {
    stylize::emboss_rgba8(src, width as usize, height as usize, angle)
        .map_err(|message| JsError::new(&message))
}

/// The 3×3 kernel of Emboss, row-major (see `stylize::emboss_weights`).
#[wasm_bindgen]
pub fn emboss_kernel(angle: f32) -> Vec<f32> {
    stylize::emboss_weights(angle).to_vec()
}

/// Relief (FX-STYL-RELIEF) of a straight-alpha RGBA8 image (see `stylize::relief_rgba8`).
#[wasm_bindgen]
pub fn relief_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    angle: f32,
) -> Result<Vec<u8>, JsError> {
    stylize::relief_rgba8(src, width as usize, height as usize, angle)
        .map_err(|message| JsError::new(&message))
}

/// The 3×3 kernel of Relief, row-major (see `stylize::relief_weights`).
#[wasm_bindgen]
pub fn relief_kernel(angle: f32) -> Vec<f32> {
    stylize::relief_weights(angle).to_vec()
}

/// Outline (FX-STYL-OUTLINE) of a straight-alpha RGBA8 image (see `stylize::outline_rgba8`).
#[wasm_bindgen]
pub fn outline_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    thickness: u32,
    intensity: u32,
    quality: u32,
) -> Result<Vec<u8>, JsError> {
    stylize::outline_rgba8(
        src,
        width as usize,
        height as usize,
        thickness,
        intensity,
        quality,
    )
    .map_err(|message| JsError::new(&message))
}

/// The Gaussian weights of Drop Shadow's blur for `radius` (see `object::drop_shadow_weights`).
#[wasm_bindgen]
pub fn drop_shadow_weights(radius: f32) -> Result<Vec<f32>, JsError> {
    object::drop_shadow_weights(radius).map_err(|message| JsError::new(&message))
}

/// Drop Shadow's offset, color and opacity as `[dx, dy, r, g, b, opacity]` (see
/// `object::drop_shadow_plan`).
#[wasm_bindgen]
pub fn drop_shadow_plan(
    distance: f32,
    angle: f32,
    opacity: f32,
    color: u32,
) -> Result<Vec<f32>, JsError> {
    object::drop_shadow_plan(distance, angle, opacity, color)
        .map(|plan| plan.to_vec())
        .map_err(|message| JsError::new(&message))
}

/// Drop Shadow (FX-OBJ-DROPSHADOW) of a straight-alpha RGBA8 image (see
/// `object::drop_shadow_rgba8`).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn drop_shadow_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    radius: f32,
    distance: f32,
    angle: f32,
    opacity: f32,
    color: u32,
    only_shadow: bool,
) -> Result<Vec<u8>, JsError> {
    object::drop_shadow_rgba8(
        src,
        width as usize,
        height as usize,
        radius,
        distance,
        angle,
        opacity,
        color,
        only_shadow,
    )
    .map_err(|message| JsError::new(&message))
}

/// Align Object's object box over a straight-alpha RGBA8 image as `[x1, y1, x2, y2]`, or an empty
/// array when there is no object. `coverage` is one byte per pixel, or empty for no selection (see
/// `align::align_object_box`).
#[wasm_bindgen]
pub fn align_object_box(
    src: &[u8],
    width: u32,
    height: u32,
    coverage: &[u8],
) -> Result<Vec<u32>, JsError> {
    align::align_object_box(src, width as usize, height as usize, coverage)
        .map(|found| {
            found.map_or_else(Vec::new, |b| {
                [b.x1, b.y1, b.x2, b.y2].map(|v| v as u32).to_vec()
            })
        })
        .map_err(|message| JsError::new(&message))
}

fn object_box(x1: u32, y1: u32, x2: u32, y2: u32) -> align::ObjectBox {
    align::ObjectBox {
        x1: x1 as usize,
        y1: y1 as usize,
        x2: x2 as usize,
        y2: y2 as usize,
    }
}

/// The offset `[dx, dy]` that moves the object box to `position` (see `align::align_object_offset`).
#[wasm_bindgen]
pub fn align_object_offset(
    x1: u32,
    y1: u32,
    x2: u32,
    y2: u32,
    width: u32,
    height: u32,
    position: u32,
) -> Result<Vec<i32>, JsError> {
    align::align_object_offset(
        object_box(x1, y1, x2, y2),
        width as usize,
        height as usize,
        position,
    )
    .map(|(dx, dy)| vec![dx as i32, dy as i32])
    .map_err(|message| JsError::new(&message))
}

/// Align Object (FX-OBJ-ALIGN) of a straight-alpha RGBA8 image with a known object box (see
/// `align::align_object_translate_rgba8`).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn align_object_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    coverage: &[u8],
    x1: u32,
    y1: u32,
    x2: u32,
    y2: u32,
    position: u32,
    faint: bool,
) -> Result<Vec<u8>, JsError> {
    align::align_object_translate_rgba8(
        src,
        width as usize,
        height as usize,
        coverage,
        object_box(x1, y1, x2, y2),
        position,
        faint,
    )
    .map_err(|message| JsError::new(&message))
}

/// Flip Horizontal or Flip Vertical (FX-OBJ-FLIP) of a straight-alpha RGBA8 image: the selected
/// pixels mirror about the image's centre line, with the selection (see `flip::flip_object_rgba8`).
/// `coverage` is one byte per pixel, or empty for no selection.
#[wasm_bindgen]
pub fn flip_object_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    coverage: &[u8],
    vertical: bool,
) -> Result<Vec<u8>, JsError> {
    flip::flip_object_rgba8(src, width as usize, height as usize, coverage, vertical)
        .map_err(|message| JsError::new(&message))
}

/// The inverse transform of Straighten for a `width` x `height` image, as `a, b, c, d, e, f` (see
/// `photo::straighten_matrix`).
#[wasm_bindgen]
pub fn straighten_matrix(width: u32, height: u32, angle: f32) -> Result<Vec<f32>, JsError> {
    photo::straighten_matrix(width as usize, height as usize, angle)
        .map(|matrix| matrix.to_vec())
        .map_err(|message| JsError::new(&message))
}

/// Straighten (FX-PHOTO-STRAIGHTEN) of a straight-alpha RGBA8 image (see `photo::straighten_rgba8`).
#[wasm_bindgen]
pub fn straighten_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    angle: f32,
    sampling: u8,
) -> Result<Vec<u8>, JsError> {
    photo::straighten_rgba8(
        src,
        width as usize,
        height as usize,
        angle,
        sampling,
    )
    .map_err(|message| JsError::new(&message))
}

/// The center and falloff of Vignette for a region (see `photo::vignette_plan`), as `cx, cy, k`.
#[wasm_bindgen]
pub fn vignette_plan(
    width: u32,
    height: u32,
    center_x: f32,
    center_y: f32,
    radius: f32,
) -> Result<Vec<f32>, JsError> {
    photo::vignette_plan(
        width as usize,
        height as usize,
        center_x,
        center_y,
        radius,
    )
    .map_err(|message| JsError::new(&message))
}

/// Vignette (FX-PHOTO-VIGNETTE) of a straight-alpha RGBA8 region (see `photo::vignette_rgba8`).
#[wasm_bindgen]
pub fn vignette_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    center_x: f32,
    center_y: f32,
    radius: f32,
    strength: f32,
) -> Result<Vec<u8>, JsError> {
    photo::vignette_rgba8(
        src,
        width as usize,
        height as usize,
        center_x,
        center_y,
        radius,
        strength,
    )
    .map_err(|message| JsError::new(&message))
}

/// The plan of Rotate / Zoom over a `width` x `height` region, as 13 values: the row-major rotation,
/// the focal length, the pan in pixels and the zoom (see `rotate_zoom::rotate_zoom_plan`). `roll` is
/// `[angle, direction, tilt]` and `pan` is `[x, y]`.
#[wasm_bindgen]
pub fn rotate_zoom_plan(
    width: u32,
    height: u32,
    roll: &[f32],
    pan: &[f32],
    zoom: f32,
) -> Result<Vec<f32>, JsError> {
    let roll: [f32; 3] = roll
        .try_into()
        .map_err(|_| JsError::new("the roll must hold 3 values"))?;
    let pan: [f32; 2] = pan
        .try_into()
        .map_err(|_| JsError::new("the pan must hold 2 values"))?;
    rotate_zoom::rotate_zoom_plan(width as usize, height as usize, roll, pan, zoom)
        .map(|plan| plan.to_vec())
        .map_err(|message| JsError::new(&message))
}

/// Rotate / Zoom (FX-NOSUB-ROTZOOM-01) of a straight-alpha RGBA8 region (see
/// `rotate_zoom::rotate_zoom_rgba8`). `sampling` is 0 for Bilinear and 1 for Nearest Neighbor, and
/// `tiling` is 0 for None, 1 for Repeat and 2 for Mirror.
#[wasm_bindgen]
pub fn rotate_zoom_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    plan: &[f32],
    quality: u8,
    sampling: u8,
    tiling: u8,
) -> Result<Vec<u8>, JsError> {
    rotate_zoom::rotate_zoom_rgba8(
        src,
        width as usize,
        height as usize,
        plan,
        quality,
        sampling,
        tiling,
    )
    .map_err(|message| JsError::new(&message))
}

/// Oil Painting (FX-ART-OIL) of a straight-alpha RGBA8 image (see `artistic::oil_painting_rgba8`).
#[wasm_bindgen]
pub fn oil_painting_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    brush_size: u32,
    granularity: f32,
    square: bool,
) -> Result<Vec<u8>, JsError> {
    artistic::oil_painting_rgba8(
        src,
        width as usize,
        height as usize,
        brush_size,
        granularity,
        square,
    )
    .map_err(|message| JsError::new(&message))
}

/// Pencil Sketch (FX-ART-PENCIL) of a straight-alpha RGBA8 image (see `artistic::pencil_sketch_rgba8`).
#[wasm_bindgen]
pub fn pencil_sketch_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    tip_size: f32,
    range: f32,
) -> Result<Vec<u8>, JsError> {
    artistic::pencil_sketch_rgba8(src, width as usize, height as usize, tip_size, range)
        .map_err(|message| JsError::new(&message))
}

/// The shift, multiplier and divisor of Brightness / Contrast (see `adjust::brightness_contrast_plan`),
/// shared with the WGSL twin.
#[wasm_bindgen]
pub fn brightness_contrast_plan(brightness: f32, contrast: f32) -> Result<Vec<f32>, JsError> {
    adjust::brightness_contrast_plan(brightness, contrast)
        .map(|plan| plan.to_vec())
        .map_err(|message| JsError::new(&message))
}

/// Auto-Level of a straight-alpha RGBA8 image (ADJ-AUTOLEVEL, see `adjust`). The histograms read only
/// the pixels with nonzero `coverage`, one byte per pixel. Alpha is kept.
#[wasm_bindgen]
pub fn auto_level_rgba8(src: &[u8], coverage: &[u8]) -> Result<Vec<u8>, JsError> {
    adjust::auto_level(src, coverage).map_err(|message| JsError::new(&message))
}

/// The Auto-Level plan (see `adjust::auto_level_plan`): black point, white point and gamma for R, G
/// and B, shared with the WGSL twin.
#[wasm_bindgen]
pub fn auto_level_plan(src: &[u8], coverage: &[u8]) -> Result<Vec<f32>, JsError> {
    adjust::auto_level_plan(src, coverage)
        .map(|plan| plan.to_vec())
        .map_err(|message| JsError::new(&message))
}

/// The Levels transform of a straight-alpha RGBA8 image with `plan` (ADJ-LEVELS-MATH, see `adjust`):
/// black point, white point and gamma for R, G and B. Alpha is kept.
#[wasm_bindgen]
pub fn levels_rgba8(src: &[u8], plan: &[f32]) -> Result<Vec<u8>, JsError> {
    adjust::levels(src, plan).map_err(|message| JsError::new(&message))
}

/// The Levels lookup table of `plan` (see `adjust::levels_lut`): 768 bytes, R then G then B.
#[wasm_bindgen]
pub fn levels_lut(plan: &[f32]) -> Result<Vec<u8>, JsError> {
    adjust::levels_lut(plan).map_err(|message| JsError::new(&message))
}

/// The per-channel histograms of the covered pixels (ADJ-LEVELS-UI-06, see `adjust::levels_histogram`).
#[wasm_bindgen]
pub fn levels_histogram_rgba8(src: &[u8], coverage: &[u8]) -> Result<Vec<u32>, JsError> {
    adjust::levels_histogram(src, coverage).map_err(|message| JsError::new(&message))
}

/// The 1024-entry lookup table of one curve from its control points as x, y pairs (see
/// `adjust::curve_lut`), shared with the WGSL twin.
#[wasm_bindgen]
pub fn curve_lut(points: &[u8]) -> Result<Vec<f32>, JsError> {
    adjust::curve_lut(points).map_err(|message| JsError::new(&message))
}

/// The Curves transform of a straight-alpha RGBA8 image (ADJ-CURVES, see `adjust::curves`). `tables`
/// holds the luminosity, red, green and blue tables of `curve_lut`.
#[wasm_bindgen]
pub fn curves_rgba8(src: &[u8], rgb: bool, tables: &[f32]) -> Result<Vec<u8>, JsError> {
    adjust::curves(src, rgb, tables).map_err(|message| JsError::new(&message))
}

/// Hue / Saturation of a straight-alpha RGBA8 image (ADJ-HUESAT, see `adjust`). Alpha is kept.
#[wasm_bindgen]
pub fn hue_saturation_rgba8(
    src: &[u8],
    hue: f32,
    saturation: f32,
    lightness: f32,
) -> Result<Vec<u8>, JsError> {
    adjust::hue_saturation(src, hue, saturation, lightness)
        .map_err(|message| JsError::new(&message))
}

/// The hue turn, saturation factor, lightness weight and lightness target of Hue / Saturation (see
/// `adjust::hue_saturation_plan`), shared with the WGSL twin.
#[wasm_bindgen]
pub fn hue_saturation_plan(hue: f32, saturation: f32, lightness: f32) -> Result<Vec<f32>, JsError> {
    adjust::hue_saturation_plan(hue, saturation, lightness)
        .map(|plan| plan.to_vec())
        .map_err(|message| JsError::new(&message))
}

/// Posterize of a straight-alpha RGBA8 image (ADJ-POSTERIZE, see `adjust`). `levels` holds the R, G,
/// B and A level counts, where 0 leaves the channel unchanged and 2..=64 quantizes it.
#[wasm_bindgen]
pub fn posterize_rgba8(src: &[u8], levels: &[u32]) -> Result<Vec<u8>, JsError> {
    adjust::posterize(src, levels).map_err(|message| JsError::new(&message))
}

/// The Exposure gain `2^(value / 100)` for `value` in −200..=200 (see `adjust::exposure_gain`),
/// shared with the WGSL twin.
#[wasm_bindgen]
pub fn exposure_gain(value: f32) -> Result<f32, JsError> {
    adjust::exposure_gain(value).map_err(|message| JsError::new(&message))
}

/// Exposure of a straight-alpha RGBA8 image, `value` in −200..=200 (ADJ-EXPOSURE, see `adjust`).
/// Alpha is kept.
#[wasm_bindgen]
pub fn exposure_rgba8(src: &[u8], value: f32) -> Result<Vec<u8>, JsError> {
    adjust::exposure(src, value).map_err(|message| JsError::new(&message))
}

/// The per-channel gains of Temperature / Tint (see `adjust::temperature_tint_gains`), shared with
/// the WGSL twin.
#[wasm_bindgen]
pub fn temperature_tint_gains(temperature: f32, tint: f32) -> Result<Vec<f32>, JsError> {
    adjust::temperature_tint_gains(temperature, tint)
        .map(|gains| gains.to_vec())
        .map_err(|message| JsError::new(&message))
}

/// Temperature / Tint of a straight-alpha RGBA8 image, both −100..=100 (ADJ-TT, see `adjust`).
/// Alpha is kept.
#[wasm_bindgen]
pub fn temperature_tint_rgba8(src: &[u8], temperature: f32, tint: f32) -> Result<Vec<u8>, JsError> {
    adjust::temperature_tint(src, temperature, tint).map_err(|message| JsError::new(&message))
}

/// The Highlights, Shadows and Clarity values as −1..=1 (see `adjust::highlights_shadows_plan`),
/// shared with the WGSL twin.
#[wasm_bindgen]
pub fn highlights_shadows_plan(
    highlights: f32,
    shadows: f32,
    clarity: f32,
) -> Result<Vec<f32>, JsError> {
    adjust::highlights_shadows_plan(highlights, shadows, clarity)
        .map(|tone| tone.to_vec())
        .map_err(|message| JsError::new(&message))
}

/// Highlights / Shadows / Clarity of a straight-alpha RGBA8 image that is `width` by `height`
/// (ADJ-HS, see `adjust`). Alpha is kept.
#[wasm_bindgen]
pub fn highlights_shadows_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    radius: f32,
    highlights: f32,
    shadows: f32,
    clarity: f32,
) -> Result<Vec<u8>, JsError> {
    adjust::highlights_shadows(
        src,
        width as usize,
        height as usize,
        radius,
        highlights,
        shadows,
        clarity,
    )
    .map_err(|message| JsError::new(&message))
}

/// Halves a square RGBA8 block of `edge` pixels (even) by averaging each 2x2 group, rounded to
/// nearest: the draft mip filter of the display tiles.
#[wasm_bindgen]
pub fn box_halve_rgba8(block: &[u8], edge: u32) -> Result<Vec<u8>, JsError> {
    let edge = edge as usize;
    if !edge.is_multiple_of(2) || block.len() != edge * edge * 4 {
        return Err(JsError::new("box_halve_rgba8 needs an even square block"));
    }
    Ok(box_halve(block, edge))
}

fn box_halve(block: &[u8], edge: usize) -> Vec<u8> {
    let half = edge / 2;
    let row = edge * 4;
    let mut out = vec![0u8; half * half * 4];
    for (y, out_row) in out.chunks_exact_mut(half * 4).enumerate() {
        let top = &block[2 * y * row..(2 * y + 1) * row];
        let bottom = &block[(2 * y + 1) * row..(2 * y + 2) * row];
        let (pixels, _) = out_row.as_chunks_mut::<4>();
        for (x, px) in pixels.iter_mut().enumerate() {
            for (c, value) in px.iter_mut().enumerate() {
                let i = x * 8 + c;
                let sum = u16::from(top[i])
                    + u16::from(top[i + 4])
                    + u16::from(bottom[i])
                    + u16::from(bottom[i + 4]);
                *value = ((sum + 2) >> 2) as u8;
            }
        }
    }
    out
}

/// The Lanczos-3 taps of one axis from `src_len` to `dst_len` pixels, as `resample_lanczos3_rgba8`
/// applies them (see `resample::lanczos3_axis_taps`), for its GPU twin.
#[wasm_bindgen]
pub fn lanczos3_axis_taps(src_len: u32, dst_len: u32) -> Result<Vec<f32>, JsError> {
    resample::lanczos3_axis_taps(src_len as usize, dst_len as usize)
        .map_err(|message| JsError::new(&message))
}

/// Resamples a premultiplied RGBA8 image with Lanczos-3 (see `resample`), returning the new pixels.
#[wasm_bindgen]
pub fn resample_lanczos3_rgba8(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
) -> Result<Vec<u8>, JsError> {
    resample::lanczos3_rgba8(
        src,
        src_width as usize,
        src_height as usize,
        dst_width as usize,
        dst_height as usize,
    )
    .map_err(|message| JsError::new(&message))
}

/// Resamples a straight-alpha RGBA8 image with one DOC-IMG-02 filter (see `resample`), returning the
/// new pixels. `filter` is the choice id 0-8 (Nearest Neighbor, Bilinear, Bilinear Low Quality,
/// Bicubic, Bicubic Smooth, Adaptive, Lanczos-3, Super Sampling, Fant). `linear_light` resamples in
/// linear light (gamma correction on).
#[wasm_bindgen]
pub fn resample_rgba8(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
    filter: u8,
    linear_light: bool,
) -> Result<Vec<u8>, JsError> {
    let filter = resample::Filter::try_from(filter)
        .map_err(|id| JsError::new(&format!("unknown resampling filter {id}")))?;
    resample::resample_rgba8(
        src,
        src_width as usize,
        src_height as usize,
        dst_width as usize,
        dst_height as usize,
        filter,
        linear_light,
    )
    .map_err(|message| JsError::new(&message))
}

/// Resamples a straight-alpha RGBA8 image through an affine transform (see `transform`), returning the
/// destination pixels. `inverse` holds the six coefficients `a, b, c, d, e, f` that map each destination
/// pixel center to source coordinates. `sampling` is the TL-OPT-RESAMP id 0-4 (Nearest Neighbor, Bilinear,
/// Multisample Bilinear, Anisotropic, High Quality Cubic). `linear_light` samples in linear light.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn transform_rgba8(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
    inverse: &[f64],
    sampling: u8,
    linear_light: bool,
) -> Result<Vec<u8>, JsError> {
    let inverse = <[f64; 6]>::try_from(inverse)
        .map_err(|_| JsError::new("a transform needs six coefficients"))?;
    let sampling = transform::Sampling::try_from(sampling)
        .map_err(|id| JsError::new(&format!("unknown sampling choice {id}")))?;
    transform::transform_rgba8(&transform::Spec {
        src,
        src_width: src_width as usize,
        src_height: src_height as usize,
        dst_width: dst_width as usize,
        dst_height: dst_height as usize,
        inverse,
        sampling,
        linear_light,
    })
    .map_err(|message| JsError::new(&message))
}

/// Rows `first .. first + rows` of `transform_rgba8`'s `dst_width` x `dst_height` result, byte for
/// byte, so workers can compute bands of one transform apart.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn transform_rows_rgba8(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
    inverse: &[f64],
    sampling: u8,
    linear_light: bool,
    first: u32,
    rows: u32,
) -> Result<Vec<u8>, JsError> {
    let inverse = <[f64; 6]>::try_from(inverse)
        .map_err(|_| JsError::new("a transform needs six coefficients"))?;
    let sampling = transform::Sampling::try_from(sampling)
        .map_err(|id| JsError::new(&format!("unknown sampling choice {id}")))?;
    transform::transform_rows_rgba8(
        &transform::Spec {
            src,
            src_width: src_width as usize,
            src_height: src_height as usize,
            dst_width: dst_width as usize,
            dst_height: dst_height as usize,
            inverse,
            sampling,
            linear_light,
        },
        first as usize,
        rows as usize,
    )
    .map_err(|message| JsError::new(&message))
}

/// Rasterizes a polygon set (even-odd fill, see `mask`) into a `width` x `height` selection mask
/// of one byte per pixel. Aliased masks hold 0 or 255. Antialiased masks hold each pixel's covered
/// fraction. `coords` holds the rings' `x, y` pairs in order; `counts` holds each ring's vertex count.
#[wasm_bindgen]
pub fn rasterize_polygons(
    coords: &[f64],
    counts: &[u32],
    width: u32,
    height: u32,
    antialiased: bool,
) -> Result<Vec<u8>, JsError> {
    mask::rasterize_polygons(coords, counts, width as usize, height as usize, antialiased)
        .map_err(|message| JsError::new(&message))
}

/// Composites a straight-alpha RGBA8 source tile over a destination tile of the same size in
/// place, using layer blend mode `mode` (DOC-BLD-01 value 0-13) and layer opacity 0-255.
#[wasm_bindgen]
pub fn composite_rgba8(dst: &mut [u8], src: &[u8], mode: u8, opacity: u8) -> Result<(), JsError> {
    let mode = blend::BlendMode::try_from(mode)
        .map_err(|m| JsError::new(&format!("unknown blend mode {m}")))?;
    if dst.len() != src.len() || !dst.len().is_multiple_of(4) {
        return Err(JsError::new("tile buffers must be equal-sized RGBA8"));
    }
    blend::composite(dst, src, mode, opacity);
    Ok(())
}

/// Encodes a prepared image as a PNG file (see `png`). `depth` is 32, 24, 8, 4, 2 or 1. `pixels` is
/// straight RGBA (32) or RGB (24), or one palette index per pixel for the indexed depths. `palette`
/// holds RGB triples and `alpha` one value per palette entry. `icc` is an ICC profile, `exif` a
/// TIFF-structured block, and `xmp` the XMP packets joined by NUL bytes. Zero pixels per meter omits
/// pHYs.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn encode_png(
    width: u32,
    height: u32,
    pixels: &[u8],
    depth: u8,
    palette: &[u8],
    alpha: &[u8],
    interlaced: bool,
    icc: &[u8],
    exif: &[u8],
    xmp: &[u8],
    pixels_per_meter_x: u32,
    pixels_per_meter_y: u32,
) -> Result<Vec<u8>, JsError> {
    let depth = png::Depth::from_bits(depth).map_err(|message| JsError::new(&message))?;
    let packets: Vec<&[u8]> = if xmp.is_empty() {
        Vec::new()
    } else {
        xmp.split(|&byte| byte == 0).collect()
    };
    let spec = png::Spec {
        width: width as usize,
        height: height as usize,
        depth,
        pixels,
        palette,
        alpha,
        interlaced,
        icc,
        pixels_per_meter: (pixels_per_meter_x != 0 || pixels_per_meter_y != 0)
            .then_some((pixels_per_meter_x, pixels_per_meter_y)),
        exif,
        xmp: &packets,
    };
    png::encode(&spec).map_err(|message| JsError::new(&message))
}

/// Encodes a flattened RGB image as a baseline JPEG (see `jpeg`). `pixels` is RGB, three bytes per
/// pixel. `quality` is 0-100 and `sampling` the chroma choice id (0 = 4:4:4, 1 = 4:4:0, 2 = 4:2:2,
/// 3 = 4:2:0). Zero dots per inch on both axes writes no density. `icc` is an ICC profile, `exif` a
/// TIFF-structured block, `xmp` the XMP packets joined by NUL bytes, and `iptc` the IIM records.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn encode_jpeg(
    width: u32,
    height: u32,
    pixels: &[u8],
    quality: u8,
    sampling: u8,
    dpi_x: u16,
    dpi_y: u16,
    icc: &[u8],
    exif: &[u8],
    xmp: &[u8],
    iptc: &[u8],
) -> Result<Vec<u8>, JsError> {
    let sampling = jpeg::sampling_from_id(sampling).map_err(|message| JsError::new(&message))?;
    let packets: Vec<&[u8]> = if xmp.is_empty() {
        Vec::new()
    } else {
        xmp.split(|&byte| byte == 0).collect()
    };
    let spec = jpeg::Spec {
        width: width as usize,
        height: height as usize,
        pixels,
        quality,
        sampling,
        dpi: (dpi_x != 0 || dpi_y != 0).then_some((dpi_x, dpi_y)),
        icc,
        exif,
        xmp: &packets,
        iptc,
    };
    jpeg::encode(&spec).map_err(|message| JsError::new(&message))
}

/// Encodes a prepared image as a BMP file (see `bmp`). `depth` is 32, 24, 8, 4 or 1. `pixels` is
/// RGBA (32), RGB (24), or one palette index per pixel for the indexed depths, and `palette` holds RGB
/// triples. `icc` is an ICC profile to embed (empty for none). Zero pixels per meter writes none.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn encode_bmp(
    width: u32,
    height: u32,
    pixels: &[u8],
    depth: u8,
    palette: &[u8],
    icc: &[u8],
    pixels_per_meter_x: u32,
    pixels_per_meter_y: u32,
) -> Result<Vec<u8>, JsError> {
    bmp::encode(&bmp::Spec {
        width: width as usize,
        height: height as usize,
        depth,
        pixels,
        palette,
        icc,
        pixels_per_meter: (pixels_per_meter_x, pixels_per_meter_y),
    })
    .map_err(|message| JsError::new(&message))
}

/// Decodes a BMP file (see `bmp`) into straight RGBA.
#[wasm_bindgen]
pub fn decode_bmp(bytes: &[u8]) -> Result<DecodedImage, JsError> {
    let image = bmp::decode(bytes).map_err(|message| JsError::new(&message))?;
    Ok(DecodedImage {
        width: image.width as u32,
        height: image.height as u32,
        pixels: image.rgba,
        pixels_per_meter_x: image.pixels_per_meter.0,
        pixels_per_meter_y: image.pixels_per_meter.1,
        icc: image.icc,
        author: Vec::new(),
        comment: Vec::new(),
        exif: Vec::new(),
        xmp: Vec::new(),
        cmyk: false,
    })
}

/// Encodes a palette image as a GIF file (see `gif`). `indices` holds one palette index per pixel, and
/// `palette` holds up to 256 RGB triples. `transparent` names the fully transparent index. `xmp` is one
/// XMP packet, or empty for none.
#[wasm_bindgen]
pub fn encode_gif(
    width: u32,
    height: u32,
    indices: &[u8],
    palette: &[u8],
    transparent: Option<u8>,
    xmp: &[u8],
) -> Result<Vec<u8>, JsError> {
    gif::encode(&gif::Spec {
        width: width as usize,
        height: height as usize,
        indices,
        palette,
        transparent,
        xmp,
    })
    .map_err(|message| JsError::new(&message))
}

/// Decodes the first frame of a GIF file (see `gif`) into straight RGBA.
#[wasm_bindgen]
pub fn decode_gif(bytes: &[u8]) -> Result<DecodedImage, JsError> {
    let image = gif::decode_first_frame(bytes).map_err(|message| JsError::new(&message))?;
    Ok(DecodedImage {
        width: image.width as u32,
        height: image.height as u32,
        pixels: image.rgba,
        pixels_per_meter_x: 0,
        pixels_per_meter_y: 0,
        icc: Vec::new(),
        author: Vec::new(),
        comment: Vec::new(),
        exif: Vec::new(),
        xmp: image.xmp,
        cmyk: false,
    })
}

/// Encodes a prepared image as a TIFF file (see `tiff`). `depth` is 32, 24, 8, 4 or 1. `pixels` is RGBA
/// (32), RGB (24), or one palette index per pixel for the indexed depths, and `palette` holds RGB triples.
/// Zero pixels per meter on either axis writes no density. `icc` is an ICC profile (empty for none),
/// `exif` a TIFF-structured block whose entries are copied, and `xmp` one XMP packet (empty for none).
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn encode_tiff(
    width: u32,
    height: u32,
    pixels: &[u8],
    depth: u8,
    palette: &[u8],
    icc: &[u8],
    pixels_per_meter_x: u32,
    pixels_per_meter_y: u32,
    exif: &[u8],
    xmp: &[u8],
) -> Result<Vec<u8>, JsError> {
    tiff::encode(&tiff::Spec {
        width: width as usize,
        height: height as usize,
        depth,
        pixels,
        palette,
        icc,
        pixels_per_meter: (pixels_per_meter_x, pixels_per_meter_y),
        exif,
        xmp,
    })
    .map_err(|message| JsError::new(&message))
}

/// Decodes the first page of a TIFF file (see `tiff`) into straight RGBA, or into CMYK ink for a CMYK
/// page, with its density, ICC profile, XMP packet and EXIF block.
#[wasm_bindgen]
pub fn decode_tiff(bytes: &[u8]) -> Result<DecodedImage, JsError> {
    let image = tiff::decode(bytes).map_err(|message| JsError::new(&message))?;
    Ok(DecodedImage {
        width: image.width as u32,
        height: image.height as u32,
        pixels: image.rgba,
        pixels_per_meter_x: image.pixels_per_meter.0,
        pixels_per_meter_y: image.pixels_per_meter.1,
        icc: image.icc,
        author: Vec::new(),
        comment: Vec::new(),
        exif: image.exif,
        xmp: image.xmp,
        cmyk: image.cmyk,
    })
}

/// Encodes a true-color image as a TGA 2.0 file (see `tga`). `pixels` is RGB (24) or RGBA (32). `rle`
/// selects run-length packets. `author` and `comment` are ASCII. `date` holds the month, day, year,
/// hour, minute and second of the save.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn encode_tga(
    width: u32,
    height: u32,
    pixels: &[u8],
    depth: u8,
    rle: bool,
    author: &[u8],
    comment: &[u8],
    date: &[u16],
) -> Result<Vec<u8>, JsError> {
    let date =
        <[u16; 6]>::try_from(date).map_err(|_| JsError::new("a TGA date needs six values"))?;
    tga::encode(&tga::Spec {
        width: width as usize,
        height: height as usize,
        depth,
        pixels,
        rle,
        author,
        comment,
        date,
    })
    .map_err(|message| JsError::new(&message))
}

/// Decodes a TGA file (see `tga`) into straight RGBA.
#[wasm_bindgen]
pub fn decode_tga(bytes: &[u8]) -> Result<DecodedImage, JsError> {
    let image = tga::decode(bytes).map_err(|message| JsError::new(&message))?;
    Ok(DecodedImage {
        width: image.width as u32,
        height: image.height as u32,
        pixels: image.rgba,
        pixels_per_meter_x: 0,
        pixels_per_meter_y: 0,
        icc: Vec::new(),
        author: image.author,
        comment: image.comment,
        exif: Vec::new(),
        xmp: Vec::new(),
        cmyk: false,
    })
}

/// Wraps a WebP bitstream from libwebp with the VP8X container and the ICCP, EXIF and XMP chunks (see
/// `webp::wrap`). `icc`, `exif` and `xmp` are empty for none, and `xmp` is one packet.
#[wasm_bindgen]
pub fn wrap_webp(
    bitstream: &[u8],
    width: u32,
    height: u32,
    icc: &[u8],
    exif: &[u8],
    xmp: &[u8],
) -> Result<Vec<u8>, JsError> {
    webp::wrap(bitstream, width as usize, height as usize, icc, exif, xmp)
        .map_err(|message| JsError::new(&message))
}

/// Decodes a WebP file (see `webp`), the first frame of an animation, into straight RGBA with its
/// metadata chunks.
#[wasm_bindgen]
pub fn decode_webp(bytes: &[u8]) -> Result<DecodedImage, JsError> {
    let image = webp::decode(bytes).map_err(|message| JsError::new(&message))?;
    Ok(DecodedImage {
        width: image.width as u32,
        height: image.height as u32,
        pixels: image.rgba,
        pixels_per_meter_x: 0,
        pixels_per_meter_y: 0,
        icc: image.icc,
        author: Vec::new(),
        comment: Vec::new(),
        exif: image.exif,
        xmp: image.xmp,
        cmyk: false,
    })
}

/// Encodes a straight-RGBA image as an AVIF file (see `avif`). `chroma` is 0 (4:2:0), 1 (4:2:2) or 2
/// (4:4:4). `lossless` writes the identity matrix at 4:4:4 and ignores `quality`. `lossless_alpha`
/// writes the alpha plane losslessly, and otherwise `alpha_quality` applies. `speed` is 1 to 10, and
/// `premultiplied` stores the color premultiplied. `exif` is a TIFF-structured block and `xmp` one XMP
/// packet (empty for none). `icc` is the ICC profile (empty for none).
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn encode_avif(
    width: u32,
    height: u32,
    rgba: &[u8],
    lossless: bool,
    quality: u8,
    lossless_alpha: bool,
    alpha_quality: u8,
    speed: u8,
    chroma: u8,
    premultiplied: bool,
    exif: &[u8],
    xmp: &[u8],
    icc: &[u8],
) -> Result<Vec<u8>, JsError> {
    let chroma = avif::Chroma::from_id(chroma).map_err(|message| JsError::new(&message))?;
    avif::encode(&avif::Spec {
        width: width as usize,
        height: height as usize,
        rgba,
        lossless,
        quality,
        lossless_alpha,
        alpha_quality,
        speed,
        chroma,
        premultiplied,
        icc,
        exif,
        xmp,
    })
    .map_err(|message| JsError::new(&message))
}

/// The metadata of an AVIF file (see `avif::metadata`): the EXIF block, the XMP packet and the ICC profile.
/// Empty when the file has none.
#[wasm_bindgen]
pub struct AvifMetadata {
    exif: Vec<u8>,
    xmp: Vec<u8>,
    icc: Vec<u8>,
}

#[wasm_bindgen]
impl AvifMetadata {
    /// The TIFF-structured EXIF block, or empty when the file has none.
    #[wasm_bindgen(getter)]
    pub fn exif(&self) -> Vec<u8> {
        self.exif.clone()
    }

    /// The XMP packet, or empty when the file has none.
    #[wasm_bindgen(getter)]
    pub fn xmp(&self) -> Vec<u8> {
        self.xmp.clone()
    }

    /// The ICC profile of the primary item, or empty when the file has none.
    #[wasm_bindgen(getter)]
    pub fn icc(&self) -> Vec<u8> {
        self.icc.clone()
    }
}

/// Reads the metadata of an AVIF file (see `avif::metadata`). The pixels are decoded by libavif (WEB-FILE-07).
#[wasm_bindgen]
pub fn read_avif_metadata(bytes: &[u8]) -> Result<AvifMetadata, JsError> {
    let metadata = avif::metadata(bytes).map_err(|message| JsError::new(&message))?;
    Ok(AvifMetadata {
        exif: metadata.exif,
        xmp: metadata.xmp,
        icc: metadata.icc,
    })
}

/// Wraps a JPEG XL codestream (encoded by libjxl) in the container with its EXIF and XMP boxes (see
/// `jxl`). `exif` is a TIFF-structured block and `xmp` one XMP packet (empty for none).
#[wasm_bindgen]
pub fn wrap_jxl(codestream: &[u8], exif: &[u8], xmp: &[u8]) -> Result<Vec<u8>, JsError> {
    jxl::wrap(codestream, exif, xmp).map_err(|message| JsError::new(&message))
}

/// Decodes a JPEG XL file (see `jxl`) into straight RGBA, with its ICC profile, EXIF and XMP boxes.
#[wasm_bindgen]
pub fn decode_jxl(bytes: &[u8]) -> Result<DecodedImage, JsError> {
    let image = jxl::decode(bytes).map_err(|message| JsError::new(&message))?;
    Ok(DecodedImage {
        width: image.width as u32,
        height: image.height as u32,
        pixels: image.rgba,
        pixels_per_meter_x: 0,
        pixels_per_meter_y: 0,
        icc: image.icc,
        author: Vec::new(),
        comment: Vec::new(),
        exif: image.exif,
        xmp: image.xmp,
        cmyk: false,
    })
}

/// A JPEG in the channels of the file (see `jpeg::decode`): gray, RGB or CMYK ink, one byte per channel.
#[wasm_bindgen]
pub struct JpegRaster {
    width: u32,
    height: u32,
    channels: u32,
    samples: Vec<u8>,
}

#[wasm_bindgen]
impl JpegRaster {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Samples per pixel: 1 gray, 3 RGB or 4 CMYK.
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 {
        self.channels
    }

    /// The samples, top row first, `channels` bytes per pixel.
    #[wasm_bindgen(getter)]
    pub fn samples(&self) -> Vec<u8> {
        self.samples.clone()
    }
}

/// Decodes a JPEG into its own channels, without converting them (see `jpeg::decode`). Color conversion is
/// done by the color engine, so an embedded profile or CMYK is kept until then.
#[wasm_bindgen]
pub fn decode_jpeg(bytes: &[u8]) -> Result<JpegRaster, JsError> {
    let raster = jpeg::decode(bytes).map_err(|message| JsError::new(&message))?;
    Ok(JpegRaster {
        width: raster.width as u32,
        height: raster.height as u32,
        channels: raster.channels as u32,
        samples: raster.samples,
    })
}

/// A PNG in straight RGBA8, top row first (see `png_decode::decode`).
#[wasm_bindgen]
pub struct PngRaster {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[wasm_bindgen]
impl PngRaster {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// The straight RGBA bytes, four per pixel.
    #[wasm_bindgen(getter)]
    pub fn pixels(&self) -> Vec<u8> {
        self.pixels.clone()
    }
}

/// Decodes a PNG to straight RGBA8 for the color engine (see `png_decode::decode`).
#[wasm_bindgen]
pub fn decode_png(bytes: &[u8]) -> Result<PngRaster, JsError> {
    let raster = png_decode::decode(bytes).map_err(|message| JsError::new(&message))?;
    Ok(PngRaster {
        width: raster.width as u32,
        height: raster.height as u32,
        pixels: raster.pixels,
    })
}

/// Decodes the top mip level of a DDS texture (see `dds`) into straight RGBA. The file has no metadata.
#[wasm_bindgen]
pub fn decode_dds(bytes: &[u8]) -> Result<DecodedImage, JsError> {
    let image = dds::decode(bytes).map_err(|message| JsError::new(&message))?;
    Ok(DecodedImage {
        width: image.width as u32,
        height: image.height as u32,
        pixels: image.rgba,
        pixels_per_meter_x: 0,
        pixels_per_meter_y: 0,
        icc: Vec::new(),
        author: Vec::new(),
        comment: Vec::new(),
        exif: Vec::new(),
        xmp: Vec::new(),
        cmyk: false,
    })
}

/// A decoded BMP, GIF, TIFF, TGA or WebP image: straight RGBA pixels, top row first, and the pixels per meter
/// of the file's header (zero when it has none). A CMYK TIFF holds CMYK ink instead (see `cmyk`).
#[wasm_bindgen]
pub struct DecodedImage {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    pixels_per_meter_x: u32,
    pixels_per_meter_y: u32,
    icc: Vec<u8>,
    author: Vec<u8>,
    comment: Vec<u8>,
    exif: Vec<u8>,
    xmp: Vec<u8>,
    cmyk: bool,
}

#[wasm_bindgen]
impl DecodedImage {
    /// The TIFF-structured EXIF block of IFD0 (TIFF only), or empty when there is none.
    #[wasm_bindgen(getter)]
    pub fn exif(&self) -> Vec<u8> {
        self.exif.clone()
    }

    /// The XMP packet (TIFF and GIF), or empty when the file has none.
    #[wasm_bindgen(getter)]
    pub fn xmp(&self) -> Vec<u8> {
        self.xmp.clone()
    }

    /// True when `pixels` holds CMYK ink, four bytes per pixel with 255 full ink, instead of RGBA (CMYK
    /// TIFF only). The caller converts it to sRGB with the color engine.
    #[wasm_bindgen(getter)]
    pub fn cmyk(&self) -> bool {
        self.cmyk
    }
}

#[wasm_bindgen]
impl DecodedImage {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// The embedded ICC profile (BMP), or empty when the file has none.
    #[wasm_bindgen(getter)]
    pub fn icc(&self) -> Vec<u8> {
        self.icc.clone()
    }

    /// The TGA author field, or empty when the file has none.
    #[wasm_bindgen(getter)]
    pub fn author(&self) -> Vec<u8> {
        self.author.clone()
    }

    /// The TGA comment lines, or empty when the file has none.
    #[wasm_bindgen(getter)]
    pub fn comment(&self) -> Vec<u8> {
        self.comment.clone()
    }

    /// Straight RGBA, four bytes per pixel.
    #[wasm_bindgen(getter)]
    pub fn pixels(&self) -> Vec<u8> {
        self.pixels.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn pixels_per_meter_x(&self) -> u32 {
        self.pixels_per_meter_x
    }

    #[wasm_bindgen(getter)]
    pub fn pixels_per_meter_y(&self) -> u32 {
        self.pixels_per_meter_y
    }
}

/// A palette and one index per pixel, returned by `quantize_palette`.
#[wasm_bindgen]
pub struct QuantizedPalette {
    palette: Vec<u8>,
    indices: Vec<u8>,
}

#[wasm_bindgen]
impl QuantizedPalette {
    /// RGB triples, one per palette entry.
    #[wasm_bindgen(getter)]
    pub fn palette(&self) -> Vec<u8> {
        self.palette.clone()
    }

    /// One palette index per pixel, row by row. Transparent pixels hold 0.
    #[wasm_bindgen(getter)]
    pub fn indices(&self) -> Vec<u8> {
        self.indices.clone()
    }
}

/// Builds an 8-bit palette for straight RGBA8 pixels and maps every pixel to it (see `quantize`).
/// `capacity` is the most entries the palette may hold (2 to 256). `transparent_entry` leaves
/// pixels with alpha 0 out of the palette. `algorithm` is 0 for Median Cut or 1 for Octree.
/// `dithering` is 0 (none) to 8 (strongest).
#[wasm_bindgen]
pub fn quantize_palette(
    rgba: &[u8],
    width: u32,
    height: u32,
    capacity: u32,
    transparent_entry: bool,
    algorithm: u8,
    dithering: u8,
) -> Result<QuantizedPalette, JsError> {
    let algorithm = quantize::Algorithm::try_from(algorithm)
        .map_err(|id| JsError::new(&format!("unknown quantization algorithm {id}")))?;
    let out = quantize::quantize(&quantize::Request {
        rgba,
        width: width as usize,
        height: height as usize,
        capacity: capacity as usize,
        transparent_entry,
        algorithm,
        dithering,
    })
    .map_err(|message| JsError::new(&message))?;
    Ok(QuantizedPalette {
        palette: out.palette,
        indices: out.indices,
    })
}

/// Converts straight-alpha RGBA8 pixels to premultiplied alpha in place,
/// rounding each color channel to nearest: `(c * a + 127) / 255`.
#[wasm_bindgen]
pub fn premultiply_rgba8(pixels: &mut [u8]) {
    for [r, g, b, a] in pixels.as_chunks_mut::<4>().0 {
        // Opaque pixels keep their color: (c·255 + 127) / 255 = c.
        if *a == 255 {
            continue;
        }
        let a = u16::from(*a);
        for c in [r, g, b] {
            *c = ((u16::from(*c) * a + 127) / 255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn premultiplies_color_channels_and_keeps_alpha() {
        let mut px = [255, 128, 0, 255, 255, 128, 1, 128, 200, 100, 50, 0];
        premultiply_rgba8(&mut px);
        assert_eq!(px, [255, 128, 0, 255, 128, 64, 1, 128, 0, 0, 0, 0]);
    }

    #[test]
    fn box_halve_averages_each_two_by_two_group_rounded_to_nearest() {
        let edge = 6;
        let block: Vec<u8> = (0..edge * edge * 4).map(|i| ((i * 131 + i / 7) % 256) as u8).collect();
        let out = box_halve(&block, edge);
        for y in 0..edge / 2 {
            for x in 0..edge / 2 {
                for c in 0..4 {
                    let at = |dx: usize, dy: usize| {
                        u16::from(block[((2 * y + dy) * edge + 2 * x + dx) * 4 + c])
                    };
                    let expected = ((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1) + 2) >> 2) as u8;
                    assert_eq!(out[(y * edge / 2 + x) * 4 + c], expected);
                }
            }
        }
        assert_eq!(box_halve(&[10, 0, 0, 20, 11, 0, 0, 20, 12, 0, 0, 20, 13, 1, 0, 21], 2), [12, 0, 0, 20]);
    }

    #[test]
    fn premultiply_matches_the_formula_for_every_color_and_alpha() {
        for a in 0..=255u16 {
            let mut px: Vec<u8> = (0..=255u8).flat_map(|c| [c, c, 255 - c, a as u8]).collect();
            premultiply_rgba8(&mut px);
            for (i, chunk) in px.chunks(4).enumerate() {
                let c = i as u16;
                let expected = |v: u16| ((v * a + 127) / 255) as u8;
                assert_eq!(chunk, [expected(c), expected(c), expected(255 - c), a as u8]);
            }
        }
    }
}
