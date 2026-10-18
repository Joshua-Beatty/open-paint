import type { BrushOptions } from "../brush";
import type { CompositeCheckLayer, StrokeCheck } from "./gpu-checks";

/**
 * The cases of the v2 golden checks, shared by the engine's unit tests and the Chromium golden
 * harness (tests/golden).
 */

const BRUSH: BrushOptions = {
  size: 40,
  hardness: 0.5,
  spacing: 0.15,
  square: false,
  smooth: true,
  antialias: true,
  pressure: true,
  erase: false,
  blend: 0,
  hatch: 0,
  color: { r: 200, g: 40, b: 90, a: 180 },
  background: { r: 10, g: 220, b: 30, a: 255 },
};

/** A wavy path over several tiles with varying pressure, as flat `x, y, pressure` samples. */
function wavyPath(count: number): number[] {
  const path: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    path.push(20 + t * 560, 200 + Math.sin(t * 9) * 150, 0.3 + 0.7 * Math.abs(Math.cos(t * 5)));
  }
  return path;
}

/**
 * A figure eight across the tile boundary at x = 256 that crosses itself, then a small loop, as
 * flat `x, y, pressure` samples.
 */
function crossingPath(): number[] {
  const path: number[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = -Math.PI / 2 + (2 * Math.PI * i) / 60;
    path.push(260 + 200 * Math.sin(t), 180 + 120 * Math.sin(t) * Math.cos(t), 1);
  }
  for (let i = 1; i <= 30; i++) {
    const a = Math.PI / 2 - (2 * Math.PI * i) / 30;
    path.push(60 + i * 3 + 50 * Math.cos(a), 280 + 50 * Math.sin(a), 0.6 + 0.4 * (i / 30));
  }
  return path;
}

/** A soft-edged elliptical selection over the image, one byte per pixel. */
function ellipseMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot((x - width / 2) / (width * 0.35), (y - height / 2) / (height * 0.4));
      mask[y * width + x] = Math.max(0, Math.min(255, Math.round((1.1 - d) * 1275)));
    }
  }
  return mask;
}

const WIDTH = 600;
const HEIGHT = 400;

export const V2_STROKE_CASES: readonly (StrokeCheck & { readonly id: string })[] = [
  {
    id: "paint-normal",
    width: WIDTH,
    height: HEIGHT,
    options: BRUSH,
    path: wavyPath(40),
    batch: 3,
  },
  {
    id: "paint-empty-layer",
    width: WIDTH,
    height: HEIGHT,
    options: BRUSH,
    path: wavyPath(25),
    batch: 1,
    empty: true,
  },
  {
    id: "erase",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, erase: true, hardness: 0.9 },
    path: wavyPath(30),
    batch: 4,
  },
  {
    id: "overwrite-hatch",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, blend: 14, hatch: 6, size: 60 },
    path: wavyPath(20),
    batch: 2,
  },
  {
    id: "multiply-square-aliased-raw",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, blend: 1, square: true, antialias: false, smooth: false, pressure: false },
    path: wavyPath(30),
    batch: 5,
  },
  {
    id: "paint-selection",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 80 },
    path: wavyPath(30),
    batch: 3,
    mask: ellipseMask(WIDTH, HEIGHT),
  },
  {
    id: "feathered-batches-behind",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 120, hardness: 0 },
    path: wavyPath(40),
    batch: 2,
    perFrame: 3,
  },
  {
    id: "feathered-square",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 50, hardness: 0, square: true },
    path: wavyPath(30),
    batch: 3,
  },
  {
    id: "spaced-dabs",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 30, spacing: 1.5 },
    path: wavyPath(30),
    batch: 2,
    perFrame: 2,
  },
  {
    id: "crossing-itself",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 70, hardness: 0.3 },
    path: crossingPath(),
    batch: 2,
    perFrame: 3,
  },
];

/** Whole strokes for the engine v1 `GpuBrush`, against the Rust reference. */
export const V1_BRUSH_CASES: readonly (StrokeCheck & { readonly id: string })[] = [
  { id: "default", width: WIDTH, height: HEIGHT, options: BRUSH, path: wavyPath(40), batch: 1 },
  {
    id: "feathered",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 120, hardness: 0 },
    path: wavyPath(40),
    batch: 1,
  },
  {
    id: "hard-square-aliased",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 30, hardness: 1, square: true, antialias: false },
    path: wavyPath(30),
    batch: 1,
  },
  {
    id: "soft-square-erase",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 40, hardness: 0.2, square: true, erase: true },
    path: wavyPath(30),
    batch: 1,
  },
  {
    id: "feathered-empty-layer",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 90, hardness: 0.3 },
    path: wavyPath(40),
    batch: 1,
    empty: true,
  },
  {
    id: "spaced-overwrite",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 30, spacing: 1.5, blend: 14 },
    path: wavyPath(30),
    batch: 1,
  },
  {
    id: "crossing-itself",
    width: WIDTH,
    height: HEIGHT,
    options: { ...BRUSH, size: 70, hardness: 0.3 },
    path: crossingPath(),
    batch: 1,
  },
];

export const V2_COMPOSITE_CASES: readonly {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly layers: readonly CompositeCheckLayer[];
  readonly pageSlices?: number;
}[] = [
  {
    id: "every-mode",
    width: 300,
    height: 200,
    layers: [
      { mode: 0, opacity: 255 },
      ...Array.from({ length: 13 }, (_, i) => ({
        mode: i + 1,
        opacity: [255, 128, 1][i % 3] ?? 255,
      })),
    ],
  },
  {
    id: "sparse-hidden-chunked",
    width: 700,
    height: 520,
    layers: [
      { mode: 0, opacity: 255, area: { x: 0, y: 0, width: 700, height: 520 } },
      { mode: 2, opacity: 200, area: { x: 260, y: 10, width: 300, height: 200 } },
      { mode: 7, opacity: 255, visible: false },
      { mode: 10, opacity: 90, area: { x: 0, y: 300, width: 520, height: 220 } },
      { mode: 8, opacity: 255, area: { x: 500, y: 0, width: 200, height: 520 } },
    ],
    pageSlices: 2,
  },
];
