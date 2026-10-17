/** An RGB color with channels in [0, 1]. */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export interface Hsv {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

export function rgbToHsv({ r, g, b }: RgbColor): Hsv {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const s = max === 0 ? 0 : delta / max;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  return { h: (h + 360) % 360, s, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): RgbColor {
  const chroma = v * s;
  const sector = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  const offset = v - chroma;
  let rgb: readonly [number, number, number];
  if (sector < 1) rgb = [chroma, x, 0];
  else if (sector < 2) rgb = [x, chroma, 0];
  else if (sector < 3) rgb = [0, chroma, x];
  else if (sector < 4) rgb = [0, x, chroma];
  else if (sector < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  return { r: rgb[0] + offset, g: rgb[1] + offset, b: rgb[2] + offset };
}

/** Packs a color into a 24-bit RGB integer (0xRRGGBB), the form used by Int32 color properties. */
export function packRgb({ r, g, b }: RgbColor): number {
  return (toByte(r) << 16) | (toByte(g) << 8) | toByte(b);
}

export function unpackRgb(packed: number): RgbColor {
  return {
    r: ((packed >> 16) & 255) / 255,
    g: ((packed >> 8) & 255) / 255,
    b: (packed & 255) / 255,
  };
}

export function toByte(channel: number): number {
  return Math.round(Math.min(1, Math.max(0, channel)) * 255);
}

/**
 * The position of a hue and saturation on the wheel, as offsets from the centre in [-1, 1]. Hue 0
 * sits at 3 o'clock and increases clockwise, the same as the SVG and CSS angle convention.
 */
export function wheelPosition(h: number, s: number): { x: number; y: number } {
  const radians = (h * Math.PI) / 180;
  return { x: s * Math.cos(radians), y: s * Math.sin(radians) };
}

/** The hue and saturation under a point given as an offset from the wheel centre. */
export function wheelPick(x: number, y: number): { h: number; s: number } {
  const h = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { h, s: Math.min(1, Math.hypot(x, y)) };
}
