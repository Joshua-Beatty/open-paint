import { srgbToLinear } from "@openpaint/document";

/**
 * The default CMYK profile for a CMYK image that embeds none (FMT-META-03). No openly licensed CMYK
 * press profile is bundled, so this one is generated: an ICC v2 device-to-PCS table (`mft2`, lut16)
 * on a 9-point grid. Each ink reduces the sRGB channel it opposes, multiplicatively with black, so
 * pure cyan is (0, 255, 255) and full black is (0, 0, 0). The table is converted to CIE L*a*b* (D50),
 * the profile connection space, and the color engine converts it to sRGB like any other profile.
 */

const GRID = 9;
const TABLE_HEADER_BYTES = 52;
const HEADER_BYTES = 128;
const TEXT = new TextEncoder();
const LAB_MAX = 65535;
const LAB_L_MAX = 0xff00;
const D50 = [0.9642, 1.0, 0.8249] as const;
/** The sRGB primaries in D50 XYZ, row-major: X, Y and Z rows over the red, green and blue columns. */
const SRGB_TO_XYZ = [
  0.4360747, 0.3850649, 0.1430804, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733,
] as const;
const LAB_EPSILON = (6 / 29) ** 3;
const LAB_KAPPA = 1 / (3 * (6 / 29) ** 2);

let cached: Uint8Array | undefined;

/** The generated default CMYK profile, built once. */
export function defaultCmykProfile(): Uint8Array {
  cached ??= buildCmykProfile();
  return cached;
}

function buildCmykProfile(): Uint8Array {
  const table = lut16();
  const tags: readonly (readonly [string, Uint8Array])[] = [
    ["wtpt", xyzTag(D50)],
    ["A2B0", table],
    ["A2B1", table],
  ];
  const dataStart = HEADER_BYTES + 4 + tags.length * 12;
  let total = dataStart;
  const placed = tags.map(([signature, data]) => {
    const offset = total;
    total += (data.length + 3) & ~3;
    return { signature, data, offset };
  });
  const profile = new Uint8Array(total);
  const view = new DataView(profile.buffer);
  view.setUint32(0, total);
  view.setUint32(8, 0x02100000);
  profile.set(TEXT.encode("prtr"), 12);
  profile.set(TEXT.encode("CMYK"), 16);
  profile.set(TEXT.encode("Lab "), 20);
  view.setUint16(24, 2026);
  view.setUint16(26, 10);
  view.setUint16(28, 13);
  profile.set(TEXT.encode("acsp"), 36);
  for (const [index, value] of D50.entries()) {
    view.setInt32(68 + index * 4, Math.round(value * 65536));
  }
  view.setUint32(HEADER_BYTES, tags.length);
  for (const [index, tag] of placed.entries()) {
    const entry = HEADER_BYTES + 4 + index * 12;
    profile.set(TEXT.encode(tag.signature), entry);
    view.setUint32(entry + 4, tag.offset);
    view.setUint32(entry + 8, tag.data.length);
    profile.set(tag.data, tag.offset);
  }
  return profile;
}

/** An `XYZ ` tag holding the given values. */
function xyzTag(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(20);
  out.set(TEXT.encode("XYZ "), 0);
  const view = new DataView(out.buffer);
  for (const [index, value] of values.entries()) {
    view.setInt32(8 + index * 4, Math.round(value * 65536));
  }
  return out;
}

/**
 * A `mft2` (lut16) table from CMYK to L*a*b*, with identity input and output curves. The grid is
 * ordered with the first ink slowest and the last fastest, as ICC requires.
 */
function lut16(): Uint8Array {
  const inputEntries = 2;
  const outputEntries = 2;
  const clutValues = GRID ** 4 * 3;
  const inputTables = 4 * inputEntries * 2;
  const outputTables = 3 * outputEntries * 2;
  const out = new Uint8Array(TABLE_HEADER_BYTES + inputTables + clutValues * 2 + outputTables);
  const view = new DataView(out.buffer);
  out.set(TEXT.encode("mft2"), 0);
  out[8] = 4;
  out[9] = 3;
  out[10] = GRID;
  for (const diagonal of [0, 4, 8]) view.setInt32(12 + diagonal * 4, 65536);
  view.setUint16(48, inputEntries);
  view.setUint16(50, outputEntries);
  let at = TABLE_HEADER_BYTES;
  for (let channel = 0; channel < 4; channel += 1) {
    view.setUint16(at, 0);
    view.setUint16(at + 2, LAB_MAX);
    at += 4;
  }
  for (let c = 0; c < GRID; c += 1)
    for (let m = 0; m < GRID; m += 1)
      for (let y = 0; y < GRID; y += 1)
        for (let k = 0; k < GRID; k += 1) {
          const lab = labOfInks([c, m, y, k].map((step) => step / (GRID - 1)));
          for (const value of encodeLab(lab)) {
            view.setUint16(at, value);
            at += 2;
          }
        }
  for (let channel = 0; channel < 3; channel += 1) {
    view.setUint16(at, 0);
    view.setUint16(at + 2, LAB_MAX);
    at += 4;
  }
  return out;
}

/** The L*a*b* of a CMYK ink mix, in the D50 profile connection space. Each ink is 0 to 1. */
function labOfInks([c = 0, m = 0, y = 0, k = 0]: readonly number[]): readonly number[] {
  const encoded = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  const linear = encoded.map((value) => srgbToLinear(value));
  const xyz = [0, 1, 2].map(
    (row) =>
      (SRGB_TO_XYZ[row * 3] ?? 0) * (linear[0] ?? 0) +
      (SRGB_TO_XYZ[row * 3 + 1] ?? 0) * (linear[1] ?? 0) +
      (SRGB_TO_XYZ[row * 3 + 2] ?? 0) * (linear[2] ?? 0),
  );
  const [fx, fy, fz] = xyz.map((value, index) => labCurve(value / (D50[index] ?? 1)));
  return [116 * (fy ?? 0) - 16, 500 * ((fx ?? 0) - (fy ?? 0)), 200 * ((fy ?? 0) - (fz ?? 0))];
}

function labCurve(ratio: number): number {
  return ratio > LAB_EPSILON ? Math.cbrt(ratio) : ratio * LAB_KAPPA + 4 / 29;
}

/** L* in 0 to 100 and a*, b* in -128 to 127 as the ICC version 2 16-bit Lab encoding. */
function encodeLab([l = 0, a = 0, b = 0]: readonly number[]): readonly number[] {
  return [l, a, b].map((value, index) => {
    const scaled =
      index === 0
        ? (clamp(value, 0, 100) / 100) * LAB_L_MAX
        : (clamp(value, -128, 127.996) + 128) * 256;
    return Math.round(scaled);
  });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
