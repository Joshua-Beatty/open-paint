/** A straight-alpha sRGB color with 8 bits per channel (DOC-COL-01). */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Hue in degrees [0, 360), saturation and value in percent [0, 100]. */
export interface Hsv {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };
export const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

/** The saturation gamma of the color wheel (UI-FTW-06): saturation = radius ^ 1.4. */
export const WHEEL_GAMMA = 1.4;

/** Rounds to a channel value, clamped to [0, 255]. NaN counts as 0. */
export function clampChannel(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function rgbaEquals(left: Rgba, right: Rgba): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b && left.a === right.a;
}

export function rgbToHsv({ r, g, b }: Rgba): Hsv {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return { h: hue, s: max === 0 ? 0 : (delta / max) * 100, v: max * 100 };
}

/** Converts HSV to RGB. The alpha is carried over unchanged. */
export function hsvToRgb(hsv: Hsv, alpha = 255): Rgba {
  const hue = ((hsv.h % 360) + 360) % 360;
  const saturation = Math.min(1, Math.max(0, hsv.s / 100));
  const value = Math.min(1, Math.max(0, hsv.v / 100));
  const chroma = value * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = value - chroma;
  let red = chroma;
  let green = secondary;
  let blue = 0;
  switch (Math.floor(hue / 60)) {
    case 0:
      break;
    case 1:
      [red, green] = [secondary, chroma];
      break;
    case 2:
      [red, green, blue] = [0, chroma, secondary];
      break;
    case 3:
      [red, green, blue] = [0, secondary, chroma];
      break;
    case 4:
      [red, green, blue] = [secondary, 0, chroma];
      break;
    default:
      [red, green, blue] = [chroma, 0, secondary];
  }
  return {
    r: clampChannel((red + offset) * 255),
    g: clampChannel((green + offset) * 255),
    b: clampChannel((blue + offset) * 255),
    a: alpha,
  };
}

function hexByte(value: number): string {
  return clampChannel(value).toString(16).padStart(2, "0").toUpperCase();
}

/** The six digits RRGGBB, without alpha or a "#". */
export function rgbHex(color: Rgba): string {
  return `${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
}

/** Parses RRGGBB. A leading "#" and surrounding spaces are accepted. Returns null otherwise. */
export function parseRgbHex(text: string): { r: number; g: number; b: number } | null {
  const digits = text.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) return null;
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

/** The eight digits AARRGGBB of the palette file format (DOC-COL-03). */
export function argbHex(color: Rgba): string {
  return `${hexByte(color.a)}${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
}

/** Parses eight hex digits AARRGGBB. Returns null when the text is not exactly that. */
export function parseArgbHex(text: string): Rgba | null {
  if (!/^[0-9a-fA-F]{8}$/.test(text)) return null;
  return {
    a: Number.parseInt(text.slice(0, 2), 16),
    r: Number.parseInt(text.slice(2, 4), 16),
    g: Number.parseInt(text.slice(4, 6), 16),
    b: Number.parseInt(text.slice(6, 8), 16),
  };
}

/**
 * The wheel position of a color as fractions of the wheel radius, with y pointing down. Hue is
 * the angle, measured clockwise from the right (UI-FTW-06).
 */
export function wheelPosition(hsv: Hsv): { readonly x: number; readonly y: number } {
  const radius = (hsv.s / 100) ** (1 / WHEEL_GAMMA);
  const angle = (hsv.h * Math.PI) / 180;
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

export interface WheelModifiers {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
}

/**
 * The HSV value under a pointer at (x, y) fractions of the radius, from the wheel's center. Shift
 * snaps the hue to 15 degrees, Ctrl keeps the radius (saturation) and Alt keeps the hue, as the
 * Proposed modifiers of UI-FTW-06 say.
 */
export function wheelPick(current: Hsv, x: number, y: number, modifiers: WheelModifiers): Hsv {
  const radius = Math.min(1, Math.hypot(x, y));
  let hue = (Math.atan2(y, x) * 180) / Math.PI;
  hue = ((hue % 360) + 360) % 360;
  if (modifiers.shift) hue = (Math.round(hue / 15) * 15) % 360;
  const saturation = radius ** WHEEL_GAMMA * 100;
  return {
    h: modifiers.alt ? current.h : hue,
    s: modifiers.ctrl ? current.s : saturation,
    v: current.v,
  };
}

/** The gradient stops of the saturation overlay, with white fading out toward the rim. */
export function wheelSaturationGradient(steps = 16): string {
  const stops: string[] = [];
  for (let index = 0; index <= steps; index++) {
    const fraction = index / steps;
    const alpha = 1 - fraction ** WHEEL_GAMMA;
    stops.push(`rgba(255,255,255,${alpha.toFixed(4)}) ${(fraction * 100).toFixed(2)}%`);
  }
  return `radial-gradient(circle closest-side, ${stops.join(", ")})`;
}

const HUE_STOPS =
  "red 0deg, yellow 60deg, lime 120deg, cyan 180deg, blue 240deg, magenta 300deg, red 360deg";

/** The hue wheel, drawn clockwise from the right (matches `wheelPosition`). */
export const WHEEL_HUE_BACKGROUND = `conic-gradient(from 90deg, ${HUE_STOPS})`;

/** A swatch's CSS background: the color over a checkerboard, so transparency shows. */
export function swatchBackground(color: Rgba): string {
  const fill = `rgba(${color.r},${color.g},${color.b},${(color.a / 255).toFixed(4)})`;
  return `linear-gradient(${fill}, ${fill}), var(--color-checkerboard)`;
}

export type SliderChannel = "r" | "g" | "b" | "h" | "s" | "v" | "a";

/**
 * The CSS background of a slider track. Each channel fades from its minimum to its maximum with
 * the other components of the color held (UI-FTW-06). The alpha track sits on a checkerboard.
 */
export function sliderBackground(channel: SliderChannel, color: Rgba): string {
  const hsv = rgbToHsv(color);
  const rgb = (value: Rgba) => `rgb(${value.r},${value.g},${value.b})`;
  switch (channel) {
    case "r":
      return `linear-gradient(to right, ${rgb({ ...color, r: 0 })}, ${rgb({ ...color, r: 255 })})`;
    case "g":
      return `linear-gradient(to right, ${rgb({ ...color, g: 0 })}, ${rgb({ ...color, g: 255 })})`;
    case "b":
      return `linear-gradient(to right, ${rgb({ ...color, b: 0 })}, ${rgb({ ...color, b: 255 })})`;
    case "h": {
      const stops = [0, 60, 120, 180, 240, 300, 360].map((h) =>
        rgb(hsvToRgb({ h, s: hsv.s, v: hsv.v })),
      );
      return `linear-gradient(to right, ${stops.join(", ")})`;
    }
    case "s":
      return `linear-gradient(to right, ${rgb(hsvToRgb({ h: hsv.h, s: 0, v: hsv.v }))}, ${rgb(
        hsvToRgb({ h: hsv.h, s: 100, v: hsv.v }),
      )})`;
    case "v":
      return `linear-gradient(to right, ${rgb(hsvToRgb({ h: hsv.h, s: hsv.s, v: 0 }))}, ${rgb(
        hsvToRgb({ h: hsv.h, s: hsv.s, v: 100 }),
      )})`;
    case "a":
      return `linear-gradient(to right, rgba(${color.r},${color.g},${color.b},0), ${rgb(color)}), var(--color-checkerboard)`;
  }
}
