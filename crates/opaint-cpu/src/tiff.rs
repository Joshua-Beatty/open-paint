//! TIFF writer and reader (07 FMT-OPT-TIF-01, FMT-META-01, FMT-META-05).
//!
//! The writer emits one LZW-compressed strip, with the horizontal predictor for 8-bit samples (the
//! proposed [TBD] compression). It writes 32-bit RGBA, 24-bit RGB and palette images at 8, 4 and 1 bits.
//! The reader decodes the first page through the `tiff` crate, and it reads the density, the ICC profile,
//! the XMP packet and the EXIF entries of IFD0 through `ifd`.

use std::io::Cursor;

use tiff::decoder::{Decoder, DecodingResult};
use tiff::ColorType;

use crate::ifd::{self, Entry};

const PHOTOMETRIC: u16 = 262;
const PHOTOMETRIC_BLACK_IS_ZERO: u16 = 1;
const PHOTOMETRIC_PALETTE: u16 = 3;
const PHOTOMETRIC_RGB: u16 = 2;
const ORIENTATION: u16 = 274;
const ICC_PROFILE: u16 = 34675;
const XMP: u16 = 700;
const RESOLUTION_X: u16 = 282;
const RESOLUTION_Y: u16 = 283;
const RESOLUTION_UNIT: u16 = 296;
const EXTRA_SAMPLES: u16 = 338;
const COLOR_MAP: u16 = 320;
const PREDICTOR: u16 = 317;
const LZW: u16 = 5;
const HORIZONTAL_PREDICTOR: u16 = 2;
const UNASSOCIATED_ALPHA: u16 = 2;
const ASSOCIATED_ALPHA: u16 = 1;
const UNDEFINED: u16 = 7;
const BYTE: u16 = 1;
const RATIONAL: u16 = 5;
/// The largest decoded image, in RGBA bytes, that the reader accepts.
const MAX_RGBA_BYTES: usize = 1 << 30;
/// Centimeters per inch, for the ResolutionUnit conversion.
const CENTIMETERS_PER_INCH: f64 = 2.54;

/// One image to write. `pixels` is RGBA (32), RGB (24) or one palette index per pixel (8, 4 and 1 bits),
/// top row first. `palette` holds RGB triples, and it is used only by the indexed depths.
pub struct Spec<'a> {
    pub width: usize,
    pub height: usize,
    pub depth: u8,
    pub pixels: &'a [u8],
    pub palette: &'a [u8],
    pub icc: &'a [u8],
    /// Pixels per meter on each axis. Zero on either axis writes no density.
    pub pixels_per_meter: (u32, u32),
    /// A TIFF-structured EXIF block, whose IFD0 entries are copied (see `is_written_by_writer`).
    pub exif: &'a [u8],
    pub xmp: &'a [u8],
}

/// A decoded first page: straight RGBA, top row first, and the metadata of IFD0. A CMYK page holds CMYK
/// ink in the same four bytes per pixel instead (`cmyk` is then true).
pub struct Decoded {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
    pub cmyk: bool,
    pub pixels_per_meter: (u32, u32),
    pub icc: Vec<u8>,
    pub xmp: Vec<u8>,
    /// The EXIF block of IFD0, without the entries the TIFF structure owns. Empty when there are none.
    pub exif: Vec<u8>,
}

/// Tags that describe the pixel layout, the density, the palette, the extra samples or a sub-IFD. The
/// writer owns them, so the EXIF entries never repeat them (FMT-OPT-TIF-01 drops SampleFormat too).
fn is_written_by_writer(tag: u16) -> bool {
    matches!(
        tag,
        254..=266
            | 273
            | 277..=279
            | 280..=293
            | 296
            | 317
            | 320
            | 322..=327
            | 332
            | 333
            | 338
            | 339
            | 34665
            | 34675
            | 34853
            | 40965
            | XMP
    )
}

/// Encodes a prepared image as a TIFF file (see the module comment).
pub fn encode(spec: &Spec) -> Result<Vec<u8>, String> {
    let (samples, bits, photometric) = match spec.depth {
        32 => (4usize, 8u8, PHOTOMETRIC_RGB),
        24 => (3, 8, PHOTOMETRIC_RGB),
        8 | 4 | 1 => (1, spec.depth, PHOTOMETRIC_PALETTE),
        other => return Err(format!("a TIFF cannot be written at {other} bits")),
    };
    let count = spec.width * spec.height;
    let indexed = photometric == PHOTOMETRIC_PALETTE;
    let expected = if indexed { count } else { count * samples };
    if spec.pixels.len() != expected {
        return Err("the TIFF pixels do not match the image size".to_string());
    }
    let colors = 1usize << bits;
    if indexed {
        if !spec.palette.len().is_multiple_of(3) || spec.palette.len() / 3 > colors {
            return Err("the TIFF palette does not fit the bit depth".to_string());
        }
        if spec
            .pixels
            .iter()
            .any(|&index| usize::from(index) >= colors)
        {
            return Err("a TIFF palette index is out of range".to_string());
        }
    }

    let row_bytes = (spec.width * samples * usize::from(bits)).div_ceil(8);
    let predictor = bits == 8;
    let mut raw = Vec::with_capacity(row_bytes * spec.height);
    let mut row = vec![0u8; row_bytes];
    for y in 0..spec.height {
        row.fill(0);
        let source = &spec.pixels[y * spec.width * samples..][..spec.width * samples];
        if indexed {
            pack_indices(source, bits, &mut row);
        } else {
            row.copy_from_slice(source);
        }
        if predictor {
            differ_row(&mut row, samples);
        }
        raw.extend_from_slice(&row);
    }
    let strip = lzw(&raw)?;

    let bits_per_sample = vec![u16::from(bits); samples];
    let mut entries = vec![
        Entry::long(256, spec.width as u32),
        Entry::long(257, spec.height as u32),
        Entry::shorts(258, &bits_per_sample),
        Entry::short(259, LZW),
        Entry::short(PHOTOMETRIC, photometric),
        Entry::long(273, 8),
        Entry::short(277, samples as u16),
        Entry::long(278, spec.height as u32),
        Entry::long(279, strip.len() as u32),
        Entry::short(284, 1),
    ];
    if predictor {
        entries.push(Entry::short(PREDICTOR, HORIZONTAL_PREDICTOR));
    }
    if spec.pixels_per_meter.0 > 0 && spec.pixels_per_meter.1 > 0 {
        entries.push(Entry::rational(RESOLUTION_X, spec.pixels_per_meter.0, 100));
        entries.push(Entry::rational(RESOLUTION_Y, spec.pixels_per_meter.1, 100));
        entries.push(Entry::short(RESOLUTION_UNIT, 3));
    }
    if indexed {
        entries.push(color_map(spec.palette, colors));
    }
    if samples == 4 {
        entries.push(Entry::short(EXTRA_SAMPLES, UNASSOCIATED_ALPHA));
    }
    if !spec.icc.is_empty() {
        entries.push(Entry::new(
            ICC_PROFILE,
            UNDEFINED,
            spec.icc.len() as u32,
            spec.icc.to_vec(),
        ));
    }
    if !spec.xmp.is_empty() {
        entries.push(Entry::new(
            XMP,
            BYTE,
            spec.xmp.len() as u32,
            spec.xmp.to_vec(),
        ));
    }
    if let Some(copied) = ifd::ifd0_entries(spec.exif) {
        for entry in copied {
            let owned = entries.iter().any(|written| written.tag == entry.tag);
            if !owned && !is_written_by_writer(entry.tag) && entry.tag != ORIENTATION {
                entries.push(entry);
            }
        }
    }
    let subs = ifd::sub_ifds(spec.exif);

    let mut out = b"II*\0".to_vec();
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&strip);
    let ifd = ifd::append_ifd_tree(&mut out, &entries, &subs)?;
    out[4..8].copy_from_slice(&ifd.to_le_bytes());
    Ok(out)
}

/// Packs palette indices at `bits` per pixel, most significant bit first, into a zeroed row.
fn pack_indices(indices: &[u8], bits: u8, row: &mut [u8]) {
    if bits == 8 {
        row.copy_from_slice(indices);
        return;
    }
    let per_byte = usize::from(8 / bits);
    for (x, &index) in indices.iter().enumerate() {
        let shift = 8 - bits - (x % per_byte) as u8 * bits;
        row[x / per_byte] |= index << shift;
    }
}

/// The horizontal predictor: each sample is stored as its difference from the sample one pixel before.
fn differ_row(row: &mut [u8], samples: usize) {
    for i in (samples..row.len()).rev() {
        row[i] = row[i].wrapping_sub(row[i - samples]);
    }
}

/// The ColorMap entry for a palette: all red values, then all green, then all blue, as 16-bit values.
fn color_map(palette: &[u8], colors: usize) -> Entry {
    let mut values = vec![0u16; 3 * colors];
    for (index, rgb) in palette.as_chunks::<3>().0.iter().enumerate() {
        for channel in 0..3 {
            values[channel * colors + index] = u16::from(rgb[channel]) * 257;
        }
    }
    Entry::shorts(COLOR_MAP, &values)
}

/// TIFF LZW (MSB first, with the early code-size switch).
fn lzw(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8);
    let result = encoder.into_stream(&mut out).encode_all(data);
    result.status.map_err(|error| error.to_string())?;
    Ok(out)
}

/// Decodes the first page of a TIFF file into straight RGBA. Supported: gray (1, 2, 4, 8 and 16 bits),
/// gray with alpha (8 and 16), RGB and RGBA (8 and 16), palette (1, 2, 4 and 8 bits, with the 16-bit
/// ColorMap scaled to 8 bits), and CMYK (8 and 16 bits, kept as ink, see `Decoded::cmyk`).
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    let entries = ifd::ifd0_entries(bytes).ok_or("bad TIFF header")?;
    let indexed = short_value(&entries, PHOTOMETRIC) == Some(PHOTOMETRIC_PALETTE);
    // The tiff crate refuses palette photometrics. Its samples are plain indices, the same as gray
    // samples, so the decoder reads a copy that says BlackIsZero, and the color map is applied below.
    let patched: Vec<u8>;
    let source = if indexed {
        patched = {
            let mut copy = bytes.to_vec();
            ifd::set_short(&mut copy, PHOTOMETRIC, PHOTOMETRIC_BLACK_IS_ZERO);
            copy
        };
        patched.as_slice()
    } else {
        bytes
    };
    let mut decoder = Decoder::new(Cursor::new(source)).map_err(|error| error.to_string())?;
    let (width, height) = decoder.dimensions().map_err(|error| error.to_string())?;
    let (width, height) = (width as usize, height as usize);
    if width * height * 4 > MAX_RGBA_BYTES {
        return Err("the TIFF is too large to open".to_string());
    }
    let color = decoder.colortype().map_err(|error| error.to_string())?;
    let (samples, bits) = match color {
        ColorType::Gray(bits) => (1usize, bits),
        ColorType::GrayA(bits) => (2, bits),
        ColorType::RGB(bits) => (3, bits),
        ColorType::RGBA(bits) => (4, bits),
        ColorType::CMYK(bits) => (4, bits),
        _ => return Err(format!("unsupported TIFF color type {color:?}")),
    };
    let raw = decoder.read_image().map_err(|error| error.to_string())?;
    let values = samples_of(raw, width, height, samples, bits)?;

    let color_map = if indexed {
        shorts_of(tag_data(&entries, COLOR_MAP))
    } else {
        Vec::new()
    };
    let colors = color_map.len() / 3;
    let associated = color == ColorType::RGBA(bits)
        && entries
            .iter()
            .find(|entry| entry.tag == EXTRA_SAMPLES)
            .is_some_and(|entry| entry.data.first() == Some(&(ASSOCIATED_ALPHA as u8)));
    let mut rgba = vec![0u8; width * height * 4];
    for (pixel, out) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let sample = |channel: usize| values[pixel * samples + channel];
        let pixel_rgba = if indexed {
            let index = usize::from(sample(0));
            let channel = |c: usize| {
                if index < colors {
                    scale(color_map[c * colors + index], u16::MAX)
                } else {
                    0
                }
            };
            [channel(0), channel(1), channel(2), 255]
        } else {
            match color {
                ColorType::Gray(_) => {
                    let gray = scale(sample(0), max_of(bits));
                    [gray, gray, gray, 255]
                }
                ColorType::GrayA(_) => {
                    let gray = scale(sample(0), max_of(bits));
                    [gray, gray, gray, scale(sample(1), max_of(bits))]
                }
                ColorType::RGB(_) => [
                    scale(sample(0), max_of(bits)),
                    scale(sample(1), max_of(bits)),
                    scale(sample(2), max_of(bits)),
                    255,
                ],
                ColorType::CMYK(_) => [
                    scale(sample(0), max_of(bits)),
                    scale(sample(1), max_of(bits)),
                    scale(sample(2), max_of(bits)),
                    scale(sample(3), max_of(bits)),
                ],
                _ => {
                    let alpha = scale(sample(3), max_of(bits));
                    let color = [
                        scale(sample(0), max_of(bits)),
                        scale(sample(1), max_of(bits)),
                        scale(sample(2), max_of(bits)),
                    ];
                    if associated {
                        unassociate(color, alpha)
                    } else {
                        [color[0], color[1], color[2], alpha]
                    }
                }
            }
        };
        *out = pixel_rgba;
    }

    let icc = tag_data(&entries, ICC_PROFILE).to_vec();
    let xmp = tag_data(&entries, XMP).to_vec();
    let copied: Vec<Entry> = entries
        .iter()
        .filter(|entry| entry.tag == ORIENTATION || !is_written_by_writer(entry.tag))
        .cloned()
        .collect();
    let subs = ifd::sub_ifds(bytes);
    let exif = if copied.is_empty() && subs.is_empty() {
        Vec::new()
    } else {
        ifd::exif_block(&copied, &subs)?
    };
    Ok(Decoded {
        width,
        height,
        rgba,
        cmyk: matches!(color, ColorType::CMYK(_)),
        pixels_per_meter: pixels_per_meter(&entries),
        icc,
        xmp,
        exif,
    })
}

fn tag_data(entries: &[Entry], tag: u16) -> &[u8] {
    entries
        .iter()
        .find(|entry| entry.tag == tag)
        .map_or(&[], |entry| entry.data.as_slice())
}

/// The one value of a SHORT entry, when the entry is present.
fn short_value(entries: &[Entry], tag: u16) -> Option<u16> {
    let data = tag_data(entries, tag);
    (data.len() >= 2).then(|| u16::from_le_bytes([data[0], data[1]]))
}

fn shorts_of(data: &[u8]) -> Vec<u16> {
    data.as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect()
}

/// The largest value of a sample of `bits` bits.
fn max_of(bits: u8) -> u16 {
    if bits >= 16 {
        u16::MAX
    } else {
        (1u16 << bits) - 1
    }
}

/// Scales a sample of range 0 to `max` to 0 to 255, rounding to nearest.
fn scale(value: u16, max: u16) -> u8 {
    ((u32::from(value) * 255 + u32::from(max) / 2) / u32::from(max)) as u8
}

/// Converts premultiplied color back to straight color (the associated alpha of ExtraSamples).
fn unassociate(color: [u8; 3], alpha: u8) -> [u8; 4] {
    if alpha == 0 {
        return [0, 0, 0, 0];
    }
    let a = u32::from(alpha);
    let straight = color.map(|c| ((u32::from(c) * 255 + a / 2) / a).min(255) as u8);
    [straight[0], straight[1], straight[2], alpha]
}

/// The samples of the first page as unscaled values, one per sample, for every pixel. Sub-byte samples
/// are unpacked from rows padded to a whole byte.
fn samples_of(
    raw: DecodingResult,
    width: usize,
    height: usize,
    samples: usize,
    bits: u8,
) -> Result<Vec<u16>, String> {
    let per_row = width * samples;
    match (raw, bits) {
        (DecodingResult::U16(values), 16) => Ok(values),
        (DecodingResult::U8(bytes), 8) => Ok(bytes.into_iter().map(u16::from).collect()),
        (DecodingResult::U8(bytes), 1 | 2 | 4) => {
            let row_bytes = (per_row * usize::from(bits)).div_ceil(8);
            let mask = (1u8 << bits) - 1;
            let mut out = Vec::with_capacity(per_row * height);
            for y in 0..height {
                let row = bytes
                    .get(y * row_bytes..(y + 1) * row_bytes)
                    .ok_or("the TIFF data is truncated")?;
                for x in 0..per_row {
                    let bit = x * usize::from(bits);
                    let shift = 8 - bits - (bit % 8) as u8;
                    out.push(u16::from((row[bit / 8] >> shift) & mask));
                }
            }
            Ok(out)
        }
        _ => Err("unsupported TIFF sample layout".to_string()),
    }
}

/// The density of IFD0 in pixels per meter. Zero when it is absent or the unit is "none".
fn pixels_per_meter(entries: &[Entry]) -> (u32, u32) {
    let fraction = |tag: u16| {
        entries
            .iter()
            .find(|entry| entry.tag == tag && entry.kind == RATIONAL && entry.data.len() >= 8)
            .map(|entry| {
                let word = |at: usize| {
                    u32::from_le_bytes([
                        entry.data[at],
                        entry.data[at + 1],
                        entry.data[at + 2],
                        entry.data[at + 3],
                    ])
                };
                let (numerator, denominator) = (word(0), word(4));
                if denominator == 0 {
                    0.0
                } else {
                    f64::from(numerator) / f64::from(denominator)
                }
            })
    };
    let per_meter = match short_value(entries, RESOLUTION_UNIT).unwrap_or(2) {
        2 => 100.0 / CENTIMETERS_PER_INCH,
        3 => 100.0,
        _ => return (0, 0),
    };
    match (fraction(RESOLUTION_X), fraction(RESOLUTION_Y)) {
        (Some(x), Some(y)) if x > 0.0 && y > 0.0 => (
            (x * per_meter).round() as u32,
            (y * per_meter).round() as u32,
        ),
        _ => (0, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec<'a>(
        width: usize,
        height: usize,
        depth: u8,
        pixels: &'a [u8],
        palette: &'a [u8],
    ) -> Spec<'a> {
        Spec {
            width,
            height,
            depth,
            pixels,
            palette,
            icc: &[],
            pixels_per_meter: (0, 0),
            exif: &[],
            xmp: &[],
        }
    }

    #[test]
    fn rgba_round_trips_with_lzw_and_predictor() {
        let pixels: Vec<u8> = (0..3 * 2 * 4).map(|i| (i * 13 % 251) as u8).collect();
        let bytes = encode(&spec(3, 2, 32, &pixels, &[])).unwrap();
        let decoded = decode(&bytes).unwrap();
        assert_eq!((decoded.width, decoded.height), (3, 2));
        assert_eq!(decoded.rgba, pixels);
    }

    #[test]
    fn rgb_and_palette_depths_round_trip() {
        let rgb: Vec<u8> = (0..4 * 3 * 3).map(|i| (i * 7) as u8).collect();
        let decoded = decode(&encode(&spec(4, 3, 24, &rgb, &[])).unwrap()).unwrap();
        let expected: Vec<u8> = rgb
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|c| [c[0], c[1], c[2], 255])
            .collect();
        assert_eq!(decoded.rgba, expected);

        let palette = [0, 0, 0, 255, 255, 255, 200, 30, 10];
        for (depth, colors) in [(8u8, 3usize), (4, 3), (1, 2)] {
            let palette = &palette[..colors * 3];
            let indices: Vec<u8> = (0..5 * 3).map(|i| (i % colors) as u8).collect();
            let decoded = decode(&encode(&spec(5, 3, depth, &indices, palette)).unwrap()).unwrap();
            let expected: Vec<u8> = indices
                .iter()
                .flat_map(|&i| {
                    let c = &palette[usize::from(i) * 3..][..3];
                    [c[0], c[1], c[2], 255]
                })
                .collect();
            assert_eq!(decoded.rgba, expected, "depth {depth}");
        }
    }

    #[test]
    fn density_icc_xmp_and_exif_survive_a_round_trip() {
        let exif = ifd::exif_block(
            &[
                Entry::new(0x013b, 2, 6, b"Ada\0\0\0".to_vec()),
                Entry::short(ORIENTATION, 1),
                Entry::short(0x0131, 2),
                Entry::long(339, 1),
            ],
            &[],
        )
        .unwrap();
        let icc = [1u8, 2, 3, 4, 5, 6];
        let xmp = b"<x/>";
        let pixels = [9u8, 8, 7, 6];
        let bytes = encode(&Spec {
            width: 1,
            height: 1,
            depth: 32,
            pixels: &pixels,
            palette: &[],
            icc: &icc,
            pixels_per_meter: (3780, 3780),
            exif: &exif,
            xmp,
        })
        .unwrap();
        let decoded = decode(&bytes).unwrap();
        assert_eq!(decoded.pixels_per_meter, (3780, 3780));
        assert_eq!(decoded.icc, icc);
        assert_eq!(decoded.xmp, xmp);
        let tags: Vec<u16> = ifd::ifd0_entries(&decoded.exif)
            .unwrap()
            .iter()
            .map(|entry| entry.tag)
            .collect();
        assert_eq!(tags, vec![0x0131, 0x013b]);
        assert_eq!(decoded.rgba, pixels);
    }

    #[test]
    fn exif_and_gps_sub_ifds_survive_a_round_trip() {
        let date = Entry::new(0x9003, 2, 20, b"2026:10:13 10:00:00\0".to_vec());
        let latitude_ref = Entry::new(0x0001, 2, 2, b"N\0".to_vec());
        let mut latitude = Vec::new();
        for (numerator, denominator) in [(51u32, 1u32), (30, 1), (0, 1)] {
            latitude.extend_from_slice(&numerator.to_le_bytes());
            latitude.extend_from_slice(&denominator.to_le_bytes());
        }
        let latitude = Entry::new(0x0002, 5, 3, latitude);
        let exif = ifd::exif_block(
            &[Entry::new(0x013b, 2, 6, b"Ada\0\0\0".to_vec())],
            &[
                (ifd::EXIF_IFD, vec![date.clone()]),
                (ifd::GPS_IFD, vec![latitude_ref.clone(), latitude.clone()]),
            ],
        )
        .unwrap();
        let pixels = [9u8, 8, 7, 6];
        let bytes = encode(&Spec {
            width: 1,
            height: 1,
            depth: 32,
            pixels: &pixels,
            palette: &[],
            icc: &[],
            pixels_per_meter: (0, 0),
            exif: &exif,
            xmp: &[],
        })
        .unwrap();
        let decoded = decode(&bytes).unwrap();
        assert_eq!(
            ifd::sub_ifds(&decoded.exif),
            vec![
                (ifd::EXIF_IFD, vec![date]),
                (ifd::GPS_IFD, vec![latitude_ref, latitude]),
            ]
        );
        let ifd0: Vec<u16> = ifd::ifd0_entries(&decoded.exif)
            .unwrap()
            .iter()
            .map(|entry| entry.tag)
            .collect();
        assert_eq!(ifd0, vec![0x013b, ifd::EXIF_IFD, ifd::GPS_IFD]);
        assert_eq!(decoded.rgba, pixels);
    }

    #[test]
    fn a_predictor_row_is_stored_as_differences() {
        let mut row = [10u8, 20, 30, 40, 50, 60];
        differ_row(&mut row, 3);
        assert_eq!(row, [10, 20, 30, 30, 30, 30]);
    }

    #[test]
    fn cmyk_pages_come_back_as_ink() {
        let ink: Vec<u8> = [200u8, 0, 100, 50].repeat(4);
        let mut out = Cursor::new(Vec::new());
        {
            let mut encoder = tiff::encoder::TiffEncoder::new(&mut out).unwrap();
            encoder
                .write_image::<tiff::encoder::colortype::CMYK8>(2, 2, &ink)
                .unwrap();
        }
        let decoded = decode(&out.into_inner()).unwrap();
        assert!(decoded.cmyk);
        assert_eq!((decoded.width, decoded.height), (2, 2));
        assert_eq!(decoded.rgba, ink);
    }

    #[test]
    fn rgb_pages_are_not_cmyk() {
        let bytes = encode(&spec(2, 1, 24, &[0; 6], &[])).unwrap();
        assert!(!decode(&bytes).unwrap().cmyk);
    }

    #[test]
    fn bad_input_is_refused() {
        assert!(encode(&spec(2, 1, 16, &[0; 2], &[])).is_err());
        assert!(encode(&spec(2, 1, 8, &[0; 3], &[])).is_err());
        assert!(encode(&spec(2, 1, 1, &[0, 2], &[0, 0, 0, 1, 1, 1])).is_err());
        assert!(decode(b"not a tiff").is_err());
        assert!(decode(&[b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0]).is_err());
    }
}
