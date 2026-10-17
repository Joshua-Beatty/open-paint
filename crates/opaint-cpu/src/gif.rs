//! GIF writer and reader (07 FMT-OPT-GIF-01, FMT-META-04, FMT-META-05).
//!
//! The writer emits one frame with an 8-bit palette and an optional transparent index. It carries the
//! XMP packet in an application extension (the Adobe XMP block). The reader decodes only the first frame,
//! and it places that frame on the logical screen. The rest of the screen is transparent. The reader also
//! returns the XMP packet, which it finds by walking the blocks of the file.

use gif::{AnyExtension, ColorOutput, DecodeOptions, Encoder, Frame};

/// The largest decoded image, in RGBA bytes, that the reader accepts.
const MAX_RGBA_BYTES: usize = 1 << 30;
/// The Adobe XMP application identifier and authentication code (11 bytes).
const XMP_IDENTIFIER: &[u8] = b"XMP DataXMP";
const APPLICATION_EXTENSION: u8 = 0xFF;

/// One frame to write. `indices` holds one palette index per pixel, top row first. `palette` holds RGB
/// triples, at most 256 of them. `transparent` names the index that is fully transparent.
pub struct Spec<'a> {
    pub width: usize,
    pub height: usize,
    pub indices: &'a [u8],
    pub palette: &'a [u8],
    pub transparent: Option<u8>,
    pub xmp: &'a [u8],
}

/// The first frame, composed on the logical screen: straight RGBA, top row first, and the XMP packet
/// (empty when the file has none).
pub struct Decoded {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
    pub xmp: Vec<u8>,
}

/// The magic trailer after an XMP packet: byte 1, then 255 down to 0 (257 bytes).
const XMP_TRAILER_LEN: usize = 257;
const IMAGE_SEPARATOR: u8 = 0x2C;
const EXTENSION_INTRODUCER: u8 = 0x21;
const LOGICAL_SCREEN_END: usize = 13;
const APPLICATION_IDENTIFIER_LEN: u8 = 11;

/// The XMP packet in the application extension that `encode` writes, or None when the file has none. The
/// blocks are walked from the header, so a packet is found wherever it sits between the frames.
fn find_xmp(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut at = LOGICAL_SCREEN_END;
    at = skip_color_table(at, *bytes.get(10)?);
    loop {
        match *bytes.get(at)? {
            IMAGE_SEPARATOR => {
                let flags = *bytes.get(at + 9)?;
                at = skip_color_table(at + 10, flags) + 1;
                at = skip_sub_blocks(bytes, at)?;
            }
            EXTENSION_INTRODUCER => {
                let label = *bytes.get(at + 1)?;
                let identified = bytes.get(at + 2) == Some(&APPLICATION_IDENTIFIER_LEN)
                    && bytes.get(at + 3..at + 14) == Some(XMP_IDENTIFIER);
                if label == APPLICATION_EXTENSION && identified {
                    let mut data = collect_sub_blocks(bytes, at + 14)?;
                    let packet_len = data.len().checked_sub(XMP_TRAILER_LEN)?;
                    data.truncate(packet_len);
                    return Some(data);
                }
                at = skip_sub_blocks(bytes, at + 2)?;
            }
            _ => return None,
        }
    }
}

/// The position after a color table of `flags`' size, which starts at `at` (none when the flag is clear).
fn skip_color_table(at: usize, flags: u8) -> usize {
    if flags & 0x80 == 0 {
        at
    } else {
        at + 3 * (1usize << ((flags & 7) + 1))
    }
}

/// The position after the data sub-blocks that start at `at`.
fn skip_sub_blocks(bytes: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let size = usize::from(*bytes.get(at)?);
        if size == 0 {
            return Some(at + 1);
        }
        at += 1 + size;
    }
}

/// The data of the sub-blocks that start at `at`, joined.
fn collect_sub_blocks(bytes: &[u8], mut at: usize) -> Option<Vec<u8>> {
    let mut data = Vec::new();
    loop {
        let size = usize::from(*bytes.get(at)?);
        if size == 0 {
            return Some(data);
        }
        data.extend_from_slice(bytes.get(at + 1..at + 1 + size)?);
        at += 1 + size;
    }
}

/// Encodes one frame as a GIF file (see the module comment).
pub fn encode(spec: &Spec) -> Result<Vec<u8>, String> {
    let width = u16::try_from(spec.width).map_err(|_| "a GIF is at most 65,535 pixels wide")?;
    let height = u16::try_from(spec.height).map_err(|_| "a GIF is at most 65,535 pixels high")?;
    if spec.indices.len() != spec.width * spec.height {
        return Err("the GIF pixels do not match the image size".to_string());
    }
    if !spec.palette.len().is_multiple_of(3)
        || spec.palette.len() / 3 > 256
        || spec.palette.is_empty()
    {
        return Err("the GIF palette must hold 1 to 256 colors".to_string());
    }
    let entries = spec.palette.len() / 3;
    if spec
        .indices
        .iter()
        .any(|&index| usize::from(index) >= entries)
    {
        return Err("a GIF palette index is out of range".to_string());
    }
    if spec
        .transparent
        .is_some_and(|index| usize::from(index) >= entries)
    {
        return Err("the GIF transparent index is out of range".to_string());
    }

    let mut out = Vec::new();
    {
        let mut encoder =
            Encoder::new(&mut out, width, height, &[]).map_err(|error| error.to_string())?;
        let frame = Frame::from_palette_pixels(
            width,
            height,
            spec.indices.to_vec(),
            spec.palette.to_vec(),
            spec.transparent,
        );
        encoder
            .write_frame(&frame)
            .map_err(|error| error.to_string())?;
        if !spec.xmp.is_empty() {
            let mut trailer = vec![0x01];
            trailer.extend((0..=255u8).rev());
            encoder
                .write_raw_extension(
                    AnyExtension(APPLICATION_EXTENSION),
                    &[XMP_IDENTIFIER, spec.xmp, trailer.as_slice()],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(out)
}

/// Decodes the first frame of a GIF into straight RGBA on the logical screen. Later frames are ignored.
pub fn decode_first_frame(bytes: &[u8]) -> Result<Decoded, String> {
    let mut options = DecodeOptions::new();
    options.set_color_output(ColorOutput::RGBA);
    let mut decoder = options
        .read_info(bytes)
        .map_err(|error| error.to_string())?;
    let screen_width = usize::from(decoder.width());
    let screen_height = usize::from(decoder.height());
    let frame = decoder
        .read_next_frame()
        .map_err(|error| error.to_string())?
        .ok_or("the GIF has no frames")?;
    let left = usize::from(frame.left);
    let top = usize::from(frame.top);
    let frame_width = usize::from(frame.width);
    let frame_height = usize::from(frame.height);
    let width = screen_width.max(left + frame_width);
    let height = screen_height.max(top + frame_height);
    if width == 0 || height == 0 {
        return Err("the GIF has no pixels".to_string());
    }
    if width * height * 4 > MAX_RGBA_BYTES {
        return Err("the GIF is too large to open".to_string());
    }
    let mut rgba = vec![0u8; width * height * 4];
    let row_bytes = frame_width * 4;
    for y in 0..frame_height {
        let source = frame
            .buffer
            .get(y * row_bytes..(y + 1) * row_bytes)
            .ok_or("the GIF frame data is truncated")?;
        let start = ((top + y) * width + left) * 4;
        rgba[start..start + row_bytes].copy_from_slice(source);
    }
    Ok(Decoded {
        width,
        height,
        rgba,
        xmp: find_xmp(bytes).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn palette_spec<'a>(indices: &'a [u8], palette: &'a [u8], transparent: Option<u8>) -> Spec<'a> {
        Spec {
            width: 3,
            height: 2,
            indices,
            palette,
            transparent,
            xmp: &[],
        }
    }

    #[test]
    fn indexed_frame_round_trips_with_transparency() {
        let palette = [255, 0, 0, 0, 255, 0, 0, 0, 0];
        let indices = [0, 1, 2, 2, 1, 0];
        let bytes = encode(&palette_spec(&indices, &palette, Some(2))).unwrap();
        let decoded = decode_first_frame(&bytes).unwrap();
        assert_eq!((decoded.width, decoded.height), (3, 2));
        assert_eq!(
            decoded.rgba,
            [
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, //
                0, 0, 0, 0, 0, 255, 0, 255, 255, 0, 0, 255,
            ]
        );
    }

    #[test]
    fn xmp_packet_is_written_as_an_application_extension() {
        let palette = [10, 20, 30];
        let indices = [0; 6];
        let mut spec = palette_spec(&indices, &palette, None);
        spec.xmp = b"<x:xmpmeta/>";
        let bytes = encode(&spec).unwrap();
        let found = bytes
            .windows(XMP_IDENTIFIER.len())
            .any(|window| window == XMP_IDENTIFIER);
        assert!(found);
        assert!(decode_first_frame(&bytes).is_ok());
    }

    #[test]
    fn xmp_packet_round_trips_across_sub_blocks() {
        let palette = [10, 20, 30];
        let indices = [0; 6];
        let packet: Vec<u8> = (0..600u32).map(|i| b'a' + (i % 26) as u8).collect();
        let mut spec = palette_spec(&indices, &palette, None);
        spec.xmp = &packet;
        let bytes = encode(&spec).unwrap();
        let decoded = decode_first_frame(&bytes).unwrap();
        assert_eq!(decoded.xmp, packet);
        let plain = encode(&palette_spec(&indices, &palette, None)).unwrap();
        assert!(decode_first_frame(&plain).unwrap().xmp.is_empty());
    }

    #[test]
    fn only_the_first_frame_is_read() {
        let palette = [255, 255, 255, 0, 0, 0];
        let first = [0, 0, 0, 0, 0, 0];
        let mut out = Vec::new();
        {
            let mut encoder = Encoder::new(&mut out, 3, 2, &[]).unwrap();
            let frame = Frame::from_palette_pixels(3, 2, first.to_vec(), palette.to_vec(), None);
            encoder.write_frame(&frame).unwrap();
            let second = Frame::from_palette_pixels(3, 2, [1; 6].to_vec(), palette.to_vec(), None);
            encoder.write_frame(&second).unwrap();
        }
        let decoded = decode_first_frame(&out).unwrap();
        assert!(decoded
            .rgba
            .as_chunks::<4>()
            .0
            .iter()
            .all(|px| *px == [255, 255, 255, 255]));
    }

    #[test]
    fn bad_input_is_refused() {
        let palette = [0, 0, 0];
        assert!(encode(&palette_spec(&[0; 5], &palette, None)).is_err());
        assert!(encode(&palette_spec(&[1; 6], &palette, None)).is_err());
        assert!(encode(&palette_spec(&[0; 6], &palette, Some(1))).is_err());
        assert!(encode(&palette_spec(&[0; 6], &[0, 0], None)).is_err());
        assert!(decode_first_frame(b"not a gif").is_err());
    }
}
