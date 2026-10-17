//! AVIF still-image encoder (FMT-OPT-AVIF-01). The color and alpha planes are AV1 intra frames from
//! rav1e, and avif-serialize boxes them. Decoding is left to libavif (WEB-FILE-07), in the codec worker.

use avif_serialize::constants::MatrixCoefficients as BoxedMatrix;
use avif_serialize::Aviffy;
use rav1e::prelude::*;

use crate::bmff;

/// The chroma subsampling choices (FMT-OPT-AVIF-01), by their option value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chroma {
    Yuv420,
    Yuv422,
    Yuv444,
}

impl Chroma {
    /// Maps the option id (0 = 4:2:0, 1 = 4:2:2, 2 = 4:4:4) to a subsampling.
    pub fn from_id(id: u8) -> Result<Self, String> {
        match id {
            0 => Ok(Self::Yuv420),
            1 => Ok(Self::Yuv422),
            2 => Ok(Self::Yuv444),
            _ => Err(format!("unknown AVIF chroma subsampling {id}")),
        }
    }

    /// The horizontal and vertical subsampling flags the AV1 configuration records.
    fn flags(self) -> (bool, bool) {
        match self {
            Self::Yuv420 => (true, true),
            Self::Yuv422 => (true, false),
            Self::Yuv444 => (false, false),
        }
    }

    fn sampling(self) -> ChromaSampling {
        match self {
            Self::Yuv420 => ChromaSampling::Cs420,
            Self::Yuv422 => ChromaSampling::Cs422,
            Self::Yuv444 => ChromaSampling::Cs444,
        }
    }
}

/// One AVIF to write. `rgba` is straight RGBA, four bytes per pixel, top row first.
pub struct Spec<'a> {
    pub width: usize,
    pub height: usize,
    pub rgba: &'a [u8],
    /// Identity matrix, 4:4:4 and quantizer 0 (FMT-OPT-AVIF-01 "Lossless").
    pub lossless: bool,
    /// 1 to 100. Ignored when `lossless` is set.
    pub quality: u8,
    /// Encodes the alpha plane losslessly, whatever `alpha_quality` says.
    pub lossless_alpha: bool,
    /// 1 to 100, for the alpha plane when it is not lossless.
    pub alpha_quality: u8,
    /// 1 (slowest, smallest) to 10 (fastest).
    pub speed: u8,
    pub chroma: Chroma,
    /// Stores the color channels premultiplied, and records that in the container.
    pub premultiplied: bool,
    /// The ICC profile (sRGB in v1), written as a `colr` property of type `prof` next to the CICP box.
    /// Empty writes none.
    pub icc: &'a [u8],
    /// A TIFF-structured EXIF block, written as the `Exif` item. Empty writes none.
    pub exif: &'a [u8],
    /// One XMP packet, written as a `mime` item that refers to the image. Empty writes none.
    pub xmp: &'a [u8],
}

/// The metadata of an AVIF: a TIFF-structured EXIF block, one XMP packet and the ICC profile. Empty when the
/// file has no such item.
pub struct Metadata {
    pub exif: Vec<u8>,
    pub xmp: Vec<u8>,
    pub icc: Vec<u8>,
}

/// An 8-bit plane, row by row, with its own width and height.
struct Plane8 {
    width: usize,
    height: usize,
    data: Vec<u8>,
}

/// Encodes the image as an AVIF file (AV1 color, plus an alpha plane when any pixel is not opaque).
pub fn encode(spec: &Spec) -> Result<Vec<u8>, String> {
    let (width, height) = (spec.width, spec.height);
    if width == 0 || height == 0 {
        return Err("an AVIF needs a non-empty image".into());
    }
    if spec.rgba.len() != width * height * 4 {
        return Err("the pixel buffer does not match the image size".into());
    }
    let mut pixels = spec.rgba.to_vec();
    if spec.premultiplied {
        crate::premultiply_rgba8(&mut pixels);
    }
    let has_alpha = pixels.as_chunks::<4>().0.iter().any(|px| px[3] != 255);

    let color = color_planes(&pixels, width, height, spec.lossless, spec.chroma);
    let color_av1 = encode_av1(width, height, &color, color_settings(spec))?;

    let alpha_av1 = if has_alpha {
        let alpha: Vec<u8> = pixels.as_chunks::<4>().0.iter().map(|px| px[3]).collect();
        let plane = Plane8 {
            width,
            height,
            data: alpha,
        };
        Some(encode_av1(
            width,
            height,
            std::slice::from_ref(&plane),
            alpha_settings(spec),
        )?)
    } else {
        None
    };

    let (sub_x, sub_y) = if spec.lossless {
        (false, false)
    } else {
        spec.chroma.flags()
    };
    let mut aviffy = Aviffy::new();
    aviffy
        .set_chroma_subsampling((sub_x, sub_y))
        .set_matrix_coefficients(if spec.lossless {
            BoxedMatrix::Rgb
        } else {
            BoxedMatrix::Bt601
        })
        .set_full_color_range(true)
        .set_premultiplied_alpha(spec.premultiplied);
    if !spec.exif.is_empty() {
        aviffy.set_exif(spec.exif.to_vec());
    }
    let file = aviffy.to_vec(
        &color_av1,
        alpha_av1.as_deref(),
        width as u32,
        height as u32,
        8,
    );
    finish(spec, file)
}

/// Adds the ICC profile and the XMP packet to a written file.
fn finish(spec: &Spec, file: Vec<u8>) -> Result<Vec<u8>, String> {
    let file = if spec.icc.is_empty() {
        file
    } else {
        bmff::add_icc_profile(&file, spec.icc)?
    };
    if spec.xmp.is_empty() {
        Ok(file)
    } else {
        bmff::add_mime_item(&file, bmff::XMP_CONTENT_TYPE, spec.xmp)
    }
}

/// Reads the metadata of an AVIF file (FMT-META-01, FMT-META-03): the EXIF and XMP items and the ICC profile
/// of the primary item. The EXIF item's 4-byte prefix (the offset of the TIFF header) is removed, so the result
/// is the TIFF-structured block the other codecs use. An EXIF item that is not a TIFF block is left out.
pub fn metadata(file: &[u8]) -> Result<Metadata, String> {
    let exif = match bmff::item_data(file, b"Exif", None)? {
        Some(item) => exif_block_of(&item),
        None => Vec::new(),
    };
    let xmp = bmff::item_data(file, b"mime", Some(bmff::XMP_CONTENT_TYPE.as_bytes()))?
        .unwrap_or_default();
    let icc = bmff::primary_icc(file).unwrap_or_default();
    Ok(Metadata { exif, xmp, icc })
}

fn exif_block_of(item: &[u8]) -> Vec<u8> {
    let Some(prefix) = item.get(..4) else {
        return Vec::new();
    };
    let offset = u32::from_be_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
    let Some(block) = 4usize
        .checked_add(offset)
        .and_then(|start| item.get(start..))
    else {
        return Vec::new();
    };
    if crate::ifd::ifd0_entries(block).is_some() {
        block.to_vec()
    } else {
        Vec::new()
    }
}

/// The color planes: Y, Cb, Cr with the chosen subsampling (BT.601, full range), or G, B, R at full
/// size for the identity matrix. Chroma samples average the block of pixels they cover.
fn color_planes(
    pixels: &[u8],
    width: usize,
    height: usize,
    lossless: bool,
    chroma: Chroma,
) -> Vec<Plane8> {
    let rgba = pixels.as_chunks::<4>().0;
    if lossless {
        let plane = |channel: usize| Plane8 {
            width,
            height,
            data: rgba.iter().map(|px| px[channel]).collect(),
        };
        return vec![plane(1), plane(2), plane(0)];
    }
    let (sub_x, sub_y) = chroma.flags();
    let (step_x, step_y) = (1 + usize::from(sub_x), 1 + usize::from(sub_y));
    let chroma_width = width.div_ceil(step_x);
    let chroma_height = height.div_ceil(step_y);
    let ycbcr: Vec<[u8; 3]> = rgba
        .iter()
        .map(|px| ycbcr_bt601(px[0], px[1], px[2]))
        .collect();
    let luma = Plane8 {
        width,
        height,
        data: ycbcr.iter().map(|px| px[0]).collect(),
    };
    let mut planes = vec![luma];
    for channel in [1usize, 2] {
        let mut data = Vec::with_capacity(chroma_width * chroma_height);
        for cy in 0..chroma_height {
            for cx in 0..chroma_width {
                let (x0, y0) = (cx * step_x, cy * step_y);
                let (x1, y1) = ((x0 + step_x).min(width), (y0 + step_y).min(height));
                let mut sum = 0u32;
                let mut count = 0u32;
                for y in y0..y1 {
                    for x in x0..x1 {
                        sum += u32::from(ycbcr[y * width + x][channel]);
                        count += 1;
                    }
                }
                data.push(((sum + count / 2) / count) as u8);
            }
        }
        planes.push(Plane8 {
            width: chroma_width,
            height: chroma_height,
            data,
        });
    }
    planes
}

/// BT.601 full-range Y, Cb, Cr for one pixel, rounded to nearest.
fn ycbcr_bt601(r: u8, g: u8, b: u8) -> [u8; 3] {
    const KR: f32 = 0.2990;
    const KG: f32 = 0.5870;
    const KB: f32 = 0.1140;
    let (r, g, b) = (f32::from(r), f32::from(g), f32::from(b));
    let y = KR * r + KG * g + KB * b;
    let cb = (b - y) * 0.5 / (1.0 - KB) + 128.0;
    let cr = (r - y) * 0.5 / (1.0 - KR) + 128.0;
    [clamp_u8(y), clamp_u8(cb), clamp_u8(cr)]
}

fn clamp_u8(value: f32) -> u8 {
    value.round().clamp(0.0, 255.0) as u8
}

/// The AV1 settings of the color planes: the quantizer and subsampling of the quality, or the identity matrix
/// and full chroma for lossless output (FMT-OPT-AVIF-01).
fn color_settings(spec: &Spec) -> Av1Settings {
    let (quantizer, sampling) = if spec.lossless {
        (0, ChromaSampling::Cs444)
    } else {
        (
            quality_to_quantizer(f32::from(spec.quality)),
            spec.chroma.sampling(),
        )
    };
    Av1Settings {
        sampling,
        quantizer,
        speed: spec.speed,
        color_description: Some(ColorDescription {
            transfer_characteristics: TransferCharacteristics::SRGB,
            color_primaries: ColorPrimaries::BT709,
            matrix_coefficients: if spec.lossless {
                MatrixCoefficients::Identity
            } else {
                MatrixCoefficients::BT601
            },
        }),
    }
}

/// The AV1 settings of the monochrome alpha plane.
fn alpha_settings(spec: &Spec) -> Av1Settings {
    let quantizer = if spec.lossless_alpha {
        0
    } else {
        quality_to_quantizer(f32::from(spec.alpha_quality))
    };
    Av1Settings {
        sampling: ChromaSampling::Cs400,
        quantizer,
        speed: spec.speed,
        color_description: None,
    }
}

/// The settings one AV1 intra frame is encoded with.
struct Av1Settings {
    sampling: ChromaSampling,
    quantizer: u8,
    speed: u8,
    color_description: Option<ColorDescription>,
}

/// Encodes one still AV1 frame from the given planes (one plane for monochrome, three otherwise).
fn encode_av1(
    width: usize,
    height: usize,
    planes: &[Plane8],
    settings: Av1Settings,
) -> Result<Vec<u8>, String> {
    let mut speed_settings = SpeedSettings::from_preset(settings.speed.clamp(1, 10));
    speed_settings.multiref = false;
    speed_settings.rdo_lookahead_frames = 1;
    speed_settings.scene_detection_mode = SceneDetectionSpeed::None;
    speed_settings.motion.include_near_mvs = false;
    let config = Config::new().with_encoder_config(EncoderConfig {
        width,
        height,
        time_base: Rational::new(1, 1),
        sample_aspect_ratio: Rational::new(1, 1),
        bit_depth: 8,
        chroma_sampling: settings.sampling,
        chroma_sample_position: ChromaSamplePosition::Unknown,
        pixel_range: PixelRange::Full,
        color_description: settings.color_description,
        mastering_display: None,
        content_light: None,
        enable_timing_info: false,
        still_picture: true,
        error_resilient: false,
        switch_frame_interval: 0,
        min_key_frame_interval: 0,
        max_key_frame_interval: 0,
        reservoir_frame_delay: None,
        low_latency: false,
        quantizer: usize::from(settings.quantizer),
        min_quantizer: settings.quantizer,
        bitrate: 0,
        // Lossless frames use PSNR tuning: psychovisual tuning changes the chroma quantization, and lossless
        // output must reproduce the pixels.
        tune: if settings.quantizer == 0 {
            Tune::Psnr
        } else {
            Tune::Psychovisual
        },
        tile_cols: 0,
        tile_rows: 0,
        tiles: 1,
        film_grain_params: None,
        level_idx: None,
        speed_settings,
    });
    let mut context: Context<u8> = config.new_context().map_err(|err| format!("{err:?}"))?;
    let mut frame = context.new_frame();
    for (target, source) in frame.planes.iter_mut().zip(planes) {
        let mut slice = target.mut_slice(Default::default());
        for (row, source_row) in slice
            .rows_iter_mut()
            .take(source.height)
            .zip(source.data.chunks_exact(source.width))
        {
            row[..source.width].copy_from_slice(source_row);
        }
    }
    context
        .send_frame(frame)
        .map_err(|err| format!("{err:?}"))?;
    context.flush();

    let mut out = Vec::new();
    loop {
        match context.receive_packet() {
            Ok(mut packet) => {
                if packet.frame_type == FrameType::KEY {
                    out.append(&mut packet.data);
                }
            }
            Err(EncoderStatus::Encoded | EncoderStatus::LimitReached) => break,
            Err(err) => return Err(format!("{err:?}")),
        }
    }
    Ok(out)
}

/// The quantizer for a quality from 1 to 100, on the rav1e scale (lower is better). The curve is
/// ravif's, so the same quality setting gives the same quantizer as the common AVIF tools.
fn quality_to_quantizer(quality: f32) -> u8 {
    let q = quality.clamp(1.0, 100.0) / 100.0;
    let x = if q >= 0.82 {
        (1.0 - q) * 2.6
    } else if q > 0.25 {
        q.mul_add(-0.5, 1.0 - 0.125)
    } else {
        1.0 - q
    };
    (x * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opaque_gradient(width: usize, height: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                out.extend_from_slice(&[(x * 3) as u8, (y * 3) as u8, 90, 255]);
            }
        }
        out
    }

    fn spec(rgba: &[u8], width: usize, height: usize) -> Spec<'_> {
        Spec {
            width,
            height,
            rgba,
            lossless: false,
            quality: 85,
            lossless_alpha: true,
            alpha_quality: 100,
            speed: 10,
            chroma: Chroma::Yuv422,
            premultiplied: false,
            icc: &[],
            exif: &[],
            xmp: &[],
        }
    }

    #[test]
    fn exif_and_xmp_items_round_trip_and_the_container_still_parses() {
        let rgba = opaque_gradient(16, 8);
        let exif = crate::ifd::exif_block(
            &[crate::ifd::Entry::new(0x013b, 2, 6, b"Ada\0\0\0".to_vec())],
            &[(
                crate::ifd::GPS_IFD,
                vec![crate::ifd::Entry::new(0x0001, 2, 2, b"N\0".to_vec())],
            )],
        )
        .unwrap();
        let xmp = b"<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"/>";
        let file = encode(&Spec {
            icc: b"sRGB profile bytes",
            exif: &exif,
            xmp,
            ..spec(&rgba, 16, 8)
        })
        .unwrap();
        let parsed = avif_parse::read_avif(&mut file.as_slice()).unwrap();
        assert_eq!(
            parsed.primary_item_metadata().unwrap().chroma_subsampling,
            (true, false)
        );
        assert_eq!(
            crate::bmff::primary_icc(&file).as_deref(),
            Some(&b"sRGB profile bytes"[..])
        );
        let metadata = metadata(&file).unwrap();
        assert_eq!(metadata.xmp, xmp);
        assert_eq!(metadata.exif, exif);
        assert_eq!(metadata.icc, b"sRGB profile bytes");
        assert_eq!(
            crate::ifd::sub_ifds(&metadata.exif)
                .iter()
                .map(|(tag, _)| *tag)
                .collect::<Vec<_>>(),
            vec![crate::ifd::GPS_IFD]
        );
    }

    #[test]
    fn a_file_without_metadata_reads_as_empty() {
        let rgba = opaque_gradient(8, 8);
        let file = encode(&spec(&rgba, 8, 8)).unwrap();
        let metadata = metadata(&file).unwrap();
        assert!(metadata.exif.is_empty());
        assert!(metadata.xmp.is_empty());
        assert!(metadata.icc.is_empty());
    }

    #[test]
    fn writes_an_avif_container_with_the_chosen_subsampling() {
        let rgba = opaque_gradient(32, 16);
        let file = encode(&spec(&rgba, 32, 16)).unwrap();
        let parsed = avif_parse::read_avif(&mut file.as_slice()).unwrap();
        let meta = parsed.primary_item_metadata().unwrap();
        assert_eq!(meta.bit_depth, 8);
        assert_eq!(meta.chroma_subsampling, (true, false));
        assert!(!meta.monochrome);
        assert!(parsed.alpha_item_metadata().unwrap().is_none());
    }

    #[test]
    fn adds_a_monochrome_alpha_item_when_a_pixel_is_not_opaque() {
        let mut rgba = opaque_gradient(16, 16);
        rgba[3] = 0;
        let file = encode(&spec(&rgba, 16, 16)).unwrap();
        let parsed = avif_parse::read_avif(&mut file.as_slice()).unwrap();
        let alpha = parsed.alpha_item_metadata().unwrap().unwrap();
        assert!(alpha.monochrome);
    }

    #[test]
    fn lossless_uses_full_chroma_and_the_identity_matrix() {
        let rgba = opaque_gradient(16, 8);
        let file = encode(&Spec {
            lossless: true,
            ..spec(&rgba, 16, 8)
        })
        .unwrap();
        let parsed = avif_parse::read_avif(&mut file.as_slice()).unwrap();
        let meta = parsed.primary_item_metadata().unwrap();
        assert_eq!(meta.chroma_subsampling, (false, false));
    }

    #[test]
    fn four_twenty_chroma_and_odd_sizes_encode() {
        let rgba = opaque_gradient(9, 7);
        let file = encode(&Spec {
            chroma: Chroma::Yuv420,
            ..spec(&rgba, 9, 7)
        })
        .unwrap();
        let parsed = avif_parse::read_avif(&mut file.as_slice()).unwrap();
        assert_eq!(
            parsed.primary_item_metadata().unwrap().chroma_subsampling,
            (true, true)
        );
    }

    #[test]
    fn rejects_a_buffer_that_does_not_match_the_size() {
        let rgba = [0u8; 8];
        assert!(encode(&spec(&rgba, 2, 2)).is_err());
    }

    #[test]
    fn quality_maps_to_the_ravif_quantizer_scale() {
        assert_eq!(quality_to_quantizer(100.0), 0);
        assert!(quality_to_quantizer(85.0) > quality_to_quantizer(95.0));
    }
}
