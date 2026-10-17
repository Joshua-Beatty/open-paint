import type {
  CloudsParams,
  JuliaParams,
  MandelbrotParams,
  TurbulenceParams,
} from "@openpaint/effects";
import { BLUR_INPUT_SIZE } from "./cases";

/**
 * Clouds cases (FX-RENDER-CLOUDS-01). Each runs the WGSL in Chromium and compares it with the Rust
 * reference, which the page runs too, so no fixture is stored. The document is the 40 x 24 input,
 * except where a case puts the region inside a larger document.
 */
export interface CloudsCase {
  readonly id: string;
  readonly params: CloudsParams;
}

const COLOR_FULL_RED = { r: 1, g: 0.1, b: 0.1, a: 1 };
const COLOR_HALF_BLUE = { r: 0.1, g: 0.3, b: 1, a: 0.5 };

export const CLOUDS_CASES: readonly CloudsCase[] = [
  {
    id: "clouds-over-default",
    params: {
      scale: 250,
      roughness: 0.5,
      mode: 0,
      seed: 0,
      color1: { r: 0, g: 0, b: 0, a: 1 },
      color2: { r: 1, g: 1, b: 1, a: 1 },
      origin: { x: 0, y: 0 },
      document: { ...BLUR_INPUT_SIZE },
    },
  },
  {
    id: "clouds-multiply-colors",
    params: {
      scale: 37,
      roughness: 0.8,
      mode: 3,
      seed: 201,
      color1: COLOR_FULL_RED,
      color2: COLOR_HALF_BLUE,
      origin: { x: 0, y: 0 },
      document: { ...BLUR_INPUT_SIZE },
    },
  },
  {
    id: "clouds-overlay-region",
    params: {
      scale: 60,
      roughness: 0.3,
      mode: 14,
      seed: 88,
      color1: COLOR_HALF_BLUE,
      color2: COLOR_FULL_RED,
      origin: { x: 90, y: 40 },
      document: { width: 160, height: 120 },
    },
  },
  {
    id: "clouds-xor16",
    params: {
      scale: 2,
      roughness: 1,
      mode: 44,
      seed: 17,
      color1: COLOR_HALF_BLUE,
      color2: COLOR_FULL_RED,
      origin: { x: 0, y: 0 },
      document: { ...BLUR_INPUT_SIZE },
    },
  },
  {
    id: "clouds-hue",
    params: {
      scale: 120,
      roughness: 0.6,
      mode: 23,
      seed: 3,
      color1: COLOR_FULL_RED,
      color2: { r: 0.2, g: 0.9, b: 0.4, a: 1 },
      origin: { x: 0, y: 0 },
      document: { ...BLUR_INPUT_SIZE },
    },
  },
];

/** Julia cases (FX-RENDER-JULIA-01), compared the same way as the Clouds cases. */
export interface JuliaCase {
  readonly id: string;
  readonly params: JuliaParams;
}

export const JULIA_CASES: readonly JuliaCase[] = [
  {
    id: "julia-overwrite-default",
    params: {
      factor: 4,
      zoom: 1,
      angle: 0,
      quality: 1,
      mode: 2,
      origin: undefined,
      document: undefined,
    },
  },
  {
    id: "julia-multiply-rotated-quality",
    params: {
      factor: 2.5,
      zoom: 0.6,
      angle: 40,
      quality: 3,
      mode: 3,
      origin: { x: 0, y: 0 },
      document: { ...BLUR_INPUT_SIZE },
    },
  },
  {
    id: "julia-screen-region",
    params: {
      factor: 6,
      zoom: 1.5,
      angle: -120,
      quality: 2,
      mode: 4,
      origin: { x: 90, y: 40 },
      document: { width: 160, height: 120 },
    },
  },
];

/** Mandelbrot cases (FX-RENDER-MANDEL-01), compared the same way as the Clouds cases. */
export interface MandelbrotCase {
  readonly id: string;
  readonly params: MandelbrotParams;
}

export const MANDELBROT_CASES: readonly MandelbrotCase[] = [
  {
    id: "mandelbrot-overwrite-default",
    params: {
      factor: 1,
      zoom: 10,
      angle: 0,
      quality: 1,
      mode: 2,
      invert: false,
      origin: undefined,
      document: undefined,
    },
  },
  {
    id: "mandelbrot-invert-overlay-region",
    params: {
      factor: 2,
      zoom: 1,
      angle: 30,
      quality: 2,
      mode: 14,
      invert: true,
      origin: { x: 90, y: 40 },
      document: { width: 160, height: 120 },
    },
  },
  {
    id: "mandelbrot-xor16-deep",
    params: {
      factor: 5,
      zoom: 0.5,
      angle: 0,
      quality: 4,
      mode: 44,
      invert: false,
      origin: { x: 0, y: 0 },
      document: { ...BLUR_INPUT_SIZE },
    },
  },
];

/** Turbulence cases (FX-RENDER-TURB-01), compared the same way as the Clouds cases. */
export interface TurbulenceCase {
  readonly id: string;
  readonly params: TurbulenceParams;
}

export const TURBULENCE_CASES: readonly TurbulenceCase[] = [
  {
    id: "turbulence-over-default",
    params: {
      octaves: 4,
      period: 100,
      tile: 4096,
      fractal: false,
      seed: 1,
      mode: 0,
      origin: undefined,
    },
  },
  {
    id: "turbulence-fractal-screen",
    params: {
      octaves: 6,
      period: 9,
      tile: 64,
      fractal: true,
      seed: 55,
      mode: 4,
      origin: { x: 13, y: 7 },
    },
  },
  {
    id: "turbulence-linear-light-region",
    params: {
      octaves: 3,
      period: 40,
      tile: 128,
      fractal: false,
      seed: 200,
      mode: 18,
      origin: { x: 300, y: 260 },
    },
  },
  {
    id: "turbulence-dissolve",
    params: {
      octaves: 2,
      period: 0.5,
      tile: 16,
      fractal: true,
      seed: 9,
      mode: 7,
      origin: undefined,
    },
  },
];
