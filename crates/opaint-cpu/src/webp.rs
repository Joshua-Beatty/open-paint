//! WebP codec (FMT-OPT-WEBP-01). The bitstream is encoded by libwebp in TypeScript (`@jsquash/webp`),
//! which gives the presets their tuning. `wrap` adds the VP8X container and the ICCP, EXIF and XMP
//! chunks around it. Decoding returns the first frame of an animation (FMT-META-04).

const FLAG_ICC: u8 = 0x20;
const FLAG_ALPHA: u8 = 0x10;
const FLAG_EXIF: u8 = 0x08;
const FLAG_XMP: u8 = 0x04;

/// The largest canvas side the VP8X chunk can describe (24 bits of width minus one).
const MAX_CANVAS: usize = 1 << 24;

/// A decoded WebP: straight RGBA, top row first, and the metadata chunks it carried.
pub struct Decoded {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
    pub icc: Vec<u8>,
    pub exif: Vec<u8>,
    pub xmp: Vec<u8>,
}

/// Wraps one WebP bitstream (a `VP8 `, `VP8L` or `VP8X` file) with the ICCP, EXIF and XMP chunks.
/// Empty metadata writes no chunk. The bitstream's own metadata chunks are dropped, since the caller
/// supplies the metadata. Only the first XMP packet is written.
pub fn wrap(
    bitstream: &[u8],
    width: usize,
    height: usize,
    icc: &[u8],
    exif: &[u8],
    xmp: &[u8],
) -> Result<Vec<u8>, String> {
    if !(1..=MAX_CANVAS).contains(&width) || !(1..=MAX_CANVAS).contains(&height) {
        return Err(format!(
            "A WebP canvas must be 1 to {MAX_CANVAS} pixels on each side."
        ));
    }
    let image: Vec<Chunk<'_>> = chunks(bitstream)?
        .into_iter()
        .filter(|(id, _)| id == b"ALPH" || id == b"VP8 " || id == b"VP8L")
        .collect();
    if !image.iter().any(|(id, _)| id == b"VP8 " || id == b"VP8L") {
        return Err("The WebP bitstream has no image chunk.".to_string());
    }
    let alpha = image
        .iter()
        .any(|(id, payload)| id == b"ALPH" || (id == b"VP8L" && vp8l_uses_alpha(payload)));

    let mut flags = 0u8;
    if !icc.is_empty() {
        flags |= FLAG_ICC;
    }
    if alpha {
        flags |= FLAG_ALPHA;
    }
    if !exif.is_empty() {
        flags |= FLAG_EXIF;
    }
    if !xmp.is_empty() {
        flags |= FLAG_XMP;
    }
    let mut canvas = vec![flags, 0, 0, 0];
    canvas.extend_from_slice(&((width - 1) as u32).to_le_bytes()[..3]);
    canvas.extend_from_slice(&((height - 1) as u32).to_le_bytes()[..3]);

    let mut body = b"WEBP".to_vec();
    push_chunk(&mut body, b"VP8X", &canvas);
    if !icc.is_empty() {
        push_chunk(&mut body, b"ICCP", icc);
    }
    for (id, payload) in &image {
        push_chunk(&mut body, id, payload);
    }
    if !exif.is_empty() {
        push_chunk(&mut body, b"EXIF", exif);
    }
    if !xmp.is_empty() {
        push_chunk(&mut body, b"XMP ", xmp);
    }

    let mut file = b"RIFF".to_vec();
    file.extend_from_slice(&(body.len() as u32).to_le_bytes());
    file.extend_from_slice(&body);
    Ok(file)
}

/// Reads a WebP file into straight RGBA and its metadata chunks.
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    let image = oxideav_webp::decode(bytes).map_err(|err| err.to_string())?;
    let rgba = image.to_rgba8();
    Ok(Decoded {
        width: image.width as usize,
        height: image.height as usize,
        rgba,
        icc: image.metadata.icc.unwrap_or_default(),
        exif: image.metadata.exif.unwrap_or_default(),
        xmp: image.metadata.xmp.unwrap_or_default(),
    })
}

/// A top-level RIFF chunk: its four-character id and its payload.
type Chunk<'a> = ([u8; 4], &'a [u8]);

/// The top-level chunks of a RIFF WEBP file, in order.
fn chunks(bytes: &[u8]) -> Result<Vec<Chunk<'_>>, String> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("The WebP bitstream is not a RIFF WEBP file.".to_string());
    }
    let mut out = Vec::new();
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]])
            as usize;
        let start = at + 8;
        let end = start
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "A WebP chunk is truncated.".to_string())?;
        out.push((id, &bytes[start..end]));
        at = end + (size & 1);
    }
    Ok(out)
}

/// The alpha_is_used bit of a VP8L header: the 0x2f signature byte, then 14 bits of width, 14 bits of
/// height and this bit.
fn vp8l_uses_alpha(payload: &[u8]) -> bool {
    payload.len() >= 5
        && (u32::from_le_bytes([payload[1], payload[2], payload[3], payload[4]]) >> 28) & 1 == 1
}

fn push_chunk(out: &mut Vec<u8>, id: &[u8; 4], payload: &[u8]) {
    out.extend_from_slice(id);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    if payload.len() % 2 == 1 {
        out.push(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxideav_webp::{EncodeOptions, Metadata, WebpImage};

    /// A bare `VP8 ` bitstream. The payload is not a real frame, so these tests check the container only.
    fn lossy_stub() -> Vec<u8> {
        let mut file = b"RIFF".to_vec();
        let mut body = b"WEBP".to_vec();
        push_chunk(&mut body, b"VP8 ", &[1, 2, 3, 4, 5]);
        file.extend_from_slice(&(body.len() as u32).to_le_bytes());
        file.extend_from_slice(&body);
        file
    }

    fn ids(file: &[u8]) -> Vec<String> {
        chunks(file)
            .unwrap()
            .iter()
            .map(|(id, _)| String::from_utf8_lossy(id).into_owned())
            .collect()
    }

    fn payload_of<'a>(file: &'a [u8], name: &[u8; 4]) -> &'a [u8] {
        chunks(file)
            .unwrap()
            .into_iter()
            .find(|(id, _)| id == name)
            .map(|(_, payload)| payload)
            .unwrap()
    }

    #[test]
    fn writes_canvas_metadata_and_image_in_order() {
        let file = wrap(&lossy_stub(), 300, 200, &[1, 2, 3], b"II*\0", b"<x/>").unwrap();
        assert_eq!(&file[..4], b"RIFF");
        assert_eq!(&file[8..12], b"WEBP");
        assert_eq!(
            u32::from_le_bytes([file[4], file[5], file[6], file[7]]) as usize,
            file.len() - 8
        );
        assert_eq!(ids(&file), ["VP8X", "ICCP", "VP8 ", "EXIF", "XMP "]);
        let canvas = payload_of(&file, b"VP8X");
        assert_eq!(canvas[0], FLAG_ICC | FLAG_EXIF | FLAG_XMP);
        assert_eq!(&canvas[4..7], &299u32.to_le_bytes()[..3]);
        assert_eq!(&canvas[7..10], &199u32.to_le_bytes()[..3]);
        assert_eq!(payload_of(&file, b"ICCP"), [1, 2, 3]);
        assert_eq!(payload_of(&file, b"XMP "), b"<x/>");
    }

    #[test]
    fn writes_only_the_canvas_and_the_image_without_metadata() {
        let file = wrap(&lossy_stub(), 4, 4, &[], &[], &[]).unwrap();
        assert_eq!(ids(&file), ["VP8X", "VP8 "]);
        assert_eq!(payload_of(&file, b"VP8X")[0], 0);
    }

    #[test]
    fn an_alpha_chunk_sets_the_alpha_flag_and_stays_before_the_image() {
        let mut body = b"WEBP".to_vec();
        push_chunk(&mut body, b"ALPH", &[0, 255]);
        push_chunk(&mut body, b"VP8 ", &[9, 9]);
        let mut source = b"RIFF".to_vec();
        source.extend_from_slice(&(body.len() as u32).to_le_bytes());
        source.extend_from_slice(&body);
        let file = wrap(&source, 2, 1, &[], &[], &[]).unwrap();
        assert_eq!(ids(&file), ["VP8X", "ALPH", "VP8 "]);
        assert_eq!(payload_of(&file, b"VP8X")[0], FLAG_ALPHA);
    }

    #[test]
    fn a_lossless_header_with_alpha_sets_the_alpha_flag() {
        let mut body = b"WEBP".to_vec();
        push_chunk(&mut body, b"VP8L", &[0x2f, 0, 0, 0, 0x10]);
        let mut source = b"RIFF".to_vec();
        source.extend_from_slice(&(body.len() as u32).to_le_bytes());
        source.extend_from_slice(&body);
        let file = wrap(&source, 1, 1, &[], &[], &[]).unwrap();
        assert_eq!(payload_of(&file, b"VP8X")[0], FLAG_ALPHA);

        let opaque = [0x2f, 0, 0, 0, 0];
        assert!(!vp8l_uses_alpha(&opaque));
    }

    #[test]
    fn drops_metadata_chunks_that_the_caller_does_not_pass() {
        let mut body = b"WEBP".to_vec();
        push_chunk(&mut body, b"EXIF", b"old");
        push_chunk(&mut body, b"VP8 ", &[1, 2]);
        let mut source = b"RIFF".to_vec();
        source.extend_from_slice(&(body.len() as u32).to_le_bytes());
        source.extend_from_slice(&body);
        let file = wrap(&source, 2, 2, &[], &[], &[]).unwrap();
        assert_eq!(ids(&file), ["VP8X", "VP8 "]);
    }

    #[test]
    fn lossless_bitstream_round_trips_through_the_decoder_with_metadata() {
        let (width, height) = (9usize, 5usize);
        let mut rgba = Vec::new();
        for i in 0..width * height {
            rgba.extend_from_slice(&[
                (i * 7) as u8,
                (i * 3) as u8,
                200,
                if i % 4 == 0 { 0 } else { 255 },
            ]);
        }
        let image = WebpImage::from_rgba8(width as u32, height as u32, rgba.clone())
            .unwrap()
            .with_metadata(Metadata::new());
        let bitstream = oxideav_webp::encode(&image, &EncodeOptions::default()).unwrap();
        let exif = b"II*\0\x08\0\0\0\0\0\0\0\0\0".to_vec();
        let xmp = b"<x:xmpmeta/>".to_vec();
        let icc = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        let file = wrap(&bitstream, width, height, &icc, &exif, &xmp).unwrap();

        let decoded = decode(&file).unwrap();
        assert_eq!((decoded.width, decoded.height), (width, height));
        assert_eq!(decoded.rgba, rgba);
        assert_eq!(decoded.icc, icc);
        assert_eq!(decoded.exif, exif);
        assert_eq!(decoded.xmp, xmp);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(wrap(b"not a webp file at all", 2, 2, &[], &[], &[]).is_err());
        assert!(wrap(&lossy_stub(), 0, 2, &[], &[], &[]).is_err());
        assert!(wrap(&lossy_stub(), MAX_CANVAS + 1, 2, &[], &[], &[]).is_err());
        let mut body = b"WEBP".to_vec();
        push_chunk(&mut body, b"EXIF", b"only metadata");
        let mut no_image = b"RIFF".to_vec();
        no_image.extend_from_slice(&(body.len() as u32).to_le_bytes());
        no_image.extend_from_slice(&body);
        assert!(wrap(&no_image, 2, 2, &[], &[], &[]).is_err());
        let stub = lossy_stub();
        assert!(wrap(&stub[..14], 2, 2, &[], &[], &[]).is_err());
        assert!(decode(b"not a webp file at all").is_err());
    }
}
