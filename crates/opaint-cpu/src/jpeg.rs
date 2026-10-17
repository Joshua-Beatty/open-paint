//! JPEG encoder and decoder for the flat formats (FMT-OPT-JPG-01, FMT-META-03).
//!
//! The caller flattens the image over white and chooses the quality and chroma sampling. This module
//! writes the baseline JFIF file: the density (JFIF APP0), the sRGB profile (APP2), the EXIF (APP1),
//! the XMP packets (APP1) and the IPTC records (APP13). The entropy coder is jpeg-encoder. The decoder
//! returns the samples in the file's own channels, so the color engine can convert an embedded profile
//! or a CMYK file. It uses jpeg-decoder.

use jpeg_decoder::PixelFormat;
use jpeg_encoder::{
    ChromaSubsamplingMethod, ColorType, Encoder, PixelDensity, PixelDensityUnit, SamplingFactor,
};

const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const PHOTOSHOP_HEADER: &[u8] = b"Photoshop 3.0\0";
const IPTC_RESOURCE_ID: u16 = 0x0404;

/// A decoded JPEG in the channels of the file: one (gray), three (RGB) or four (CMYK). `samples` holds
/// `channels` bytes per pixel, top row first. CMYK samples are ink, so 255 is full ink: jpeg-decoder
/// inverts the stored CMYK values, which Adobe writes inverted.
pub struct Raster {
    pub width: usize,
    pub height: usize,
    pub channels: usize,
    pub samples: Vec<u8>,
}

/// Everything the encoder writes for one image. `pixels` is RGB, three bytes per pixel.
pub struct Spec<'a> {
    pub width: usize,
    pub height: usize,
    pub pixels: &'a [u8],
    pub quality: u8,
    pub sampling: SamplingFactor,
    /// Dots per inch on each axis. `None` writes a pixel aspect ratio only.
    pub dpi: Option<(u16, u16)>,
    pub icc: &'a [u8],
    /// TIFF-structured EXIF, without the `Exif\0\0` prefix.
    pub exif: &'a [u8],
    /// XMP packets, each written as its own APP1 segment.
    pub xmp: &'a [&'a [u8]],
    /// IPTC-IIM records, wrapped as the 8BIM image resource 0x0404 of an APP13 segment.
    pub iptc: &'a [u8],
}

/// Maps the chroma subsampling choice ids (0 = 4:4:4, 1 = 4:4:0, 2 = 4:2:2, 3 = 4:2:0) to a factor.
pub fn sampling_from_id(id: u8) -> Result<SamplingFactor, String> {
    match id {
        0 => Ok(SamplingFactor::R_4_4_4),
        1 => Ok(SamplingFactor::R_4_4_0),
        2 => Ok(SamplingFactor::R_4_2_2),
        3 => Ok(SamplingFactor::R_4_2_0),
        other => Err(format!("unknown chroma subsampling {other}.")),
    }
}

/// Writes the JPEG file described by `spec`.
pub fn encode(spec: &Spec) -> Result<Vec<u8>, String> {
    let width = u16::try_from(spec.width).map_err(|_| "JPEG width is too large.".to_string())?;
    let height = u16::try_from(spec.height).map_err(|_| "JPEG height is too large.".to_string())?;
    if spec.pixels.len() != spec.width * spec.height * 3 {
        return Err("JPEG pixel data does not match the image size.".to_string());
    }
    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, spec.quality);
    encoder.set_sampling_factor(spec.sampling);
    encoder.set_chroma_subsampling_method(ChromaSubsamplingMethod::Average);
    if let Some((x, y)) = spec.dpi {
        encoder.set_density(PixelDensity {
            density: (x, y),
            unit: PixelDensityUnit::Inches,
        });
    }
    if !spec.icc.is_empty() {
        encoder
            .add_icc_profile(spec.icc)
            .map_err(|e| e.to_string())?;
    }
    if !spec.exif.is_empty() {
        encoder
            .add_exif_metadata(spec.exif)
            .map_err(|e| e.to_string())?;
    }
    for packet in spec.xmp {
        let mut segment = XMP_HEADER.to_vec();
        segment.extend_from_slice(packet);
        encoder
            .add_app_segment(1, segment)
            .map_err(|e| e.to_string())?;
    }
    if !spec.iptc.is_empty() {
        encoder
            .add_app_segment(13, photoshop_iptc(spec.iptc))
            .map_err(|e| e.to_string())?;
    }
    encoder
        .encode(spec.pixels, width, height, ColorType::Rgb)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Decodes a baseline or progressive JPEG into the channels of the file (see `Raster`). Other pixel
/// layouts, such as 16-bit gray, are refused.
pub fn decode(bytes: &[u8]) -> Result<Raster, String> {
    let mut decoder = jpeg_decoder::Decoder::new(bytes);
    let samples = decoder.decode().map_err(|error| error.to_string())?;
    let info = decoder
        .info()
        .ok_or_else(|| "The JPEG has no image information.".to_string())?;
    let channels = match info.pixel_format {
        PixelFormat::L8 => 1,
        PixelFormat::RGB24 => 3,
        PixelFormat::CMYK32 => 4,
        _ => return Err("The JPEG pixel layout is not supported.".to_string()),
    };
    Ok(Raster {
        width: usize::from(info.width),
        height: usize::from(info.height),
        channels,
        samples,
    })
}

/// The APP13 body: the Photoshop header and one 8BIM IPTC resource (padded to an even length).
fn photoshop_iptc(records: &[u8]) -> Vec<u8> {
    let mut body = PHOTOSHOP_HEADER.to_vec();
    body.extend_from_slice(b"8BIM");
    body.extend_from_slice(&IPTC_RESOURCE_ID.to_be_bytes());
    body.extend_from_slice(&[0, 0]);
    body.extend_from_slice(&(records.len() as u32).to_be_bytes());
    body.extend_from_slice(records);
    if !records.len().is_multiple_of(2) {
        body.push(0);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gray(width: usize, height: usize) -> Vec<u8> {
        (0..width * height * 3).map(|i| (i % 251) as u8).collect()
    }

    fn segments(bytes: &[u8]) -> Vec<(u8, &[u8])> {
        let mut found = Vec::new();
        let mut offset = 2;
        while offset + 4 <= bytes.len() && bytes[offset] == 0xff {
            let marker = bytes[offset + 1];
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
            found.push((marker, &bytes[offset + 4..offset + 2 + length]));
            offset += 2 + length;
        }
        found
    }

    fn spec<'a>(pixels: &'a [u8], xmp: &'a [&'a [u8]]) -> Spec<'a> {
        Spec {
            width: 4,
            height: 4,
            pixels,
            quality: 95,
            sampling: SamplingFactor::R_4_2_0,
            dpi: None,
            icc: &[],
            exif: &[],
            xmp,
            iptc: &[],
        }
    }

    #[test]
    fn writes_a_jfif_file_with_start_and_end_markers() {
        let pixels = gray(4, 4);
        let bytes = encode(&spec(&pixels, &[])).unwrap();
        assert_eq!(&bytes[..2], &[0xff, 0xd8]);
        assert_eq!(&bytes[bytes.len() - 2..], &[0xff, 0xd9]);
        assert_eq!(segments(&bytes)[0].0, 0xe0);
        assert_eq!(&segments(&bytes)[0].1[..5], b"JFIF\0");
    }

    #[test]
    fn writes_the_density_in_dots_per_inch() {
        let pixels = gray(4, 4);
        let mut request = spec(&pixels, &[]);
        request.dpi = Some((300, 150));
        let bytes = encode(&request).unwrap();
        let jfif = segments(&bytes)[0].1;
        assert_eq!(jfif[7], 1, "units are dots per inch");
        assert_eq!(u16::from_be_bytes([jfif[8], jfif[9]]), 300);
        assert_eq!(u16::from_be_bytes([jfif[10], jfif[11]]), 150);
    }

    #[test]
    fn writes_the_chosen_chroma_sampling() {
        let pixels = gray(4, 4);
        for (id, expected) in [(0u8, 0x11u8), (1, 0x12), (2, 0x21), (3, 0x22)] {
            let mut request = spec(&pixels, &[]);
            request.sampling = sampling_from_id(id).unwrap();
            let bytes = encode(&request).unwrap();
            let sof = bytes
                .windows(2)
                .position(|pair| pair == [0xff, 0xc0])
                .unwrap();
            // SOF0: marker, length (2), precision (1), height (2), width (2), components (1), then
            // the first component's id (1) and its sampling byte.
            assert_eq!(bytes[sof + 11], expected, "sampling id {id}");
        }
    }

    #[test]
    fn writes_the_metadata_segments_in_order() {
        let pixels = gray(4, 4);
        let packet: &[u8] = b"<x:xmpmeta/>";
        let xmp = [packet];
        let mut request = spec(&pixels, &xmp);
        let icc = [1u8, 2, 3];
        let exif = [0x49u8, 0x49, 0x2a, 0x00];
        request.icc = &icc;
        request.exif = &exif;
        request.iptc = &[0x1c, 0x02, 0x00];
        let bytes = encode(&request).unwrap();
        let markers: Vec<(u8, Vec<u8>)> = segments(&bytes)
            .into_iter()
            .map(|(marker, body)| (marker, body.to_vec()))
            .collect();
        let find = |marker: u8, prefix: &[u8]| {
            markers
                .iter()
                .position(|(m, body)| *m == marker && body.starts_with(prefix))
        };
        let exif_at = find(0xe1, b"Exif\0\0").unwrap();
        let xmp_at = find(0xe1, XMP_HEADER).unwrap();
        let icc_at = find(0xe2, b"ICC_PROFILE\0").unwrap();
        let iptc_at = find(0xed, PHOTOSHOP_HEADER).unwrap();
        assert!(icc_at < exif_at && exif_at < xmp_at && xmp_at < iptc_at);
        assert_eq!(&markers[exif_at].1[6..], &exif);
        assert_eq!(&markers[xmp_at].1[XMP_HEADER.len()..], packet);
    }

    #[test]
    fn photoshop_resource_is_padded_to_an_even_length() {
        let body = photoshop_iptc(&[1, 2, 3]);
        let resource = &body[PHOTOSHOP_HEADER.len()..];
        assert_eq!(&resource[..4], b"8BIM");
        assert_eq!(u16::from_be_bytes([resource[4], resource[5]]), 0x0404);
        assert_eq!(
            u32::from_be_bytes([resource[8], resource[9], resource[10], resource[11]]),
            3
        );
        assert_eq!(resource.len() % 2, 0);
    }

    #[test]
    fn rejects_mismatched_pixels_and_unknown_sampling() {
        let pixels = gray(2, 2);
        assert!(encode(&spec(&pixels, &[])).is_err());
        assert!(sampling_from_id(4).is_err());
    }

    #[test]
    fn decodes_a_flat_color_back_within_a_few_levels() {
        let pixels: Vec<u8> = [200u8, 100, 50].repeat(16);
        let raster = decode(&encode(&spec(&pixels, &[])).unwrap()).unwrap();
        assert_eq!((raster.width, raster.height, raster.channels), (4, 4, 3));
        for pixel in raster.samples.as_chunks::<3>().0 {
            for (value, expected) in pixel.iter().zip([200u8, 100, 50]) {
                assert!(value.abs_diff(expected) <= 3, "{value} vs {expected}");
            }
        }
    }

    #[test]
    fn decodes_gray_to_one_channel() {
        let mut out = Vec::new();
        Encoder::new(&mut out, 100)
            .encode(&[128u8; 64], 8, 8, ColorType::Luma)
            .unwrap();
        let raster = decode(&out).unwrap();
        assert_eq!((raster.channels, raster.samples.len()), (1, 64));
    }

    #[test]
    fn decodes_cmyk_back_to_ink() {
        let ink: Vec<u8> = [200u8, 0, 100, 50].repeat(8 * 8);
        let mut out = Vec::new();
        Encoder::new(&mut out, 100)
            .encode(&ink, 8, 8, ColorType::Cmyk)
            .unwrap();
        let raster = decode(&out).unwrap();
        assert_eq!(raster.channels, 4);
        for pixel in raster.samples.as_chunks::<4>().0 {
            for (value, expected) in pixel.iter().zip([200u8, 0, 100, 50]) {
                assert!(value.abs_diff(expected) <= 4, "{value} vs {expected}");
            }
        }
    }

    #[test]
    fn refuses_bytes_that_are_not_a_jpeg() {
        assert!(decode(b"not a jpeg at all").is_err());
    }
}
