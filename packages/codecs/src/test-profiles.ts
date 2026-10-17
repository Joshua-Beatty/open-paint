/**
 * Matrix/TRC RGB and gray profiles for the tests, written the way an ICC v2 or v4 profile lays out
 * its tags.
 */

const PRIMARIES: readonly (readonly number[])[] = [
  [0.4360747, 0.2225045, 0.0139322],
  [0.3850649, 0.7168786, 0.0971045],
  [0.1430804, 0.0606169, 0.7141733],
];
const D50 = [0.9642, 1, 0.8249];
const TEXT = new TextEncoder();
const HEADER_SIZE = 128;

/** A profile with the sRGB primaries and the given tone curve on the red, green and blue channels. */
export function matrixProfile(curve: Uint8Array): Uint8Array {
  return profileOf("RGB ", [
    ["rXYZ", xyz(PRIMARIES[0] ?? [])],
    ["gXYZ", xyz(PRIMARIES[1] ?? [])],
    ["bXYZ", xyz(PRIMARIES[2] ?? [])],
    ["rTRC", curve],
    ["gTRC", curve],
    ["bTRC", curve],
  ]);
}

/** A gray profile with the given tone curve over the D50 white point. */
export function grayProfile(curve: Uint8Array): Uint8Array {
  return profileOf("GRAY", [
    ["wtpt", xyz(D50)],
    ["kTRC", curve],
  ]);
}

/** A profile of the given color space ("RGB " or "GRAY") with the tags laid out after the header. */
function profileOf(space: string, tags: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const dataStart = HEADER_SIZE + 4 + tags.length * 12;
  let total = dataStart;
  const placed = tags.map(([signature, data]) => {
    const offset = total;
    total += (data.length + 3) & ~3;
    return { signature, data, offset };
  });
  const profile = new Uint8Array(total);
  const view = new DataView(profile.buffer);
  view.setUint32(0, total);
  profile.set(TEXT.encode("mntr"), 12);
  profile.set(TEXT.encode(space), 16);
  profile.set(TEXT.encode("XYZ "), 20);
  profile.set(TEXT.encode("acsp"), 36);
  view.setUint32(HEADER_SIZE, tags.length);
  for (const [index, tag] of placed.entries()) {
    const entry = HEADER_SIZE + 4 + index * 12;
    profile.set(TEXT.encode(tag.signature), entry);
    view.setUint32(entry + 4, tag.offset);
    view.setUint32(entry + 8, tag.data.length);
    profile.set(tag.data, tag.offset);
  }
  return profile;
}

/** A `curv` tag with no entries: the identity (linear) curve. */
export function linearCurve(): Uint8Array {
  return curvBytes(0);
}

/** A `para` tag of type 0: a pure power curve. */
export function gammaCurve(gamma: number): Uint8Array {
  const out = new Uint8Array(16);
  out.set(TEXT.encode("para"), 0);
  new DataView(out.buffer).setInt32(12, Math.round(gamma * 65536));
  return out;
}

/** A `curv` tag with a table of 16-bit entries spread over [0, 1]. */
export function tableCurve(values: readonly number[]): Uint8Array {
  const out = curvBytes(values.length);
  const view = new DataView(out.buffer);
  for (const [index, value] of values.entries()) view.setUint16(12 + index * 2, value);
  return out;
}

function curvBytes(count: number): Uint8Array {
  const out = new Uint8Array(12 + count * 2);
  out.set(TEXT.encode("curv"), 0);
  new DataView(out.buffer).setUint32(8, count);
  return out;
}

function xyz(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(20);
  out.set(TEXT.encode("XYZ "), 0);
  const view = new DataView(out.buffer);
  for (const [index, value] of values.entries())
    view.setInt32(8 + index * 4, Math.round(value * 65536));
  return out;
}
