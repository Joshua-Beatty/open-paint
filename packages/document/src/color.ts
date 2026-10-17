/** 8-bit straight-alpha color, gamma-encoded in the document color space (ARC-01-01/02). */
export interface ColorRgba8 {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** High-precision color with channels in [0, 1]; straight alpha. Gamma depends on context. */
export interface ColorF {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export const TRANSPARENT: ColorRgba8 = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });
export const BLACK: ColorRgba8 = Object.freeze({ r: 0, g: 0, b: 0, a: 255 });
export const WHITE: ColorRgba8 = Object.freeze({ r: 255, g: 255, b: 255, a: 255 });

const clampByte = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
const clampUnit = (v: number) => Math.min(1, Math.max(0, v));

/** Builds an 8-bit color, rounding and clamping each channel to [0, 255]. */
export function rgba8(r: number, g: number, b: number, a = 255): ColorRgba8 {
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b), a: clampByte(a) };
}

export function colorsEqual(x: ColorRgba8, y: ColorRgba8): boolean {
  return x.r === y.r && x.g === y.g && x.b === y.b && x.a === y.a;
}

export function toColorF(c: ColorRgba8): ColorF {
  return { r: c.r / 255, g: c.g / 255, b: c.b / 255, a: c.a / 255 };
}

export function toColorRgba8(c: ColorF): ColorRgba8 {
  return rgba8(
    clampUnit(c.r) * 255,
    clampUnit(c.g) * 255,
    clampUnit(c.b) * 255,
    clampUnit(c.a) * 255,
  );
}

/** Packs into a uint32 whose little-endian bytes are R, G, B, A (a `Uint32Array` view's order). */
export function packRgba8(c: ColorRgba8): number {
  return (c.r | (c.g << 8) | (c.b << 16) | (c.a << 24)) >>> 0;
}

export function unpackRgba8(v: number): ColorRgba8 {
  return { r: v & 0xff, g: (v >>> 8) & 0xff, b: (v >>> 16) & 0xff, a: v >>> 24 };
}

/** Same rounding as the Rust `premultiply_rgba8` kernel: `(c * a + 127) / 255`. */
export function premultiply(c: ColorRgba8): ColorRgba8 {
  const p = (v: number) => Math.floor((v * c.a + 127) / 255);
  return { r: p(c.r), g: p(c.g), b: p(c.b), a: c.a };
}

/** Inverse of `premultiply` with round-to-nearest; zero alpha gives transparent black. */
export function unpremultiply(c: ColorRgba8): ColorRgba8 {
  if (c.a === 0) return TRANSPARENT;
  const u = (v: number) => Math.min(255, Math.floor((v * 255 + (c.a >> 1)) / c.a));
  return { r: u(c.r), g: u(c.g), b: u(c.b), a: c.a };
}

/** sRGB transfer function: gamma-encoded [0, 1] to linear [0, 1]. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** Converts color channels (not alpha) between gamma-encoded sRGB and linear sRGB. */
export function colorToLinear(c: ColorF): ColorF {
  return { r: srgbToLinear(c.r), g: srgbToLinear(c.g), b: srgbToLinear(c.b), a: c.a };
}

export function colorFromLinear(c: ColorF): ColorF {
  return { r: linearToSrgb(c.r), g: linearToSrgb(c.g), b: linearToSrgb(c.b), a: c.a };
}
