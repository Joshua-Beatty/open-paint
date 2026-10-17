//! PNG decoder for files with an embedded ICC profile (FMT-META-03). The pixels come back as straight
//! RGBA8 so the color engine can convert them. The browser's decoder would apply the profile with its
//! own engine, so these files stay in WASM. The `png` crate does the decoding.

use png::{ColorType, Transformations};
use std::io::Cursor;

/// A decoded PNG as straight RGBA8, top row first.
pub struct Raster {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<u8>,
}

/// Decodes a PNG to straight RGBA8. Palette, low-bit and transparency data expand to RGBA, and 16-bit
/// samples reduce to 8 bits (FMT-META-03 SHOULD).
pub fn decode(bytes: &[u8]) -> Result<Raster, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| "The PNG is too large.".to_string())?;
    let mut buffer = vec![0; size];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| error.to_string())?;
    let data = &buffer[..info.buffer_size()];
    Ok(Raster {
        width: info.width as usize,
        height: info.height as usize,
        pixels: to_rgba(data, info.color_type)?,
    })
}

fn to_rgba(data: &[u8], color: ColorType) -> Result<Vec<u8>, String> {
    Ok(match color {
        ColorType::Rgba => data.to_vec(),
        ColorType::Rgb => data
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|&[red, green, blue]| [red, green, blue, 255])
            .collect(),
        ColorType::GrayscaleAlpha => data
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|&[level, alpha]| [level, level, level, alpha])
            .collect(),
        ColorType::Grayscale => data
            .iter()
            .flat_map(|&level| [level, level, level, 255])
            .collect(),
        ColorType::Indexed => return Err("The PNG palette was not expanded.".to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(
        width: u32,
        height: u32,
        color: ColorType,
        depth: png::BitDepth,
        data: &[u8],
    ) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(color);
            encoder.set_depth(depth);
            let mut writer = encoder.write_header().expect("header");
            writer.write_image_data(data).expect("data");
        }
        out
    }

    #[test]
    fn rgb_gains_opaque_alpha() {
        let bytes = encode(
            2,
            1,
            ColorType::Rgb,
            png::BitDepth::Eight,
            &[1, 2, 3, 4, 5, 6],
        );
        let raster = decode(&bytes).expect("decodes");
        assert_eq!((raster.width, raster.height), (2, 1));
        assert_eq!(raster.pixels, vec![1, 2, 3, 255, 4, 5, 6, 255]);
    }

    #[test]
    fn gray_alpha_repeats_the_level() {
        let bytes = encode(
            1,
            1,
            ColorType::GrayscaleAlpha,
            png::BitDepth::Eight,
            &[90, 7],
        );
        assert_eq!(decode(&bytes).expect("decodes").pixels, vec![90, 90, 90, 7]);
    }

    #[test]
    fn sixteen_bit_samples_reduce_to_eight() {
        let bytes = encode(
            1,
            1,
            ColorType::Rgba,
            png::BitDepth::Sixteen,
            &[0x80, 0x01, 0x80, 0x01, 0x80, 0x01, 0xff, 0xff],
        );
        let pixels = decode(&bytes).expect("decodes").pixels;
        assert_eq!(pixels.len(), 4);
        assert_eq!(pixels[3], 255);
    }

    #[test]
    fn low_bit_gray_expands_to_full_levels() {
        let bytes = encode(
            2,
            1,
            ColorType::Grayscale,
            png::BitDepth::One,
            &[0b1000_0000],
        );
        assert_eq!(
            decode(&bytes).expect("decodes").pixels,
            vec![255, 255, 255, 255, 0, 0, 0, 255]
        );
    }

    #[test]
    fn refuses_bytes_that_are_not_a_png() {
        assert!(decode(b"not a png").is_err());
    }
}
