/**
 * The sRGB color profile written as the PNG `iCCP` chunk (FMT-META-05). Documents are sRGB in v1,
 * so every PNG carries this profile. It is an ICC v4.2 matrix/TRC profile: the IEC 61966-2.1
 * primaries (adapted to D50, as the ICC requires) and the sRGB parametric curve (function type 3).
 */

const D50: readonly [number, number, number] = [0.9642, 1, 0.8249];
const RED: readonly [number, number, number] = [0.4360747, 0.2225045, 0.0139322];
const GREEN: readonly [number, number, number] = [0.3850649, 0.7168786, 0.0971045];
const BLUE: readonly [number, number, number] = [0.1430804, 0.0606169, 0.7141733];
/** sRGB transfer function: g, a, b, c, d of parametric function type 3. */
const SRGB_CURVE: readonly number[] = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045];
const HEADER_SIZE = 128;
const ICC_VERSION_4_2 = 0x04200000;
const TEXT = new TextEncoder();

/** The sRGB ICC profile bytes. Fresh on each call, so callers may keep or change them. */
export function srgbIccProfile(): Uint8Array<ArrayBuffer> {
  const trc = parametricCurve(SRGB_CURVE);
  const tags: readonly (readonly [string, Uint8Array])[] = [
    ["desc", multiLocalized("sRGB IEC61966-2.1")],
    ["cprt", multiLocalized("No copyright, use freely")],
    ["wtpt", xyz(D50)],
    ["rXYZ", xyz(RED)],
    ["gXYZ", xyz(GREEN)],
    ["bXYZ", xyz(BLUE)],
    ["rTRC", trc],
    ["gTRC", trc],
    ["bTRC", trc],
  ];
  const tableEnd = HEADER_SIZE + 4 + tags.length * 12;
  const placed: { signature: string; offset: number; data: Uint8Array }[] = [];
  let offset = tableEnd;
  for (const [signature, data] of tags) {
    placed.push({ signature, offset, data });
    offset += align4(data.length);
  }
  const profile = new Uint8Array(new ArrayBuffer(offset));
  const view = new DataView(profile.buffer);
  view.setUint32(0, offset);
  view.setUint32(8, ICC_VERSION_4_2);
  writeText(profile, 12, "mntr");
  writeText(profile, 16, "RGB ");
  writeText(profile, 20, "XYZ ");
  writeText(profile, 36, "acsp");
  view.setInt32(68, s15Fixed16(D50[0]));
  view.setInt32(72, s15Fixed16(D50[1]));
  view.setInt32(76, s15Fixed16(D50[2]));
  view.setUint32(HEADER_SIZE, tags.length);
  placed.forEach(({ signature, offset: start, data }, index) => {
    const entry = HEADER_SIZE + 4 + index * 12;
    writeText(profile, entry, signature);
    view.setUint32(entry + 4, start);
    view.setUint32(entry + 8, data.length);
    profile.set(data, start);
  });
  return profile;
}

function xyz(values: readonly number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(20));
  writeText(out, 0, "XYZ ");
  const view = new DataView(out.buffer);
  for (const [index, value] of values.entries()) view.setInt32(8 + index * 4, s15Fixed16(value));
  return out;
}

function parametricCurve(params: readonly number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(12 + params.length * 4));
  writeText(out, 0, "para");
  const view = new DataView(out.buffer);
  view.setUint16(8, params.length === 5 ? 3 : 0);
  for (const [index, value] of params.entries()) view.setInt32(12 + index * 4, s15Fixed16(value));
  return out;
}

/** A `mluc` tag with one en-US record, as the desc and cprt tags use (UTF-16BE text). */
function multiLocalized(text: string): Uint8Array<ArrayBuffer> {
  const units = Array.from(text, (char) => char.charCodeAt(0));
  const out = new Uint8Array(new ArrayBuffer(28 + units.length * 2));
  writeText(out, 0, "mluc");
  const view = new DataView(out.buffer);
  view.setUint32(8, 1);
  view.setUint32(12, 12);
  writeText(out, 16, "enUS");
  view.setUint32(20, units.length * 2);
  view.setUint32(24, 28);
  for (const [index, unit] of units.entries()) view.setUint16(28 + index * 2, unit);
  return out;
}

function s15Fixed16(value: number): number {
  return Math.round(value * 65536);
}

function align4(length: number): number {
  return (length + 3) & ~3;
}

function writeText(out: Uint8Array, offset: number, text: string): void {
  out.set(TEXT.encode(text), offset);
}
