/** DOC-DOC-03 resolution units. */
export type ResolutionUnit = "pixel" | "inch" | "centimeter";
export type PhysicalUnit = Exclude<ResolutionUnit, "pixel">;

export const CM_PER_INCH = 2.54;
export const DEFAULT_RESOLUTION_UNIT: ResolutionUnit = "inch";
export const DEFAULT_DPI = 96;
export const DEFAULT_DPCM = DEFAULT_DPI / CM_PER_INCH;
export const MIN_RESOLUTION = 0.01;
export const MAX_RESOLUTION = 65_536;

/** Dots per unit, stored separately for each axis. With the Pixel unit both are 1. */
export interface Resolution {
  readonly unit: ResolutionUnit;
  readonly x: number;
  readonly y: number;
}

export const DEFAULT_RESOLUTION: Resolution = Object.freeze({
  unit: DEFAULT_RESOLUTION_UNIT,
  x: DEFAULT_DPI,
  y: DEFAULT_DPI,
});

export function isValidResolution(r: Resolution): boolean {
  if (r.unit === "pixel") return r.x === 1 && r.y === 1;
  const inRange = (v: number) => v >= MIN_RESOLUTION && v <= MAX_RESOLUTION;
  return inRange(r.x) && inRange(r.y);
}

/**
 * Converts a dots-per-unit value between inch and centimeter. Pixel has no physical size, so
 * converting to it gives 1 and converting from it falls back to the default resolution.
 */
export function convertDotsPerUnit(
  value: number,
  from: ResolutionUnit,
  to: ResolutionUnit,
): number {
  if (to === "pixel") return 1;
  if (from === "pixel") return to === "inch" ? DEFAULT_DPI : DEFAULT_DPCM;
  if (from === to) return value;
  return from === "inch" ? value / CM_PER_INCH : value * CM_PER_INCH;
}

export function convertResolution(r: Resolution, unit: ResolutionUnit): Resolution {
  return {
    unit,
    x: convertDotsPerUnit(r.x, r.unit, unit),
    y: convertDotsPerUnit(r.y, r.unit, unit),
  };
}

/** Physical length (in the resolution's unit) of `pixels` at `dotsPerUnit`. */
export function pixelsToPhysical(pixels: number, dotsPerUnit: number): number {
  return pixels / dotsPerUnit;
}

export function physicalToPixels(length: number, dotsPerUnit: number): number {
  return length * dotsPerUnit;
}

/** Physical area of `pixelCount` pixels at the given resolution, in square units. */
export function pixelAreaToPhysical(pixelCount: number, r: Resolution): number {
  return pixelCount / (r.x * r.y);
}

export function convertLength(length: number, from: PhysicalUnit, to: PhysicalUnit): number {
  if (from === to) return length;
  return from === "inch" ? length * CM_PER_INCH : length / CM_PER_INCH;
}
