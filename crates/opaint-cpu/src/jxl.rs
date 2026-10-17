//! JPEG XL codec (FMT-OPT-JXL-01, FMT-META-05). The codestream is encoded by libjxl (`@jsquash/jxl`,
//! lossy or lossless) in TypeScript. `wrap` puts it in the ISO-BMFF container, so EXIF and XMP can ride
//! along. Decoding goes through `jxl-oxide`, which reads the container, the aux boxes and the frame.

use std::io::Cursor;

use jxl_oxide::{AuxBoxData, JxlImage};

/// A decoded JPEG XL: straight RGBA, top row first, the ICC profile that describes the pixels (empty
/// when the frame is in sRGB without one), and the first EXIF and XMP boxes.
pub struct Decoded {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
    pub icc: Vec<u8>,
    pub exif: Vec<u8>,
    pub xmp: Vec<u8>,
}

const SIGNATURE: [u8; 12] = [0, 0, 0, 12, b'J', b'X', b'L', b' ', 0x0D, 0x0A, 0x87, 0x0A];
const BRAND: &[u8; 4] = b"jxl ";

fn push_box(out: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) -> Result<(), String> {
    let len = u32::try_from(payload.len() + 8)
        .map_err(|_| "a JPEG XL metadata box is too large".to_string())?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    Ok(())
}

/// Wraps a bare JPEG XL codestream in the ISO-BMFF container: the signature, the file type, the EXIF
/// and XMP boxes (when present) and the codestream. `exif` is a TIFF-structured block and `xmp` one
/// packet. Empty slices write no box. The codestream carries its own color description, so no ICC
/// box is written.
pub fn wrap(codestream: &[u8], exif: &[u8], xmp: &[u8]) -> Result<Vec<u8>, String> {
    if codestream.is_empty() {
        return Err("the JPEG XL codestream is empty".into());
    }
    let mut out = SIGNATURE.to_vec();
    let mut ftyp = BRAND.to_vec();
    ftyp.extend_from_slice(&[0, 0, 0, 0]);
    ftyp.extend_from_slice(BRAND);
    push_box(&mut out, b"ftyp", &ftyp)?;
    if !exif.is_empty() {
        let mut payload = vec![0, 0, 0, 0];
        payload.extend_from_slice(exif);
        push_box(&mut out, b"Exif", &payload)?;
    }
    if !xmp.is_empty() {
        push_box(&mut out, b"xml ", xmp)?;
    }
    push_box(&mut out, b"jxlc", codestream)?;
    Ok(out)
}

/// Expands the channels of a decoded frame to straight RGBA. One channel is gray, two are gray with
/// alpha, three are RGB and four are already RGBA.
fn to_rgba(samples: &[u8], channels: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(samples.len() / channels * 4);
    for pixel in samples.chunks_exact(channels) {
        let (r, g, b, a) = match *pixel {
            [gray] => (gray, gray, gray, 255),
            [gray, alpha] => (gray, gray, gray, alpha),
            [r, g, b] => (r, g, b, 255),
            [r, g, b, a] => (r, g, b, a),
            _ => return Err("unsupported JPEG XL channel count".into()),
        };
        out.extend_from_slice(&[r, g, b, a]);
    }
    Ok(out)
}

/// Reads a JPEG XL file: the first frame, rendered at its orientation, with the first EXIF and XMP
/// boxes. Animations show their first frame.
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    let image = JxlImage::read_with_defaults(Cursor::new(bytes)).map_err(|err| err.to_string())?;
    let icc = image.rendered_icc();
    let exif = match image
        .aux_boxes()
        .first_exif()
        .map_err(|err| err.to_string())?
    {
        AuxBoxData::Data(exif) => exif.payload().to_vec(),
        AuxBoxData::Decoding | AuxBoxData::NotFound => Vec::new(),
    };
    let xmp = match image.aux_boxes().first_xml() {
        AuxBoxData::Data(xmp) => xmp.to_vec(),
        AuxBoxData::Decoding | AuxBoxData::NotFound => Vec::new(),
    };
    let render = image.render_frame(0).map_err(|err| err.to_string())?;
    let mut stream = render.stream();
    let (width, height) = (stream.width() as usize, stream.height() as usize);
    let channels = stream.channels() as usize;
    let mut samples = vec![0u8; width * height * channels];
    stream.write_to_buffer(&mut samples);
    Ok(Decoded {
        width,
        height,
        rgba: to_rgba(&samples, channels)?,
        icc,
        exif,
        xmp,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The boxes after the signature, as (type, payload) pairs.
    fn boxes(file: &[u8]) -> Vec<([u8; 4], &[u8])> {
        let mut out = Vec::new();
        let mut at = SIGNATURE.len();
        while at + 8 <= file.len() {
            let len = u32::from_be_bytes(file[at..at + 4].try_into().unwrap()) as usize;
            let kind: [u8; 4] = file[at + 4..at + 8].try_into().unwrap();
            out.push((kind, &file[at + 8..at + len]));
            at += len;
        }
        out
    }

    const CODESTREAM: [u8; 6] = [0xFF, 0x0A, 1, 2, 3, 4];

    #[test]
    fn the_container_starts_with_the_signature_and_file_type() {
        let file = wrap(&CODESTREAM, &[], &[]).unwrap();
        assert_eq!(&file[..12], &SIGNATURE);
        let parts = boxes(&file);
        assert_eq!(parts[0].0, *b"ftyp");
        assert_eq!(parts[0].1, b"jxl \0\0\0\0jxl ");
    }

    #[test]
    fn the_codestream_is_the_last_box_unchanged() {
        let file = wrap(&CODESTREAM, &[], &[]).unwrap();
        let parts = boxes(&file);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1].0, *b"jxlc");
        assert_eq!(parts[1].1, CODESTREAM);
    }

    #[test]
    fn exif_and_xmp_boxes_are_written_before_the_codestream() {
        let exif = b"II*\0\x08\0\0\0\0\0\0\0\0\0";
        let xmp = b"<x:xmpmeta/>";
        let file = wrap(&CODESTREAM, exif, xmp).unwrap();
        let parts = boxes(&file);
        let kinds: Vec<[u8; 4]> = parts.iter().map(|(kind, _)| *kind).collect();
        assert_eq!(kinds, [*b"ftyp", *b"Exif", *b"xml ", *b"jxlc"]);
        assert_eq!(parts[1].1, [&[0u8; 4][..], &exif[..]].concat());
        assert_eq!(parts[2].1, xmp);
    }

    #[test]
    fn rejects_garbage_empty_codestreams_and_undecodable_files() {
        assert!(wrap(&[], &[], &[]).is_err());
        assert!(decode(b"not a jxl file at all").is_err());
        assert!(decode(&wrap(&CODESTREAM, &[], &[]).unwrap()).is_err());
    }
}
