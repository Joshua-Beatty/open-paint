//! ISO-BMFF item access for AVIF (07 FMT-META-01, FMT-META-05). An AVIF keeps its EXIF and XMP as items of
//! the `meta` box. This module reads the items of one type, and it adds an XMP item that refers to the
//! primary image. Items are read and written at absolute file offsets (construction method 0), the only
//! method the encoder uses. A file with another construction method is refused, since a rewrite could
//! not keep its items.

/// The content type of an XMP packet stored as a `mime` item (ISO/IEC 23008-12 Annex A).
pub const XMP_CONTENT_TYPE: &str = "application/rdf+xml";
const HEADER: usize = 8;
const FULL_BOX_HEADER: usize = 4;

/// A box in the file: its type, the offset of its header, its end, and the header length.
#[derive(Clone, Copy)]
struct Boxed {
    kind: [u8; 4],
    start: usize,
    end: usize,
    header: usize,
}

impl Boxed {
    fn payload(self) -> usize {
        self.start + self.header
    }
}

/// An item of the `iinf` box: its id, its type, and the content type of a `mime` item.
struct Info {
    id: u32,
    kind: [u8; 4],
    content_type: Vec<u8>,
}

/// An item of the `iloc` box: its id and its extents, as absolute file offsets and lengths.
struct Location {
    id: u32,
    extents: Vec<(u64, u64)>,
}

fn read_be(bytes: &[u8], at: usize, width: usize) -> Result<u64, String> {
    let end = at
        .checked_add(width)
        .ok_or("the AVIF container is truncated")?;
    let slice = bytes
        .get(at..end)
        .ok_or("the AVIF container is truncated")?;
    Ok(slice
        .iter()
        .fold(0u64, |value, &byte| (value << 8) | u64::from(byte)))
}

fn read_kind(bytes: &[u8], at: usize) -> Result<[u8; 4], String> {
    let slice = bytes
        .get(at..at + 4)
        .ok_or("the AVIF container is truncated")?;
    Ok([slice[0], slice[1], slice[2], slice[3]])
}

/// The boxes whose headers lie between `start` and `end`.
fn boxes(bytes: &[u8], start: usize, end: usize) -> Result<Vec<Boxed>, String> {
    let mut out = Vec::new();
    let mut at = start;
    while at < end {
        let size32 = read_be(bytes, at, 4)? as usize;
        let kind = read_kind(bytes, at + 4)?;
        let (size, header) = match size32 {
            0 => (end - at, HEADER),
            1 => (read_be(bytes, at + HEADER, 8)? as usize, 16),
            size => (size, HEADER),
        };
        if size < header || at.checked_add(size).is_none_or(|stop| stop > end) {
            return Err("the AVIF container has a bad box".to_string());
        }
        out.push(Boxed {
            kind,
            start: at,
            end: at + size,
            header,
        });
        at += size;
    }
    Ok(out)
}

fn find(boxes: &[Boxed], kind: &[u8; 4]) -> Option<Boxed> {
    boxes.iter().copied().find(|found| &found.kind == kind)
}

/// The children of a container box. A full box (such as `meta`) has four bytes of version and flags
/// before its children.
fn children(bytes: &[u8], parent: Boxed, full: bool) -> Result<Vec<Boxed>, String> {
    let start = parent.payload() + if full { FULL_BOX_HEADER } else { 0 };
    boxes(bytes, start, parent.end)
}

/// The null-terminated string at `at`, and the position after its terminator.
fn c_string(bytes: &[u8], at: usize, end: usize) -> Result<(&[u8], usize), String> {
    let window = bytes
        .get(at..end)
        .ok_or("the AVIF container is truncated")?;
    let length = window
        .iter()
        .position(|&byte| byte == 0)
        .ok_or("the AVIF container has an unterminated string")?;
    Ok((&window[..length], at + length + 1))
}

/// Where the children of an `iinf` box start, and the width of its entry count. Version 0 counts with
/// 16 bits, and version 1 and later with 32 bits.
fn iinf_layout(bytes: &[u8], iinf: Boxed) -> Result<(usize, usize), String> {
    let payload = iinf.payload();
    let count_width = if read_be(bytes, payload, 1)? == 0 {
        2
    } else {
        4
    };
    Ok((payload + FULL_BOX_HEADER + count_width, count_width))
}

/// The items of an `iinf` box.
fn infos(bytes: &[u8], iinf: Boxed) -> Result<Vec<Info>, String> {
    let (start, _) = iinf_layout(bytes, iinf)?;
    let mut out = Vec::new();
    for entry in boxes(bytes, start, iinf.end)? {
        if &entry.kind == b"infe" {
            out.extend(info_of(bytes, entry)?);
        }
    }
    Ok(out)
}

/// One `infe` box, for versions 2 and 3. Other versions carry no item type and are skipped.
fn info_of(bytes: &[u8], infe: Boxed) -> Result<Option<Info>, String> {
    let payload = infe.payload();
    let (id, kind_at) = match read_be(bytes, payload, 1)? {
        2 => (read_be(bytes, payload + 4, 2)?, payload + 8),
        3 => (read_be(bytes, payload + 4, 4)?, payload + 10),
        _ => return Ok(None),
    };
    let kind = read_kind(bytes, kind_at)?;
    let (_, after_name) = c_string(bytes, kind_at + 4, infe.end)?;
    let content_type = if &kind == b"mime" {
        c_string(bytes, after_name, infe.end)?.0.to_vec()
    } else {
        Vec::new()
    };
    Ok(Some(Info {
        id: id as u32,
        kind,
        content_type,
    }))
}

/// The locations of an `iloc` box. Only construction method 0 (the file) is accepted.
fn locations(bytes: &[u8], iloc: Boxed) -> Result<Vec<Location>, String> {
    let payload = iloc.payload();
    let version = read_be(bytes, payload, 1)?;
    let sizes = read_be(bytes, payload + 4, 1)? as usize;
    let base_sizes = read_be(bytes, payload + 5, 1)? as usize;
    let (offset_size, length_size) = (sizes >> 4, sizes & 0xF);
    let base_size = base_sizes >> 4;
    let index_size = if version == 1 || version == 2 {
        base_sizes & 0xF
    } else {
        0
    };
    if [offset_size, length_size, base_size, index_size]
        .iter()
        .any(|&size| size > 8)
    {
        return Err("the AVIF container has an unsupported item size".to_string());
    }
    let wide_ids = version >= 2;
    let id_width = if wide_ids { 4 } else { 2 };
    let mut at = payload + 6;
    let count = read_be(bytes, at, id_width)?;
    at += id_width;
    let mut out = Vec::new();
    for _ in 0..count {
        let id = read_be(bytes, at, id_width)?;
        at += id_width;
        if version == 1 || version == 2 {
            if read_be(bytes, at, 2)? & 0xF != 0 {
                return Err("the AVIF container has an item outside the file".to_string());
            }
            at += 2;
        }
        at += 2;
        let base = read_be(bytes, at, base_size)?;
        at += base_size;
        let extent_count = read_be(bytes, at, 2)?;
        at += 2;
        let mut extents = Vec::new();
        for _ in 0..extent_count {
            at += index_size;
            let offset = read_be(bytes, at, offset_size)?;
            at += offset_size;
            let length = read_be(bytes, at, length_size)?;
            at += length_size;
            extents.push((base + offset, length));
        }
        out.push(Location {
            id: id as u32,
            extents,
        });
    }
    Ok(out)
}

/// The primary item id of a `pitm` box.
fn primary_item(bytes: &[u8], pitm: Boxed) -> Result<u32, String> {
    let width = if read_be(bytes, pitm.payload(), 1)? == 0 {
        2
    } else {
        4
    };
    Ok(read_be(bytes, pitm.payload() + FULL_BOX_HEADER, width)? as u32)
}

/// The bytes of the first item of type `kind`. A `mime` item must also have `content_type`. None when the
/// file has no such item.
pub fn item_data(
    bytes: &[u8],
    kind: &[u8; 4],
    content_type: Option<&[u8]>,
) -> Result<Option<Vec<u8>>, String> {
    let top = boxes(bytes, 0, bytes.len())?;
    let Some(meta) = find(&top, b"meta") else {
        return Ok(None);
    };
    let meta_children = children(bytes, meta, true)?;
    let (Some(iinf), Some(iloc)) = (find(&meta_children, b"iinf"), find(&meta_children, b"iloc"))
    else {
        return Ok(None);
    };
    let matching = infos(bytes, iinf)?.into_iter().find(|info| {
        &info.kind == kind && content_type.is_none_or(|wanted| info.content_type == wanted)
    });
    let Some(info) = matching else {
        return Ok(None);
    };
    let Some(location) = locations(bytes, iloc)?
        .into_iter()
        .find(|location| location.id == info.id)
    else {
        return Ok(None);
    };
    let mut data = Vec::new();
    for (offset, length) in location.extents {
        let start = offset as usize;
        let end = start
            .checked_add(length as usize)
            .ok_or("the AVIF container is truncated")?;
        data.extend_from_slice(
            bytes
                .get(start..end)
                .ok_or("the AVIF container is truncated")?,
        );
    }
    Ok(Some(data))
}

/// A box with a 32-bit size header, around `body`.
fn boxed(kind: &[u8; 4], body: &[u8]) -> Result<Vec<u8>, String> {
    let size = u32::try_from(body.len() + HEADER).map_err(|_| "the AVIF metadata is too large")?;
    let mut out = size.to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    Ok(out)
}

/// The `iloc` box in version 0, with 32-bit offsets and lengths and no base offset.
fn write_iloc(locations: &[Location]) -> Result<Vec<u8>, String> {
    let mut body = vec![0, 0, 0, 0, 0x44, 0x00];
    let count = u16::try_from(locations.len()).map_err(|_| "too many AVIF items")?;
    body.extend_from_slice(&count.to_be_bytes());
    for location in locations {
        let id = u16::try_from(location.id).map_err(|_| "too many AVIF items")?;
        body.extend_from_slice(&id.to_be_bytes());
        body.extend_from_slice(&[0, 0]);
        let extents = u16::try_from(location.extents.len()).map_err(|_| "too many extents")?;
        body.extend_from_slice(&extents.to_be_bytes());
        for &(offset, length) in &location.extents {
            let offset = u32::try_from(offset).map_err(|_| "the AVIF data is too large")?;
            let length = u32::try_from(length).map_err(|_| "the AVIF data is too large")?;
            body.extend_from_slice(&offset.to_be_bytes());
            body.extend_from_slice(&length.to_be_bytes());
        }
    }
    boxed(b"iloc", &body)
}

/// Adds an item of type `mime` with `content_type` and `data` to the file. The item refers to the
/// primary image with a `cdsc` reference, as an AVIF XMP packet does. The data goes in a new `mdat` at the
/// end, so the existing items keep their bytes. Their offsets move with the `meta` box, which may grow.
pub fn add_mime_item(bytes: &[u8], content_type: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let top = boxes(bytes, 0, bytes.len())?;
    let meta = find(&top, b"meta").ok_or("the AVIF has no meta box")?;
    let meta_version_flags = bytes
        .get(meta.payload()..meta.payload() + FULL_BOX_HEADER)
        .ok_or("the AVIF container is truncated")?
        .to_vec();
    let meta_children = children(bytes, meta, true)?;
    let pitm = find(&meta_children, b"pitm").ok_or("the AVIF has no primary item")?;
    let primary = u16::try_from(primary_item(bytes, pitm)?)
        .map_err(|_| "the AVIF primary item is out of range")?;
    let iinf = find(&meta_children, b"iinf");
    let iloc = find(&meta_children, b"iloc");
    let iref = find(&meta_children, b"iref");
    let existing_infos = match iinf {
        Some(iinf) => infos(bytes, iinf)?,
        None => Vec::new(),
    };
    let existing_locations = match iloc {
        Some(iloc) => locations(bytes, iloc)?,
        None => Vec::new(),
    };
    let next_id = existing_infos
        .iter()
        .map(|info| info.id)
        .chain(existing_locations.iter().map(|location| location.id))
        .max()
        .unwrap_or(0)
        + 1;
    let new_id = u16::try_from(next_id).map_err(|_| "too many AVIF items")?;

    let mut infe_body = vec![2, 0, 0, 0];
    infe_body.extend_from_slice(&new_id.to_be_bytes());
    infe_body.extend_from_slice(&[0, 0]);
    infe_body.extend_from_slice(b"mime");
    infe_body.push(0);
    infe_body.extend_from_slice(content_type.as_bytes());
    infe_body.push(0);
    let new_infe = boxed(b"infe", &infe_body)?;

    let mut cdsc_body = new_id.to_be_bytes().to_vec();
    cdsc_body.extend_from_slice(&1u16.to_be_bytes());
    cdsc_body.extend_from_slice(&primary.to_be_bytes());
    let cdsc = boxed(b"cdsc", &cdsc_body)?;

    let iinf_box = || -> Result<Vec<u8>, String> {
        let mut body = match iinf {
            Some(iinf) => {
                let (start, count_width) = iinf_layout(bytes, iinf)?;
                let count = read_be(bytes, iinf.payload() + FULL_BOX_HEADER, count_width)? + 1;
                let mut body = bytes[iinf.payload()..iinf.payload() + FULL_BOX_HEADER].to_vec();
                body.extend_from_slice(&count.to_be_bytes()[8 - count_width..]);
                body.extend_from_slice(&bytes[start..iinf.end]);
                body
            }
            None => vec![0, 0, 0, 0, 0, 1],
        };
        body.extend_from_slice(&new_infe);
        boxed(b"iinf", &body)
    };

    let iref_box = || -> Result<Vec<u8>, String> {
        let mut body = match iref {
            Some(iref) => {
                if read_be(bytes, iref.payload(), 1)? != 0 {
                    return Err("the AVIF container has an unsupported iref version".to_string());
                }
                bytes[iref.payload()..iref.end].to_vec()
            }
            None => vec![0, 0, 0, 0],
        };
        body.extend_from_slice(&cdsc);
        boxed(b"iref", &body)
    };

    let build = |delta: i64, data_at: u64| -> Result<Vec<u8>, String> {
        let mut moved = Vec::new();
        for location in &existing_locations {
            let mut extents = Vec::with_capacity(location.extents.len());
            for &(offset, length) in &location.extents {
                let offset = if offset as usize >= meta.end {
                    u64::try_from(offset as i64 + delta)
                        .map_err(|_| "the AVIF offsets are invalid".to_string())?
                } else {
                    offset
                };
                extents.push((offset, length));
            }
            moved.push(Location {
                id: location.id,
                extents,
            });
        }
        moved.push(Location {
            id: next_id,
            extents: vec![(data_at, data.len() as u64)],
        });
        let iloc_box = write_iloc(&moved)?;

        let mut payload = meta_version_flags.clone();
        let mut written = [false; 3];
        for child in &meta_children {
            match &child.kind {
                b"iinf" => {
                    payload.extend_from_slice(&iinf_box()?);
                    written[0] = true;
                }
                b"iloc" => {
                    payload.extend_from_slice(&iloc_box);
                    written[1] = true;
                }
                b"iref" => {
                    payload.extend_from_slice(&iref_box()?);
                    written[2] = true;
                }
                _ => payload.extend_from_slice(&bytes[child.start..child.end]),
            }
        }
        if !written[0] {
            payload.extend_from_slice(&iinf_box()?);
        }
        if !written[1] {
            payload.extend_from_slice(&iloc_box);
        }
        if !written[2] {
            payload.extend_from_slice(&iref_box()?);
        }
        boxed(b"meta", &payload)
    };

    let first = build(0, 0)?;
    let delta = first.len() as i64 - (meta.end - meta.start) as i64;
    let mdat_data_at = (meta.start + first.len() + (bytes.len() - meta.end) + HEADER) as u64;
    let meta_box = build(delta, mdat_data_at)?;
    if meta_box.len() != first.len() {
        return Err("the AVIF metadata changed size while it was rewritten".to_string());
    }

    let mut out = Vec::with_capacity(bytes.len() + meta_box.len() + data.len() + HEADER);
    out.extend_from_slice(&bytes[..meta.start]);
    out.extend_from_slice(&meta_box);
    out.extend_from_slice(&bytes[meta.end..]);
    out.extend_from_slice(&boxed(b"mdat", data)?);
    Ok(out)
}

/// Adds the ICC profile `icc` to the primary item as a `colr` property of type `prof` (FMT-META-05). The
/// property goes at the end of `ipco`, and the primary item's `ipma` entry refers to it. The `meta` box
/// grows, so the offsets of the data after it move with it, as in `add_mime_item`.
pub fn add_icc_profile(bytes: &[u8], icc: &[u8]) -> Result<Vec<u8>, String> {
    let top = boxes(bytes, 0, bytes.len())?;
    let meta = find(&top, b"meta").ok_or("the AVIF has no meta box")?;
    let meta_version_flags = bytes
        .get(meta.payload()..meta.payload() + FULL_BOX_HEADER)
        .ok_or("the AVIF container is truncated")?
        .to_vec();
    let meta_children = children(bytes, meta, true)?;
    let pitm = find(&meta_children, b"pitm").ok_or("the AVIF has no primary item")?;
    let primary = primary_item(bytes, pitm)?;
    let iloc = find(&meta_children, b"iloc").ok_or("the AVIF has no item locations")?;
    let existing = locations(bytes, iloc)?;
    let iprp = find(&meta_children, b"iprp").ok_or("the AVIF has no item properties")?;
    let iprp_children = children(bytes, iprp, false)?;
    let ipco = find(&iprp_children, b"ipco").ok_or("the AVIF has no property container")?;
    let ipma = find(&iprp_children, b"ipma").ok_or("the AVIF has no property associations")?;

    let index = boxes(bytes, ipco.payload(), ipco.end)?.len() + 1;
    let mut colr_body = b"prof".to_vec();
    colr_body.extend_from_slice(icc);
    let mut ipco_body = bytes[ipco.payload()..ipco.end].to_vec();
    ipco_body.extend_from_slice(&boxed(b"colr", &colr_body)?);
    let new_ipco = boxed(b"ipco", &ipco_body)?;
    let new_ipma = associate(bytes, ipma, primary, index)?;

    let mut iprp_body = Vec::new();
    for child in &iprp_children {
        match &child.kind {
            b"ipco" => iprp_body.extend_from_slice(&new_ipco),
            b"ipma" => iprp_body.extend_from_slice(&new_ipma),
            _ => iprp_body.extend_from_slice(&bytes[child.start..child.end]),
        }
    }
    let new_iprp = boxed(b"iprp", &iprp_body)?;

    let build = |delta: i64| -> Result<Vec<u8>, String> {
        let mut moved = Vec::with_capacity(existing.len());
        for location in &existing {
            let mut extents = Vec::with_capacity(location.extents.len());
            for &(offset, length) in &location.extents {
                let offset = if offset as usize >= meta.end {
                    u64::try_from(offset as i64 + delta)
                        .map_err(|_| "the AVIF offsets are invalid".to_string())?
                } else {
                    offset
                };
                extents.push((offset, length));
            }
            moved.push(Location {
                id: location.id,
                extents,
            });
        }
        let iloc_box = write_iloc(&moved)?;
        let mut payload = meta_version_flags.clone();
        for child in &meta_children {
            match &child.kind {
                b"iloc" => payload.extend_from_slice(&iloc_box),
                b"iprp" => payload.extend_from_slice(&new_iprp),
                _ => payload.extend_from_slice(&bytes[child.start..child.end]),
            }
        }
        boxed(b"meta", &payload)
    };

    let first = build(0)?;
    let delta = first.len() as i64 - (meta.end - meta.start) as i64;
    let meta_box = build(delta)?;
    if meta_box.len() != first.len() {
        return Err("the AVIF metadata changed size while it was rewritten".to_string());
    }

    let mut out = Vec::with_capacity(bytes.len() + meta_box.len());
    out.extend_from_slice(&bytes[..meta.start]);
    out.extend_from_slice(&meta_box);
    out.extend_from_slice(&bytes[meta.end..]);
    Ok(out)
}

/// The `ipma` box with `index` added as a non-essential association of the entry for `item`.
fn associate(bytes: &[u8], ipma: Boxed, item: u32, index: usize) -> Result<Vec<u8>, String> {
    let payload = ipma.payload();
    let id_width = if read_be(bytes, payload, 1)? == 0 {
        2
    } else {
        4
    };
    let wide_index = read_be(bytes, payload + 3, 1)? & 1 == 1;
    let count = read_be(bytes, payload + FULL_BOX_HEADER, 4)? as usize;
    let mut out = bytes[payload..payload + FULL_BOX_HEADER + 4].to_vec();
    let mut at = payload + FULL_BOX_HEADER + 4;
    let mut associated = false;
    for _ in 0..count {
        let entry_start = at;
        let id = read_be(bytes, at, id_width)? as u32;
        at += id_width;
        let associations = read_be(bytes, at, 1)? as usize;
        at += 1;
        let width = if wide_index { 2 } else { 1 };
        let body_len = associations * width;
        let body = bytes
            .get(at..at + body_len)
            .ok_or("the AVIF container is truncated")?;
        at += body_len;
        if id == item {
            let limit = if wide_index { 0x7FFF } else { 0x7F };
            if index > limit || associations >= 255 {
                return Err("the AVIF has too many item properties".to_string());
            }
            associated = true;
            out.extend_from_slice(&bytes[entry_start..entry_start + id_width]);
            out.push((associations + 1) as u8);
            out.extend_from_slice(body);
            if wide_index {
                out.extend_from_slice(&(index as u16).to_be_bytes());
            } else {
                out.push(index as u8);
            }
        } else {
            out.extend_from_slice(&bytes[entry_start..at]);
        }
    }
    if !associated {
        return Err("the AVIF primary item has no properties".to_string());
    }
    boxed(b"ipma", &out)
}

/// The primary item's id and the children of the `meta` box.
fn primary_context(bytes: &[u8]) -> Result<(u32, Vec<Boxed>), String> {
    let top = boxes(bytes, 0, bytes.len())?;
    let meta = find(&top, b"meta").ok_or("the AVIF has no meta box")?;
    let meta_children = children(bytes, meta, true)?;
    let pitm = find(&meta_children, b"pitm").ok_or("the AVIF has no primary item")?;
    Ok((primary_item(bytes, pitm)?, meta_children))
}

/// The property boxes that `item` refers to, in association order (`ipma`).
fn properties_of(bytes: &[u8], iprp: Boxed, item: u32) -> Result<Vec<Boxed>, String> {
    let iprp_children = children(bytes, iprp, false)?;
    let ipco = find(&iprp_children, b"ipco").ok_or("the AVIF has no property container")?;
    let ipma = find(&iprp_children, b"ipma").ok_or("the AVIF has no property associations")?;
    let properties = boxes(bytes, ipco.payload(), ipco.end)?;
    let payload = ipma.payload();
    let id_width = if read_be(bytes, payload, 1)? == 0 {
        2
    } else {
        4
    };
    let wide_index = read_be(bytes, payload + 3, 1)? & 1 == 1;
    let count = read_be(bytes, payload + FULL_BOX_HEADER, 4)? as usize;
    let mut at = payload + FULL_BOX_HEADER + 4;
    let mut out = Vec::new();
    for _ in 0..count {
        let id = read_be(bytes, at, id_width)? as u32;
        at += id_width;
        let associations = read_be(bytes, at, 1)? as usize;
        at += 1;
        for _ in 0..associations {
            let index = if wide_index {
                let value = read_be(bytes, at, 2)? & 0x7FFF;
                at += 2;
                value
            } else {
                let value = read_be(bytes, at, 1)? & 0x7F;
                at += 1;
                value
            } as usize;
            if id == item && index >= 1 {
                let property = properties
                    .get(index - 1)
                    .ok_or("the AVIF refers to a missing property")?;
                out.push(*property);
            }
        }
    }
    Ok(out)
}

/// The ICC profile of the primary item, from its `colr` property of type `prof` (FMT-META-03). None when
/// the file has none.
pub fn primary_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    let (primary, meta_children) = primary_context(bytes).ok()?;
    let iprp = find(&meta_children, b"iprp")?;
    for property in properties_of(bytes, iprp, primary).ok()? {
        if &property.kind == b"colr" && read_kind(bytes, property.payload()).ok()? == *b"prof" {
            return bytes
                .get(property.payload() + 4..property.end)
                .map(<[u8]>::to_vec);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file with one `av01` primary item (id 1) whose bytes `data` sit in an `mdat`, laid out as the
    /// encoder lays out its boxes: `ftyp`, `meta`, then `mdat`.
    fn file_with_primary(data: &[u8]) -> Vec<u8> {
        let ftyp = boxed(b"ftyp", b"avif\0\0\0\0avif").unwrap();
        let mut infe = vec![2, 0, 0, 0, 0, 1, 0, 0];
        infe.extend_from_slice(b"av01\0");
        let mut iinf = vec![0, 0, 0, 0, 0, 1];
        iinf.extend_from_slice(&boxed(b"infe", &infe).unwrap());
        let meta_with = |offset: u64| {
            let mut body = vec![0, 0, 0, 0];
            body.extend_from_slice(&boxed(b"pitm", &[0, 0, 0, 0, 0, 1]).unwrap());
            body.extend_from_slice(&boxed(b"iinf", &iinf).unwrap());
            let location = Location {
                id: 1,
                extents: vec![(offset, data.len() as u64)],
            };
            body.extend_from_slice(&write_iloc(&[location]).unwrap());
            boxed(b"meta", &body).unwrap()
        };
        let meta_len = meta_with(0).len();
        let data_at = (ftyp.len() + meta_len + HEADER) as u64;
        let mut file = ftyp;
        file.extend_from_slice(&meta_with(data_at));
        file.extend_from_slice(&boxed(b"mdat", data).unwrap());
        file
    }

    #[test]
    fn reads_the_primary_item_and_refuses_nothing_else() {
        let file = file_with_primary(b"primary");
        assert_eq!(
            item_data(&file, b"av01", None).unwrap(),
            Some(b"primary".to_vec())
        );
        assert_eq!(item_data(&file, b"Exif", None).unwrap(), None);
    }

    #[test]
    fn adds_xmp_and_keeps_every_existing_item_readable() {
        let file = file_with_primary(b"primary");
        let xmp = b"<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"/>";
        let once = add_mime_item(&file, "application/rdf+xml", xmp).unwrap();
        assert!(once.len() > file.len());
        assert_eq!(
            item_data(&once, b"mime", Some(b"application/rdf+xml")).unwrap(),
            Some(xmp.to_vec())
        );
        assert_eq!(
            item_data(&once, b"av01", None).unwrap(),
            Some(b"primary".to_vec())
        );

        let twice = add_mime_item(&once, "application/rdf+xml", b"second").unwrap();
        assert_eq!(
            item_data(&twice, b"mime", Some(b"application/rdf+xml")).unwrap(),
            Some(xmp.to_vec())
        );
        assert_eq!(
            item_data(&twice, b"av01", None).unwrap(),
            Some(b"primary".to_vec())
        );
    }

    #[test]
    fn a_file_without_meta_is_refused() {
        let file = boxed(b"ftyp", b"avif\0\0\0\0avif").unwrap();
        assert!(add_mime_item(&file, "application/rdf+xml", b"x").is_err());
        assert_eq!(item_data(&file, b"Exif", None).unwrap(), None);
    }

    #[test]
    fn a_truncated_file_is_refused() {
        let file = file_with_primary(b"primary");
        assert!(item_data(&file[..file.len() - 40], b"av01", None).is_err());
    }
}
