/**
 * Golden cases. Each case names one kernel invocation and the stored reference PNG its output
 * must match. Paths are relative to `tests/golden`: the Node runner resolves them from disk, the
 * browser runner fetches them from the Vite server.
 */

import type {
  AddNoiseParams,
  AlignObjectParams,
  BokehBlurParams,
  DropShadowParams,
  EdgeDetectParams,
  EmbossParams,
  FragmentBlurParams,
  FrostedGlassParams,
  GlowParams,
  InkSketchParams,
  MedianBlurParams,
  MorphologyParams,
  MotionBlurParams,
  OilPaintingParams,
  OutlineParams,
  PencilSketchParams,
  PixelateParams,
  RadialBlurParams,
  RedEyeParams,
  ReduceNoiseParams,
  ReliefParams,
  RotateZoomParams,
  SharpenParams,
  SketchBlurParams,
  SoftenPortraitParams,
  SquareBlurParams,
  StraightenParams,
  SurfaceBlurParams,
  VignetteParams,
  ZoomBlurParams,
} from "@openpaint/effects";

/**
 * Layer blend modes in DOC-BLD-01 order: the array index is the stored mode value (0-13). Keep
 * this in sync with `BlendMode` in `crates/opaint-cpu/src/blend.rs`.
 */
export const BLEND_MODE_NAMES = [
  "normal",
  "multiply",
  "additive",
  "color-burn",
  "color-dodge",
  "reflect",
  "glow",
  "overlay",
  "difference",
  "negation",
  "lighten",
  "darken",
  "screen",
  "xor",
] as const;

/** Layer opacities 0-255 per mode: full, half, and nearly transparent (the sa > 0 edge case). */
export const BLEND_OPACITIES = [255, 128, 1] as const;

/** Edge length of the input and reference images, in pixels. */
export const BLEND_SIZE = 32;

export const BLEND_INPUTS = {
  dst: "fixtures/blend/dst.png",
  src: "fixtures/blend/src.png",
} as const;

export interface BlendCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  /** DOC-BLD-01 mode value. */
  readonly mode: number;
  readonly modeName: string;
  readonly opacity: number;
  /** Reference PNG holding the expected composite. */
  readonly expected: string;
}

/** Gaussian Blur input: non-square and not a multiple of the 8x8 GPU workgroup, to exercise edges. */
export const BLUR_INPUT = "fixtures/blur/input.png";
export const BLUR_INPUT_SIZE = { width: 40, height: 24 } as const;

export interface BlurCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  /** FX-BLUR-GAUSS-02 Radius. */
  readonly radius: number;
  /** FX-BLUR-GAUSS-02 Gamma Boost. */
  readonly gammaBoost: number;
  /** FX-BLUR-GAUSS-02 Quality, 1-4. */
  readonly quality: number;
  /** Reference PNG holding the expected blur. */
  readonly expected: string;
}

/**
 * Parameter sets: pass-through, each quality level, both gamma directions, and the downsampled
 * paths of quality 1-3 (σ above each level's threshold).
 */
export const BLUR_CASES: readonly BlurCase[] = [
  { id: "blur-passthrough", radius: 0, gammaBoost: 0, quality: 4 },
  { id: "blur-r2-q3", radius: 2, gammaBoost: 0, quality: 3 },
  { id: "blur-r12-q4", radius: 12, gammaBoost: 0, quality: 4 },
  { id: "blur-r12-q4-posboost", radius: 12, gammaBoost: 1.5, quality: 4 },
  { id: "blur-r12-q4-negboost", radius: 12, gammaBoost: -0.5, quality: 4 },
  { id: "blur-r60-q1-down4", radius: 60, gammaBoost: 0.25, quality: 1 },
  { id: "blur-r120-q2-down2", radius: 120, gammaBoost: 0, quality: 2 },
  { id: "blur-r200-q3-down2", radius: 200, gammaBoost: -0.99, quality: 3 },
  { id: "blur-r300-q4-maxboost", radius: 300, gammaBoost: 2, quality: 4 },
].map((kase) => ({ ...kase, expected: `fixtures/blur/${kase.id}.png` }));

/**
 * Distortion engine cases (FX-A-00-04) on `BLUR_INPUT`: an affine sample map `[a, b, c, d, e, f]`
 * (x' = a x + c y + e, y' = b x + d y + f) at one Quality and edge mode.
 */
export interface DistortCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly matrix: readonly number[];
  /** Quality 1-8: quality² rotated-grid samples per pixel. */
  readonly quality: number;
  readonly edge: "clamp" | "wrap" | "reflect" | "transparent";
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const DISTORT_SHAPES: readonly Omit<DistortCase, "expected">[] = [
  { id: "distort-identity-q1-clamp", matrix: [1, 0, 0, 1, 0, 0], quality: 1, edge: "clamp" },
  {
    id: "distort-rotate-q1-wrap",
    matrix: [0.8660254, 0.5, -0.5, 0.8660254, 5, -3],
    quality: 1,
    edge: "wrap",
  },
  {
    id: "distort-rotate-q3-reflect",
    matrix: [0.8660254, 0.5, -0.5, 0.8660254, 5, -3],
    quality: 3,
    edge: "reflect",
  },
  {
    id: "distort-scale-q2-transparent",
    matrix: [1.25, 0, 0, 0.8, -4, 2],
    quality: 2,
    edge: "transparent",
  },
  { id: "distort-shear-q8-clamp", matrix: [1, 0.3, 0.2, 1, 0, 0], quality: 8, edge: "clamp" },
  { id: "distort-shift-q4-reflect", matrix: [1, 0, 0, 1, -1.5, 0.5], quality: 4, edge: "reflect" },
];

export const DISTORT_CASES: readonly DistortCase[] = DISTORT_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/distort/${kase.id}.png`,
}));

/**
 * Per-pixel noise cases (FX-A-00-05), each a seed over `BLUR_INPUT_SIZE`. The stored image is the
 * generator's RGB output, opaque.
 */
export interface NoiseCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly seed: number;
  /** Reference PNG holding the expected noise. */
  readonly expected: string;
}

export const NOISE_CASES: readonly NoiseCase[] = [
  { id: "noise-seed-0", seed: 0 },
  { id: "noise-seed-1", seed: 1 },
  { id: "noise-seed-deadbeef", seed: 0xdead_beef },
].map((kase) => ({ ...kase, expected: `fixtures/noise/${kase.id}.png` }));

/** A case's fields without `expected`, which the list adds. */
type WithoutExpected<T> = T extends unknown ? Omit<T, "expected"> : never;

interface WarpCaseBase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  /** Quality 1-8: quality² rotated-grid samples per pixel. */
  readonly quality: number;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

/** Bulge (FX-DIST-BULGE) on `BLUR_INPUT`, with its own Bulge, Center and edge mode. */
export interface BulgeCase extends WarpCaseBase {
  readonly kind: "bulge";
  /** FX-DIST-BULGE-02 Bulge: above 0 swells, below 0 pinches. */
  readonly bulge: number;
  /** FX-DIST-BULGE-02 Center, as (x, y) in half-selection units. */
  readonly center: readonly [number, number];
  readonly edge: "clamp" | "wrap" | "reflect" | "transparent";
}

/** Twist (FX-DIST-TWIST) on `BLUR_INPUT`. Twist always uses the Clamp edge mode. */
export interface TwistCase extends WarpCaseBase {
  readonly kind: "twist";
  /** FX-DIST-TWIST-02 Amount / Direction. */
  readonly amount: number;
  /** FX-DIST-TWIST-02 Size. */
  readonly size: number;
  /** FX-DIST-TWIST-02 Center, as (x, y) in half-selection units. */
  readonly center: readonly [number, number];
  /** The document size that scales the Size (FX-DIST-TWIST-03). Differs from the input here. */
  readonly document: { readonly width: number; readonly height: number };
}

/** Crystalize (FX-DIST-CRYSTAL) on `BLUR_INPUT`. Its edge mode is Clamp. */
export interface CrystalizeCase extends WarpCaseBase {
  readonly kind: "crystalize";
  /** FX-DIST-CRYSTAL-02 Cell Size, in pixels. */
  readonly cellSize: number;
  /** FX-A-00-05 user Seed, 0-255. */
  readonly userSeed: number;
  /** FX-A-00-05 instance seed. Only its low 8 bits are used. */
  readonly instanceSeed: number;
}

/** Dents (FX-DIST-DENTS) on `BLUR_INPUT`. Its edge mode is Reflect. */
export interface DentsCase extends WarpCaseBase {
  readonly kind: "dents";
  /** FX-DIST-DENTS-02 Scale, Refraction, Detail, Turbulence and Angle. */
  readonly scale: number;
  readonly refraction: number;
  readonly detail: number;
  readonly turbulence: number;
  readonly angle: number;
  /** FX-A-00-05 user Seed, 0-255. */
  readonly userSeed: number;
  /** FX-A-00-05 instance seed. Only its low 8 bits are used. */
  readonly instanceSeed: number;
}

/** Polar Inversion (FX-DIST-POLAR) on `BLUR_INPUT`, with its own edge mode. */
export interface PolarCase extends WarpCaseBase {
  readonly kind: "polar";
  /** FX-DIST-POLAR-02 Scale, the blend amount of the inversion. */
  readonly scale: number;
  /** FX-DIST-POLAR-02 Offset, as (x, y) in half-selection units. */
  readonly offset: readonly [number, number];
  readonly edge: "clamp" | "wrap" | "reflect" | "transparent";
  /** The document size that scales the Scale (FX-DIST-POLAR-03). */
  readonly document: { readonly width: number; readonly height: number };
}

/**
 * Tile Reflection (FX-DIST-TILE) on `BLUR_INPUT`. The input is the region at `origin` in a layer of
 * `document` size, and the mirrored wall is centered on that layer (FX-DIST-TILE-03).
 */
export interface TileCase extends WarpCaseBase {
  readonly kind: "tile";
  /** FX-DIST-TILE-02 Angle, in degrees. */
  readonly angle: number;
  /** FX-DIST-TILE-02 Tile Size, in pixels. */
  readonly tileSize: number;
  /** FX-DIST-TILE-02 Curvature. */
  readonly curvature: number;
  readonly edge: "clamp" | "wrap" | "reflect" | "transparent";
  /** The size of the layer that the mirrored wall is centered on. */
  readonly document: { readonly width: number; readonly height: number };
  /** Where the input sits in the layer, in pixels. */
  readonly origin: readonly [number, number];
}

export type WarpCase = BulgeCase | TwistCase | PolarCase | TileCase | CrystalizeCase | DentsCase;

/**
 * Bulge and Twist parameter sets: a swell, a strong pinch that reads outside the image, and the
 * largest Bulge. Twist runs at a few Qualities, with a document larger than the input and one the
 * same size as it.
 */
export const WARP_CASES: readonly WarpCase[] = (
  [
    {
      id: "bulge-swell-q1-clamp",
      kind: "bulge",
      quality: 1,
      bulge: 0.45,
      center: [0, 0],
      edge: "clamp",
    },
    {
      id: "bulge-pinch-q3-transparent",
      kind: "bulge",
      quality: 3,
      bulge: -1.5,
      center: [0.3, -0.2],
      edge: "transparent",
    },
    {
      id: "bulge-extreme-q8-wrap",
      kind: "bulge",
      quality: 8,
      bulge: -3,
      center: [-0.5, 0.25],
      edge: "wrap",
    },
    {
      id: "twist-clockwise-q1",
      kind: "twist",
      quality: 1,
      amount: 30,
      size: 1,
      center: [0, 0],
      document: { width: 80, height: 60 },
    },
    {
      id: "twist-counter-q2",
      kind: "twist",
      quality: 2,
      amount: -120,
      size: 0.5,
      center: [0.4, -0.3],
      document: { width: 80, height: 60 },
    },
    {
      id: "twist-strong-q4-document-size",
      kind: "twist",
      quality: 4,
      amount: 200,
      size: 2,
      center: [-1, 1],
      document: { width: 40, height: 24 },
    },
    {
      id: "crystalize-cell8-q1",
      kind: "crystalize",
      quality: 1,
      cellSize: 8,
      userSeed: 0,
      instanceSeed: 0x1234_5678,
    },
    {
      id: "crystalize-cell5-q3-seed7",
      kind: "crystalize",
      quality: 3,
      cellSize: 5,
      userSeed: 7,
      instanceSeed: 0xdead_beef,
    },
    {
      id: "crystalize-cell20-q5-seed255",
      kind: "crystalize",
      quality: 5,
      cellSize: 20,
      userSeed: 255,
      instanceSeed: 1,
    },
    {
      id: "dents-default-q1",
      kind: "dents",
      quality: 1,
      scale: 25,
      refraction: 50,
      detail: 10,
      turbulence: 10,
      angle: 0,
      userSeed: 0,
      instanceSeed: 0,
    },
    {
      id: "dents-angled-q2",
      kind: "dents",
      quality: 2,
      scale: 12,
      refraction: 80,
      detail: 40,
      turbulence: 30,
      angle: 35,
      userSeed: 9,
      instanceSeed: 200,
    },
    {
      id: "dents-strong-q3-seed255",
      kind: "dents",
      quality: 3,
      scale: 60,
      refraction: 150,
      detail: 90,
      turbulence: 70,
      angle: -120,
      userSeed: 255,
      instanceSeed: 77,
    },
    {
      id: "polar-inverse-q1-reflect",
      kind: "polar",
      quality: 1,
      scale: 1,
      offset: [0, 0],
      edge: "reflect",
      document: { width: 40, height: 24 },
    },
    {
      id: "polar-partial-offset-q3-transparent",
      kind: "polar",
      quality: 3,
      scale: -0.5,
      offset: [0.4, -0.3],
      edge: "transparent",
      document: { width: 80, height: 60 },
    },
    {
      id: "polar-strong-q2-wrap",
      kind: "polar",
      quality: 2,
      scale: 3.5,
      offset: [-1, 1],
      edge: "wrap",
      document: { width: 40, height: 24 },
    },
    {
      id: "tile-diagonal-q1-reflect",
      kind: "tile",
      quality: 1,
      angle: 45,
      tileSize: 40,
      curvature: 8,
      edge: "reflect",
      document: { width: 40, height: 24 },
      origin: [0, 0],
    },
    {
      id: "tile-curved-q3-clamp-offset-region",
      kind: "tile",
      quality: 3,
      angle: -60,
      tileSize: 9,
      curvature: -40,
      edge: "clamp",
      document: { width: 64, height: 48 },
      origin: [10, 4],
    },
    {
      id: "tile-narrow-q2-transparent",
      kind: "tile",
      quality: 2,
      angle: 75,
      tileSize: 15,
      curvature: 30,
      edge: "transparent",
      document: { width: 40, height: 24 },
      origin: [0, 0],
    },
    {
      // Many tangent poles per row: the samples that land next to one are where an approximate GPU
      // tangent picked another tile.
      id: "tile-poles-q4-wrap",
      kind: "tile",
      quality: 4,
      angle: 10,
      tileSize: 3,
      curvature: 120,
      edge: "wrap",
      document: { width: 40, height: 24 },
      origin: [0, 0],
    },
  ] as const satisfies readonly WithoutExpected<WarpCase>[]
).map((kase) => ({ ...kase, expected: `fixtures/warp/${kase.id}.png` }));

/**
 * Frosted Glass (FX-DIST-FROST) on `BLUR_INPUT`, with the parameters the binding reads, including
 * the instance seed (FX-A-00-05).
 */
export interface FrostCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: FrostedGlassParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const FROST_SHAPES: readonly Omit<FrostCase, "expected">[] = [
  {
    id: "frost-default-smooth2",
    params: {
      maximumRadius: 3,
      minimumRadius: 0,
      diffusion: 1,
      smoothness: 2,
      userSeed: 0,
      instanceSeed: 0x1234_5678,
    },
  },
  {
    id: "frost-band-diffusion-half-smooth8",
    params: {
      maximumRadius: 6,
      minimumRadius: 2,
      diffusion: 0.5,
      smoothness: 8,
      userSeed: 9,
      instanceSeed: 0xdead_beef,
    },
  },
  {
    id: "frost-diffusion3-smooth1",
    params: {
      maximumRadius: 12,
      minimumRadius: 4,
      diffusion: 3,
      smoothness: 1,
      userSeed: 255,
      instanceSeed: 77,
    },
  },
];

export const FROST_CASES: readonly FrostCase[] = FROST_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/frost/${kase.id}.png`,
}));

/**
 * Pixelate (FX-DIST-PIXELATE) on `BLUR_INPUT`: the cell grid, the anchor and both interpolations.
 * The first case is one-pixel cells, which return the input.
 */
export interface PixelateCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: PixelateParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const PIXELATE_SHAPES: readonly Omit<PixelateCase, "expected">[] = [
  {
    id: "pixelate-cell1-identity",
    params: {
      cellSize: 1,
      anchor: { x: 0, y: 0 },
      scaleDown: "nearestNeighbor",
      scaleUp: "nearestNeighbor",
    },
  },
  {
    id: "pixelate-cell2-default",
    params: {
      cellSize: 2,
      anchor: { x: 0, y: 0 },
      scaleDown: "multisampleBilinear",
      scaleUp: "nearestNeighbor",
    },
  },
  {
    id: "pixelate-cell5-anchored-bilinear",
    params: {
      cellSize: 5,
      anchor: { x: 0.3, y: -0.2 },
      scaleDown: "bilinear",
      scaleUp: "bilinear",
    },
  },
  {
    id: "pixelate-cell4-anisotropic-bicubic",
    params: {
      cellSize: 4,
      anchor: { x: -0.5, y: 0.5 },
      scaleDown: "anisotropic",
      scaleUp: "bicubic",
    },
  },
  {
    id: "pixelate-cell6-high-quality-bicubic",
    params: {
      cellSize: 6,
      anchor: { x: 1, y: -1 },
      scaleDown: "bicubicHighQuality",
      scaleUp: "bicubic",
    },
  },
  {
    id: "pixelate-cell13-bicubic-nearest",
    params: {
      cellSize: 13,
      anchor: { x: 0, y: 0 },
      scaleDown: "bicubic",
      scaleUp: "nearestNeighbor",
    },
  },
];

export const PIXELATE_CASES: readonly PixelateCase[] = PIXELATE_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/pixelate/${kase.id}.png`,
}));

/**
 * Morphology (FX-DIST-MORPH) on `BLUR_INPUT`: both modes, square and narrow kernels, and a kernel
 * wider than the image, which is the Clamp edge at both sides.
 */
export interface MorphologyCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: MorphologyParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const MORPHOLOGY_SHAPES: readonly Omit<MorphologyCase, "expected">[] = [
  {
    id: "morphology-dilate-5x5-default",
    params: { width: 5, height: 5, mode: "dilate" },
  },
  {
    id: "morphology-erode-5x5",
    params: { width: 5, height: 5, mode: "erode" },
  },
  {
    id: "morphology-dilate-1x7-narrow",
    params: { width: 1, height: 7, mode: "dilate" },
  },
  {
    id: "morphology-erode-12x3",
    params: { width: 12, height: 3, mode: "erode" },
  },
  {
    id: "morphology-dilate-37x9-wide",
    params: { width: 37, height: 9, mode: "dilate" },
  },
];

export const MORPHOLOGY_CASES: readonly MorphologyCase[] = MORPHOLOGY_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/morphology/${kase.id}.png`,
}));

/**
 * Fragment Blur (FX-BLUR-FRAG) on `BLUR_INPUT`: the default, a dense rotated ring, two copies, and a
 * zero distance, which only averages the pixel with itself.
 */
export interface FragmentBlurCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: FragmentBlurParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const FRAGMENT_SHAPES: readonly Omit<FragmentBlurCase, "expected">[] = [
  {
    id: "fragment-default",
    params: { count: 4, distance: 8, rotation: 0 },
  },
  {
    id: "fragment-dense-rotated",
    params: { count: 13, distance: 37, rotation: 200 },
  },
  {
    id: "fragment-two-copies",
    params: { count: 2, distance: 6.5, rotation: 90 },
  },
  {
    id: "fragment-zero-distance",
    params: { count: 7, distance: 0, rotation: 45 },
  },
];

export const FRAGMENT_CASES: readonly FragmentBlurCase[] = FRAGMENT_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/fragment-blur/${kase.id}.png`,
}));

/**
 * Motion Blur (FX-BLUR-MOTION) on `BLUR_INPUT`: the default centered path, a trailing path with the
 * Wrap edge, a long path with the Reflect edge, and a trailing path with the Transparent edge.
 */
export interface MotionBlurCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: MotionBlurParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const MOTION_SHAPES: readonly Omit<MotionBlurCase, "expected">[] = [
  {
    id: "motion-default",
    params: { angle: 25, distance: 10, centered: true, edge: "clamp" },
  },
  {
    id: "motion-trailing-wrap",
    params: { angle: -60, distance: 23.5, centered: false, edge: "wrap" },
  },
  {
    id: "motion-long-reflect",
    params: { angle: 135, distance: 90, centered: true, edge: "reflect" },
  },
  {
    id: "motion-transparent-up",
    params: { angle: 90, distance: 31, centered: false, edge: "transparent" },
  },
];

export const MOTION_CASES: readonly MotionBlurCase[] = MOTION_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/motion-blur/${kase.id}.png`,
}));

/**
 * Radial Blur (FX-BLUR-RADIAL) on `BLUR_INPUT`: the default, an off-center wide arc, a decimal
 * Quality, and a region inside a larger document, which moves the center to the layer's center.
 */
export interface RadialBlurCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: RadialBlurParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const RADIAL_SHAPES: readonly Omit<RadialBlurCase, "expected">[] = [
  {
    id: "radial-default",
    params: {
      angle: 4,
      center: { x: 0, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    },
  },
  {
    id: "radial-wide-offset",
    params: {
      angle: 120,
      center: { x: 0.5, y: -0.25 },
      quality: 1.5,
      document: undefined,
      regionOrigin: undefined,
    },
  },
  {
    id: "radial-region-of-document",
    params: {
      angle: 60,
      center: { x: -0.5, y: 0.5 },
      quality: 1,
      document: { width: 80, height: 48 },
      regionOrigin: { x: 20, y: 12 },
    },
  },
];

export const RADIAL_CASES: readonly RadialBlurCase[] = RADIAL_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/radial-blur/${kase.id}.png`,
}));

/**
 * Zoom Blur (FX-BLUR-ZOOM) on `BLUR_INPUT`: the default zoom in, a zoom out with a high Focus, a
 * unit distance that passes the image through, and an off-center zoom in a larger document.
 */
export interface ZoomBlurCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: ZoomBlurParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const ZOOM_SHAPES: readonly Omit<ZoomBlurCase, "expected">[] = [
  {
    id: "zoom-default",
    params: {
      distance: 1.25,
      focus: 2,
      center: { x: 0, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    },
  },
  {
    id: "zoom-out-sharp-focus",
    params: {
      distance: 0.5,
      focus: 4,
      center: { x: 0.25, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    },
  },
  {
    id: "zoom-unit-distance",
    params: {
      distance: 1,
      focus: 2,
      center: { x: 0, y: 0 },
      quality: 1,
      document: undefined,
      regionOrigin: undefined,
    },
  },
  {
    id: "zoom-region-of-document",
    params: {
      distance: 2.5,
      focus: 1,
      center: { x: -0.4, y: -0.6 },
      quality: 1.5,
      document: { width: 80, height: 48 },
      regionOrigin: { x: 20, y: 12 },
    },
  },
];

export const ZOOM_CASES: readonly ZoomBlurCase[] = ZOOM_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/zoom-blur/${kase.id}.png`,
}));

/**
 * Median Blur (FX-BLUR-MEDIAN) on `BLUR_INPUT`: the median, an erode and a dilate at a low Quality,
 * and radius 0, which passes the image through.
 */
export interface MedianBlurCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: MedianBlurParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const MEDIAN_SHAPES: readonly Omit<MedianBlurCase, "expected">[] = [
  { id: "median-default", params: { radius: 10, percentile: 50, quality: 8 } },
  { id: "median-erode", params: { radius: 3, percentile: 10, quality: 6 } },
  { id: "median-dilate-low-quality", params: { radius: 6, percentile: 90, quality: 4 } },
  { id: "median-radius-zero", params: { radius: 0, percentile: 50, quality: 1 } },
];

export const MEDIAN_CASES: readonly MedianBlurCase[] = MEDIAN_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/median-blur/${kase.id}.png`,
}));

/**
 * Add Noise (FX-NOISE-ADD) on `BLUR_INPUT`: the default, a strong desaturated pass whose seeds XOR, and a
 * partial-coverage pass at full saturation.
 */
export interface AddNoiseCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: AddNoiseParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const ADD_NOISE_SHAPES: readonly Omit<AddNoiseCase, "expected">[] = [
  {
    id: "add-noise-default",
    params: { intensity: 64, colorSaturation: 100, coverage: 100, userSeed: 0, instanceSeed: 0 },
  },
  {
    id: "add-noise-strong-desaturated",
    params: {
      intensity: 100,
      colorSaturation: 0,
      coverage: 100,
      userSeed: 1,
      instanceSeed: 0x1234,
    },
  },
  {
    id: "add-noise-partial-boosted",
    params: { intensity: 40, colorSaturation: 250, coverage: 35, userSeed: 0xff, instanceSeed: 0 },
  },
];

export const ADD_NOISE_CASES: readonly AddNoiseCase[] = ADD_NOISE_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/add-noise/${kase.id}.png`,
}));

/**
 * Reduce Noise (FX-NOISE-REDUCE) on `BLUR_INPUT`: the default, a wide disc at full strength, and radius 0,
 * which passes the image through.
 */
export interface ReduceNoiseCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: ReduceNoiseParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const REDUCE_NOISE_SHAPES: readonly Omit<ReduceNoiseCase, "expected">[] = [
  { id: "reduce-noise-default", params: { radius: 10, strength: 0.4 } },
  { id: "reduce-noise-wide-full", params: { radius: 25, strength: 1 } },
  { id: "reduce-noise-radius-zero", params: { radius: 0, strength: 0.6 } },
];

export const REDUCE_NOISE_CASES: readonly ReduceNoiseCase[] = REDUCE_NOISE_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/reduce-noise/${kase.id}.png`,
}));

/**
 * Surface Blur (FX-BLUR-SURFACE) on `BLUR_INPUT`: the default, a wide soft blur, and a narrow sharp
 * one that keeps most of the detail.
 */
export interface SurfaceBlurCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: SurfaceBlurParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const SURFACE_SHAPES: readonly Omit<SurfaceBlurCase, "expected">[] = [
  { id: "surface-default", params: { radius: 6, threshold: 15 } },
  { id: "surface-wide-soft", params: { radius: 12, threshold: 60 } },
  { id: "surface-narrow-sharp", params: { radius: 2, threshold: 3 } },
];

export const SURFACE_CASES: readonly SurfaceBlurCase[] = SURFACE_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/surface-blur/${kase.id}.png`,
}));

/**
 * Square Blur (FX-BLUR-SQUARE) on `BLUR_INPUT`: the default, a fractional radius with a boost, and a wide
 * box with a dark gamma.
 */
export interface SquareBlurCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: SquareBlurParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const SQUARE_SHAPES: readonly Omit<SquareBlurCase, "expected">[] = [
  { id: "square-default", params: { radius: 6, gammaBoost: 0 } },
  { id: "square-fractional-boost", params: { radius: 2.5, gammaBoost: 1.2 } },
  { id: "square-wide-dark", params: { radius: 20, gammaBoost: -0.5 } },
];

export const SQUARE_CASES: readonly SquareBlurCase[] = SQUARE_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/square-blur/${kase.id}.png`,
}));

/**
 * Sketch Blur (FX-BLUR-SKETCH) on `BLUR_INPUT`: the default, a narrow low percentile, a wide high
 * percentile with more iterations, and a zero radius, which leaves the image unchanged.
 */
export interface SketchBlurCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: SketchBlurParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const SKETCH_SHAPES: readonly Omit<SketchBlurCase, "expected">[] = [
  { id: "sketch-default", params: { radius: 25, percentile: 50, smoothness: 3 } },
  { id: "sketch-narrow-low", params: { radius: 4, percentile: 20, smoothness: 2 } },
  { id: "sketch-wide-high", params: { radius: 60, percentile: 85, smoothness: 6 } },
  { id: "sketch-radius-zero", params: { radius: 0, percentile: 50, smoothness: 1 } },
];

export const SKETCH_CASES: readonly SketchBlurCase[] = SKETCH_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/sketch-blur/${kase.id}.png`,
}));

/**
 * Bokeh Blur (FX-BLUR-BOKEH) on `BLUR_INPUT`: the default disc, a small disc at the highest quality with a
 * boost, a wide disc at the lowest quality with a dark gamma, and a radius below 1 that passes through.
 */
export interface BokehBlurCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: BokehBlurParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const BOKEH_SHAPES: readonly Omit<BokehBlurCase, "expected">[] = [
  { id: "bokeh-default", params: { radius: 25, gammaBoost: 0, quality: 3 } },
  { id: "bokeh-small-boost-q10", params: { radius: 6.5, gammaBoost: 1.2, quality: 10 } },
  { id: "bokeh-wide-dark-q1", params: { radius: 60, gammaBoost: -0.5, quality: 1 } },
  { id: "bokeh-sub-pixel", params: { radius: 0.5, gammaBoost: 0, quality: 3 } },
];

export const BOKEH_CASES: readonly BokehBlurCase[] = BOKEH_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/bokeh-blur/${kase.id}.png`,
}));

/**
 * The neighborhood blurs on the tiled input (`makeTiledInput`), run on the GPU in several tiles and
 * compared with the Rust reference built in the same page. Each is one blur at one setting.
 */
/**
 * The artistic effects (FX-ART-INK, FX-ART-OIL, FX-ART-PENCIL) on `BLUR_INPUT`: the default and two
 * other settings of each. The references are the Rust outputs.
 */
export interface InkSketchCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: InkSketchParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const INK_SHAPES: readonly Omit<InkSketchCase, "expected">[] = [
  { id: "ink-sketch-default", params: { inkOutline: 50, coloring: 50 } },
  { id: "ink-sketch-thin-lines", params: { inkOutline: 20, coloring: 0 } },
  { id: "ink-sketch-bold-colored", params: { inkOutline: 80, coloring: 100 } },
];

export const INK_CASES: readonly InkSketchCase[] = INK_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/artistic/${kase.id}.png`,
}));

export interface OilPaintingCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: OilPaintingParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const OIL_SHAPES: readonly Omit<OilPaintingCase, "expected">[] = [
  {
    id: "oil-painting-default",
    params: { brushSize: 10, granularity: 0.2, kernelShape: "circle" },
  },
  {
    id: "oil-painting-square-coarse",
    params: { brushSize: 3, granularity: 0.1, kernelShape: "square" },
  },
  {
    id: "oil-painting-full-bins",
    params: { brushSize: 2, granularity: 1, kernelShape: "circle" },
  },
];

export const OIL_CASES: readonly OilPaintingCase[] = OIL_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/artistic/${kase.id}.png`,
}));

export interface PencilSketchCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: PencilSketchParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const PENCIL_SHAPES: readonly Omit<PencilSketchCase, "expected">[] = [
  { id: "pencil-sketch-default", params: { tipSize: 2, range: 0 } },
  { id: "pencil-sketch-heavy", params: { tipSize: 5, range: 10 } },
  { id: "pencil-sketch-light", params: { tipSize: 1, range: -15 } },
];

export const PENCIL_CASES: readonly PencilSketchCase[] = PENCIL_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/artistic/${kase.id}.png`,
}));

/** The photo effects (FX-PHOTO-GLOW, FX-PHOTO-SOFTEN) on `BLUR_INPUT`, with references from Rust. */
export interface GlowCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: GlowParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const GLOW_SHAPES: readonly Omit<GlowCase, "expected">[] = [
  { id: "glow-default", params: { radius: 6, brightness: 10, contrast: 10 } },
  { id: "glow-soft-dark", params: { radius: 2, brightness: -30, contrast: 60 } },
  { id: "glow-wide-bright", params: { radius: 14.5, brightness: 60, contrast: -40 } },
];

export const GLOW_CASES: readonly GlowCase[] = GLOW_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/photo/${kase.id}.png`,
}));

export interface SoftenPortraitCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: SoftenPortraitParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const SOFTEN_SHAPES: readonly Omit<SoftenPortraitCase, "expected">[] = [
  { id: "soften-default", params: { softness: 5, lighting: 0, warmth: 10 } },
  { id: "soften-bright-warm", params: { softness: 8, lighting: 15, warmth: 20 } },
  { id: "soften-dark-cool", params: { softness: 2.5, lighting: -12, warmth: 0 } },
];

export const SOFTEN_CASES: readonly SoftenPortraitCase[] = SOFTEN_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/photo/${kase.id}.png`,
}));

export interface SharpenCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: SharpenParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const SHARPEN_SHAPES: readonly Omit<SharpenCase, "expected">[] = [
  { id: "sharpen-default", params: { amount: 2, threshold: 0 } },
  { id: "sharpen-thresholded", params: { amount: 6, threshold: 0.1 } },
  { id: "sharpen-max", params: { amount: 10, threshold: 0.4 } },
];

export const SHARPEN_CASES: readonly SharpenCase[] = SHARPEN_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/photo/${kase.id}.png`,
}));

/** Straighten (FX-PHOTO-STRAIGHTEN) on `BLUR_INPUT`, with references from Rust. */
export interface StraightenCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: StraightenParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const STRAIGHTEN_SHAPES: readonly Omit<StraightenCase, "expected">[] = [
  { id: "straighten-bicubic", params: { angle: 12, sampling: "bicubic" } },
  { id: "straighten-bilinear", params: { angle: -30, sampling: "bilinear" } },
  { id: "straighten-nearest", params: { angle: 7.5, sampling: "nearestNeighbor" } },
];

export const STRAIGHTEN_CASES: readonly StraightenCase[] = STRAIGHTEN_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/photo/${kase.id}.png`,
}));

/** Vignette (FX-PHOTO-VIGNETTE) on `BLUR_INPUT`, with references from Rust. */
export interface VignetteCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: VignetteParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const VIGNETTE_SHAPES: readonly Omit<VignetteCase, "expected">[] = [
  { id: "vignette-default", params: { center: { x: 0, y: 0 }, radius: 0.5, strength: 1 } },
  {
    id: "vignette-offset-soft",
    params: { center: { x: 0.4, y: -0.3 }, radius: 1.5, strength: 0.6 },
  },
  {
    id: "vignette-small-weak",
    params: { center: { x: -0.6, y: 0.5 }, radius: 0.3, strength: 0.4 },
  },
];

export const VIGNETTE_CASES: readonly VignetteCase[] = VIGNETTE_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/photo/${kase.id}.png`,
}));

/** Rotate / Zoom (FX-NOSUB-ROTZOOM-01) on `BLUR_INPUT`, with references from Rust. */
export interface RotateZoomCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: RotateZoomParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const ROTATE_ZOOM_SHAPES: readonly Omit<RotateZoomCase, "expected">[] = [
  {
    id: "rotate-zoom-roll-bilinear",
    params: {
      roll: { x: 25, y: -30, z: 20 },
      pan: { x: 0, y: 0 },
      zoom: 1,
      sampling: "bilinear",
      quality: 1,
      tiling: "none",
    },
  },
  {
    id: "rotate-zoom-pan-nearest-repeat",
    params: {
      roll: { x: 0, y: 0, z: 0 },
      pan: { x: 2.5, y: 0 },
      zoom: 0.5,
      sampling: "nearestNeighbor",
      quality: 2,
      tiling: "repeat",
    },
  },
  {
    id: "rotate-zoom-tilt-mirror",
    params: {
      roll: { x: -70, y: 60, z: 35 },
      pan: { x: 1.5, y: -1 },
      zoom: 1.6,
      sampling: "bilinear",
      quality: 3,
      tiling: "mirror",
    },
  },
];

export const ROTATE_ZOOM_CASES: readonly RotateZoomCase[] = ROTATE_ZOOM_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/photo/${kase.id}.png`,
}));

/** A Stylize case (FX-STYL) on `BLUR_INPUT`, with references from Rust. */
export interface EdgeDetectCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: EdgeDetectParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const EDGE_DETECT_SHAPES: readonly Omit<EdgeDetectCase, "expected">[] = [
  {
    id: "edge-sobel-default",
    params: { strength: 0.5, blurring: 0, algorithm: "sobel", overlayEdges: false },
  },
  {
    id: "edge-prewitt-blurred",
    params: { strength: 1, blurring: 3, algorithm: "prewitt", overlayEdges: false },
  },
  {
    id: "edge-overlay",
    params: { strength: 0.8, blurring: 1.5, algorithm: "sobel", overlayEdges: true },
  },
];

export const EDGE_DETECT_CASES: readonly EdgeDetectCase[] = EDGE_DETECT_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/stylize/${kase.id}.png`,
}));

export interface EmbossCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: EmbossParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const EMBOSS_SHAPES: readonly Omit<EmbossCase, "expected">[] = [
  { id: "emboss-east", params: { angle: 0 } },
  { id: "emboss-northwest", params: { angle: 135 } },
  { id: "emboss-wrap", params: { angle: 300 } },
];

export const EMBOSS_CASES: readonly EmbossCase[] = EMBOSS_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/stylize/${kase.id}.png`,
}));

export interface ReliefCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: ReliefParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const RELIEF_SHAPES: readonly Omit<ReliefCase, "expected">[] = [
  { id: "relief-default", params: { angle: 45 } },
  { id: "relief-lower-left", params: { angle: -120 } },
  { id: "relief-wide", params: { angle: 170 } },
];

export const RELIEF_CASES: readonly ReliefCase[] = RELIEF_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/stylize/${kase.id}.png`,
}));

export interface OutlineCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: OutlineParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const OUTLINE_SHAPES: readonly Omit<OutlineCase, "expected">[] = [
  { id: "outline-default", params: { thickness: 3, intensity: 50, quality: 8 } },
  { id: "outline-thick-low-quality", params: { thickness: 6, intensity: 80, quality: 4 } },
  { id: "outline-thin-intense", params: { thickness: 1, intensity: 100, quality: 12 } },
];

export const OUTLINE_CASES: readonly OutlineCase[] = OUTLINE_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/stylize/${kase.id}.png`,
}));

export interface DropShadowCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: DropShadowParams;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const DROP_SHADOW_SHAPES: readonly Omit<DropShadowCase, "expected">[] = [
  {
    id: "drop-shadow-default",
    params: { radius: 10, distance: 10, angle: -45, opacity: 0.75, color: 0, onlyShadow: false },
  },
  {
    id: "drop-shadow-tinted-offset",
    params: {
      radius: 2.5,
      distance: 6.5,
      angle: 120,
      opacity: 0.5,
      color: 0x30_60_ff,
      onlyShadow: false,
    },
  },
  {
    id: "drop-shadow-only-shadow",
    params: { radius: 6, distance: 8, angle: 0, opacity: 1, color: 0x40_20_00, onlyShadow: true },
  },
];

export const DROP_SHADOW_CASES: readonly DropShadowCase[] = DROP_SHADOW_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/object/${kase.id}.png`,
}));

export interface AlignObjectCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: Pick<AlignObjectParams, "position" | "showFaintPixels">;
  /** The aliased selection: a rectangle, a disc, or undefined for the whole image. */
  readonly selection?: SelectionRect | "disc";
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const ALIGN_OBJECT_SHAPES: readonly Omit<AlignObjectCase, "expected">[] = [
  { id: "align-object-center", params: { position: "center", showFaintPixels: false } },
  { id: "align-object-bottom-right", params: { position: "bottomRight", showFaintPixels: false } },
  {
    id: "align-object-center-horizontally-faint",
    params: { position: "centerHorizontally", showFaintPixels: true },
  },
  { id: "align-object-middle-left", params: { position: "middleLeft", showFaintPixels: false } },
  {
    id: "align-object-top-left-selected",
    params: { position: "topLeft", showFaintPixels: false },
    selection: { x: 3, y: 2, width: 20, height: 18 },
  },
  {
    id: "align-object-top-right-disc",
    params: { position: "topRight", showFaintPixels: false },
    selection: "disc",
  },
];

export const ALIGN_OBJECT_CASES: readonly AlignObjectCase[] = ALIGN_OBJECT_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/object/${kase.id}.png`,
}));

/**
 * The input of the Align Object cases: a 40 x 24 transparent layer with a 9 x 7 object of varied
 * colors, some pixels of alpha 1 and a transparent hole, and one stray pixel in the frame's last row.
 */
export function alignObjectInput(): { width: number; height: number; data: Uint8Array } {
  const width = 40;
  const height = 24;
  const data = new Uint8Array(width * height * 4);
  for (let y = 6; y < 13; y++) {
    for (let x = 9; x < 18; x++) {
      const alpha = (x + 2 * y) % 7 === 0 ? 1 : 80 + ((x * 23 + y * 11) % 176);
      const rgba = x === 13 && y === 9 ? [0, 0, 0, 0] : [x * 13, y * 17, (x * y) % 256, alpha];
      data.set(rgba, (y * width + x) * 4);
    }
  }
  data.set([250, 240, 10, 200], ((height - 1) * width + 12) * 4);
  return { width, height, data };
}

/** The coverage an Align Object case selects: 255 inside, 0 outside, or undefined for none. */
export function alignObjectCoverage(
  kase: AlignObjectCase,
  width: number,
  height: number,
): Uint8Array | undefined {
  const { selection } = kase;
  if (selection === undefined) return undefined;
  const coverage = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside =
        selection === "disc"
          ? (x - 15) ** 2 + (y - 11) ** 2 <= 121
          : x >= selection.x &&
            x < selection.x + selection.width &&
            y >= selection.y &&
            y < selection.y + selection.height;
      if (inside) coverage[y * width + x] = 255;
    }
  }
  return coverage;
}

export interface FlipObjectCase {
  /** Unique; the WGSL output is compared with the Rust reference run in the page. */
  readonly id: string;
  readonly vertical: boolean;
  /** The selection over the whole input, or undefined for none. */
  readonly selection?: "rect" | "l-shape" | "ellipse";
  readonly width: number;
  readonly height: number;
}

export const FLIP_OBJECT_CASES: readonly FlipObjectCase[] = [
  { id: "flip-horizontal-all", vertical: false, width: 40, height: 24 },
  { id: "flip-vertical-all-odd", vertical: true, width: 37, height: 23 },
  { id: "flip-horizontal-rect", vertical: false, selection: "rect", width: 31, height: 20 },
  { id: "flip-horizontal-l-shape", vertical: false, selection: "l-shape", width: 33, height: 25 },
  { id: "flip-vertical-l-shape", vertical: true, selection: "l-shape", width: 33, height: 25 },
  { id: "flip-horizontal-ellipse", vertical: false, selection: "ellipse", width: 41, height: 27 },
  { id: "flip-vertical-ellipse", vertical: true, selection: "ellipse", width: 41, height: 27 },
];

/** Varied colours and alphas, transparent pixels included, so every remap and blend shows. */
export function flipObjectInput(kase: FlipObjectCase): { data: Uint8Array } {
  const { width, height } = kase;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = (x * 7 + y * 3) % 11 === 0 ? 0 : 40 + ((x * 29 + y * 13) % 216);
      data.set([(x * 13) % 256, (y * 17) % 256, (x * y) % 256, alpha], (y * width + x) * 4);
    }
  }
  return { data };
}

/**
 * The coverage of a flip case, over the selection's bounding box (the whole input): a full
 * rectangle, an aliased L in the left part, or an antialiased ellipse off centre with partial
 * coverage on its edge. Undefined for no selection.
 */
export function flipObjectCoverage(kase: FlipObjectCase): Uint8Array | undefined {
  const { width, height, selection } = kase;
  if (selection === undefined) return undefined;
  const coverage = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c = 255;
      if (selection === "l-shape") c = x < 8 || y >= height - 6 ? 255 : 0;
      if (selection === "ellipse") {
        const d = ((x + 0.5 - 15) / 14) ** 2 + ((y + 0.5 - 12) / 11) ** 2;
        c = Math.round(Math.min(1, Math.max(0, (1.15 - d) / 0.3)) * 255);
      }
      coverage[y * width + x] = c;
    }
  }
  return coverage;
}

/** A rectangle of the image that a selection covers, in pixels. */
export interface SelectionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RedEyeCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly params: RedEyeParams;
  /** The selected rectangle, or undefined for the whole image. */
  readonly selection?: SelectionRect;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

const RED_EYE_SHAPES: readonly Omit<RedEyeCase, "expected">[] = [
  { id: "red-eye-whole", params: { strength: 3 } },
  {
    id: "red-eye-selected",
    params: { strength: 5 },
    selection: { x: 6, y: 4, width: 12, height: 12 },
  },
];

export const RED_EYE_CASES: readonly RedEyeCase[] = RED_EYE_SHAPES.map((kase) => ({
  ...kase,
  expected: `fixtures/photo/${kase.id}.png`,
}));

/**
 * The input of the Red Eye Removal cases: a 40 x 24 skin-toned patch with two red eyes, the left one
 * half-transparent at its edge column. `BLUR_INPUT` has no red to correct, so it cannot test this.
 */
export function redEyeInput(): { width: number; height: number; data: Uint8Array } {
  const width = 40;
  const height = 24;
  const eyes = [
    { x: 12, y: 10 },
    { x: 27, y: 10 },
  ];
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rgba = [200, 160, 130, 255];
      for (const eye of eyes) {
        if ((x - eye.x) ** 2 + (y - eye.y) ** 2 <= 16) {
          rgba = [220 + (x % 3) * 8, 30 + ((x + y) % 4) * 6, 35, 255];
        }
      }
      if (x === 0) rgba = [rgba[0] ?? 0, rgba[1] ?? 0, rgba[2] ?? 0, 128];
      data.set(rgba, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/**
 * The per-pixel coverage a red-eye case selects over a `width` x `height` image: 255 inside the
 * selection and 0 outside, or undefined when the case has no selection.
 */
export function redEyeCoverage(
  kase: RedEyeCase,
  width: number,
  height: number,
): Uint8Array | undefined {
  if (!kase.selection) return undefined;
  const { x, y, width: w, height: h } = kase.selection;
  const coverage = new Uint8Array(width * height);
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) coverage[row * width + col] = 255;
  }
  return coverage;
}

export type TiledNeighborhoodCase =
  | { readonly id: string; readonly kind: "median"; readonly params: MedianBlurParams }
  | { readonly id: string; readonly kind: "surface"; readonly params: SurfaceBlurParams }
  | { readonly id: string; readonly kind: "sketch"; readonly params: SketchBlurParams }
  | { readonly id: string; readonly kind: "addNoise"; readonly params: AddNoiseParams }
  | { readonly id: string; readonly kind: "reduceNoise"; readonly params: ReduceNoiseParams };

export const TILED_CASES: readonly TiledNeighborhoodCase[] = [
  { id: "median-tiled", kind: "median", params: { radius: 5, percentile: 40, quality: 6 } },
  { id: "surface-tiled", kind: "surface", params: { radius: 4, threshold: 25 } },
  { id: "sketch-tiled", kind: "sketch", params: { radius: 6, percentile: 60, smoothness: 3 } },
  {
    id: "add-noise-tiled",
    kind: "addNoise",
    params: { intensity: 70, colorSaturation: 180, coverage: 60, userSeed: 3, instanceSeed: 0x55 },
  },
  { id: "reduce-noise-tiled", kind: "reduceNoise", params: { radius: 4, strength: 0.7 } },
];

/** The tiled-dispatch input: larger than one 128 px tile on both axes, so a GPU run covers several tiles. */
export const TILED_INPUT_SIZE = { width: 300, height: 200 } as const;

/**
 * Resampling choices (DOC-IMG-02) in the order of `RESAMPLE_FILTERS` in `@openpaint/document`. The
 * `cases.test.ts` suite checks that the two lists match.
 */
export const RESAMPLE_FILTER_NAMES = [
  "nearest",
  "bilinear",
  "bilinearLowQuality",
  "bicubic",
  "bicubicSmooth",
  "adaptive",
  "lanczos3",
  "superSampling",
  "fant",
] as const;

/** Resampling input: non-square, so each axis gets its own fractional scale. */
export const RESAMPLE_INPUT = "fixtures/resample/input.png";
export const RESAMPLE_INPUT_SIZE = { width: 13, height: 9 } as const;

/** Downscale and upscale targets, both with fractional ratios on each axis. */
export const RESAMPLE_SIZES = {
  down: { width: 7, height: 5 },
  up: { width: 21, height: 15 },
} as const;

export interface ResampleCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly filter: (typeof RESAMPLE_FILTER_NAMES)[number];
  readonly direction: keyof typeof RESAMPLE_SIZES;
  readonly linearLight: boolean;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

/** Every filter in both directions, with and without gamma correction. */
export const RESAMPLE_CASES: readonly ResampleCase[] = RESAMPLE_FILTER_NAMES.flatMap((filter) =>
  (["down", "up"] as const).flatMap((direction) =>
    [true, false].map((linearLight) => {
      const stem = `${filter}-${direction}-${linearLight ? "linear" : "srgb"}`;
      return {
        id: `resample-${stem}`,
        filter,
        direction,
        linearLight,
        expected: `fixtures/resample/${stem}.png`,
      };
    }),
  ),
);

/** Palette quantization input: pixels are opaque or fully transparent, as the PNG pipeline prepares them. */
export const QUANTIZE_INPUT = "fixtures/quantize/input.png";
export const QUANTIZE_INPUT_SIZE = { width: 40, height: 24 } as const;

interface QuantizeCaseSpec {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly algorithm: "medianCut" | "octree";
  /** Palette entries the quantizer may use, before any transparent entry. */
  readonly capacity: number;
  /** Whether fully transparent pixels stay out of the palette (the 8-bit alpha target). */
  readonly transparentEntry: boolean;
  /** Dithering level 0 to 8 (FMT-QNT-01). */
  readonly dithering: number;
}

export interface QuantizeCase extends QuantizeCaseSpec {
  /** Reference PNG holding the palette-mapped image: each pixel takes its palette color. */
  readonly expected: string;
}

/** Both algorithms, with and without dithering, at small and large palettes and with a transparent entry. */
export const QUANTIZE_CASES: readonly QuantizeCase[] = (
  [
    {
      id: "quantize-medianCut-16-d0",
      algorithm: "medianCut",
      capacity: 16,
      transparentEntry: false,
      dithering: 0,
    },
    {
      id: "quantize-medianCut-16-d7",
      algorithm: "medianCut",
      capacity: 16,
      transparentEntry: false,
      dithering: 7,
    },
    {
      id: "quantize-medianCut-4-d8",
      algorithm: "medianCut",
      capacity: 4,
      transparentEntry: false,
      dithering: 8,
    },
    {
      id: "quantize-octree-16-d0",
      algorithm: "octree",
      capacity: 16,
      transparentEntry: false,
      dithering: 0,
    },
    {
      id: "quantize-octree-16-d7",
      algorithm: "octree",
      capacity: 16,
      transparentEntry: false,
      dithering: 7,
    },
    {
      id: "quantize-octree-2-d8",
      algorithm: "octree",
      capacity: 2,
      transparentEntry: false,
      dithering: 8,
    },
    {
      id: "quantize-medianCut-255-alpha-d7",
      algorithm: "medianCut",
      capacity: 255,
      transparentEntry: true,
      dithering: 7,
    },
    {
      id: "quantize-octree-255-alpha-d7",
      algorithm: "octree",
      capacity: 255,
      transparentEntry: true,
      dithering: 7,
    },
  ] as const satisfies readonly QuantizeCaseSpec[]
).map((kase) => ({ ...kase, expected: `fixtures/quantize/${kase.id}.png` }));

/** Gradient input: the blend destination, so the blend and transparency cases start from real pixels. */
export const GRADIENT_INPUT = BLEND_INPUTS.dst;

/** Straight RGBA color quadruples for the gradient cases. */
const RED = [255, 0, 0, 255] as const;
const BLUE = [0, 0, 255, 255] as const;
const ORANGE = [255, 128, 0, 255] as const;
const TRANSLUCENT_BLUE = [0, 64, 255, 128] as const;

export interface GradientCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  /** TL-ALG-GRAD shape name, as the engine's `GRADIENT_SHAPES`. */
  readonly shape:
    | "LinearClamped"
    | "LinearReflected"
    | "LinearDiamond"
    | "Radial"
    | "Conical"
    | "Spiral"
    | "SpiralCounterClockwise";
  /** TL-OPT-GRAD repeat name, as the engine's `GRADIENT_REPEATS`. */
  readonly repeat: "NoRepeat" | "RepeatWrapped" | "RepeatReflected";
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
  readonly startColor: readonly [number, number, number, number];
  readonly endColor: readonly [number, number, number, number];
  readonly alphaOnly: boolean;
  readonly antialias: boolean;
  /** A layer blend value 0 to 13, or 14 for Overwrite. */
  readonly blend: number;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

type GradientCaseSpec = Omit<GradientCase, "expected">;

/** The color object of one stored RGBA quadruple. */
export function gradientColorOf(color: readonly [number, number, number, number]) {
  return { r: color[0], g: color[1], b: color[2], a: color[3] };
}

/**
 * Every shape, each repeat rule, the premultiplied and opaque color paths, the transparency mode, the
 * aliased lookup table, and the blend and Overwrite paths (TL-GRAD-01, TL-ALG-GRAD).
 */
export const GRADIENT_CASES: readonly GradientCase[] = (
  [
    {
      id: "gradient-linear-aa",
      shape: "LinearClamped",
      repeat: "NoRepeat",
      start: [4, 4],
      end: [28, 20],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-linear-aliased",
      shape: "LinearClamped",
      repeat: "NoRepeat",
      start: [4, 4],
      end: [28, 20],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: false,
      blend: 0,
    },
    {
      id: "gradient-linear-translucent",
      shape: "LinearClamped",
      repeat: "NoRepeat",
      start: [2, 30],
      end: [30, 2],
      startColor: ORANGE,
      endColor: TRANSLUCENT_BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-reflected",
      shape: "LinearReflected",
      repeat: "NoRepeat",
      start: [16, 16],
      end: [24, 16],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-diamond",
      shape: "LinearDiamond",
      repeat: "NoRepeat",
      start: [16, 16],
      end: [24, 22],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-radial",
      shape: "Radial",
      repeat: "NoRepeat",
      start: [16, 16],
      end: [22, 16],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-conical",
      shape: "Conical",
      repeat: "NoRepeat",
      start: [16, 16],
      end: [28, 16],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-spiral",
      shape: "Spiral",
      repeat: "NoRepeat",
      start: [16, 16],
      end: [28, 20],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-spiral-counterclockwise",
      shape: "SpiralCounterClockwise",
      repeat: "NoRepeat",
      start: [16, 16],
      end: [28, 20],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-wrapped",
      shape: "LinearClamped",
      repeat: "RepeatWrapped",
      start: [2, 2],
      end: [10, 2],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-reflected-repeat",
      shape: "LinearClamped",
      repeat: "RepeatReflected",
      start: [2, 2],
      end: [10, 6],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-conical-wrapped",
      shape: "Conical",
      repeat: "RepeatWrapped",
      start: [16, 16],
      end: [28, 16],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-spiral-reflected",
      shape: "Spiral",
      repeat: "RepeatReflected",
      start: [16, 16],
      end: [26, 16],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-radial-short-wrapped",
      shape: "Radial",
      repeat: "RepeatWrapped",
      start: [16, 16],
      end: [20, 16],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-alpha",
      shape: "LinearClamped",
      repeat: "NoRepeat",
      start: [2, 16],
      end: [30, 16],
      startColor: [10, 20, 30, 255],
      endColor: [200, 100, 50, 0],
      alphaOnly: true,
      antialias: true,
      blend: 0,
    },
    {
      id: "gradient-alpha-overwrite",
      shape: "LinearClamped",
      repeat: "NoRepeat",
      start: [2, 16],
      end: [30, 16],
      startColor: [10, 20, 30, 255],
      endColor: [200, 100, 50, 0],
      alphaOnly: true,
      antialias: true,
      blend: 14,
    },
    {
      id: "gradient-multiply",
      shape: "LinearClamped",
      repeat: "NoRepeat",
      start: [4, 4],
      end: [28, 28],
      startColor: RED,
      endColor: BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 1,
    },
    {
      id: "gradient-overwrite",
      shape: "Radial",
      repeat: "NoRepeat",
      start: [16, 16],
      end: [26, 16],
      startColor: ORANGE,
      endColor: TRANSLUCENT_BLUE,
      alphaOnly: false,
      antialias: true,
      blend: 14,
    },
  ] as const satisfies readonly GradientCaseSpec[]
).map((kase) => ({ ...kase, expected: `fixtures/gradient/${kase.id}.png` }));

/** Adjustment input: the same size as the blur input, so the edges and the transparent pixels are covered. */
export const ADJUSTMENT_INPUT = "fixtures/adjust/input.png";
export const ADJUSTMENT_INPUT_SIZE = { width: 40, height: 24 } as const;

export interface AdjustmentCase {
  /** Unique, and the stem of the reference file. */
  readonly id: string;
  readonly adjustment:
    | "invertColors"
    | "invertAlpha"
    | "blackAndWhite"
    | "sepia"
    | "autoLevel"
    | "brightnessContrast"
    | "hueSaturation"
    | "posterize"
    | "levels"
    | "curves"
    | "exposure"
    | "temperatureTint"
    | "highlightsShadows";
  /** Exposure, -200 to 200 (ADJ-EXPOSURE). Only Exposure reads it. */
  readonly exposure?: number;
  /** Temperature and Tint, -100 to 100 (ADJ-TT). Only Temperature / Tint reads them. */
  readonly temperature?: number;
  readonly tint?: number;
  /** Highlights, Shadows and Clarity, -100 to 100, and the Radius 0-10 (ADJ-HS). */
  readonly highlights?: number;
  readonly shadows?: number;
  readonly clarity?: number;
  readonly radius?: number;
  /** Sepia Intensity 0-100 (ADJ-SEPIA). Only Sepia reads it, so the other cases omit it. */
  readonly intensity?: number;
  /** Brightness and Contrast, -100 to 100 (ADJ-BC). Only Brightness / Contrast reads them. */
  readonly brightness?: number;
  readonly contrast?: number;
  /** Hue -180 to 180, Saturation 0 to 200 and Lightness -100 to 100 (ADJ-HUESAT). */
  readonly hue?: number;
  readonly saturation?: number;
  readonly lightness?: number;
  /** Posterize level counts for R, G, B and A, 0 for an unchanged channel (ADJ-POSTERIZE). */
  readonly levels?: readonly number[];
  /** Curves mode and the control points of each curve (ADJ-CURVES). Only Curves reads them. */
  readonly curves?: {
    readonly mode: "luminosity" | "rgb";
    readonly luminosity?: readonly (readonly [number, number])[];
    readonly red?: readonly (readonly [number, number])[];
    readonly green?: readonly (readonly [number, number])[];
    readonly blue?: readonly (readonly [number, number])[];
  };
  /** Levels points, gamma and output range per channel (ADJ-LEVELS-PARAMS). Only Levels reads them. */
  readonly levelsParams?: Readonly<
    Record<
      "inputBlack" | "inputWhite" | "gamma" | "outputBlack" | "outputWhite",
      readonly [number, number, number]
    >
  >;
  /** Reference PNG holding the expected output. */
  readonly expected: string;
}

/**
 * Every adjustment, Sepia at its ends, at its default and at a value between the steps, and
 * Brightness / Contrast over its range (including the full-contrast threshold and negative contrast).
 * Auto-Level runs over the whole input, which has transparent pixels and the edge colors.
 */
export const ADJUSTMENT_CASES: readonly AdjustmentCase[] = (
  [
    { id: "adjust-invertColors", adjustment: "invertColors" },
    { id: "adjust-invertAlpha", adjustment: "invertAlpha" },
    { id: "adjust-blackAndWhite", adjustment: "blackAndWhite" },
    { id: "adjust-sepia-0", adjustment: "sepia", intensity: 0 },
    { id: "adjust-sepia-37", adjustment: "sepia", intensity: 37 },
    { id: "adjust-sepia-50", adjustment: "sepia", intensity: 50 },
    { id: "adjust-sepia-100", adjustment: "sepia", intensity: 100 },
    { id: "adjust-autoLevel", adjustment: "autoLevel" },
    { id: "adjust-exposure-minus-150", adjustment: "exposure", exposure: -150 },
    { id: "adjust-exposure-plus-60", adjustment: "exposure", exposure: 60 },
    { id: "adjust-exposure-plus-200", adjustment: "exposure", exposure: 200 },
    { id: "adjust-temperature-warm", adjustment: "temperatureTint", temperature: 60, tint: 0 },
    {
      id: "adjust-temperature-cool-green",
      adjustment: "temperatureTint",
      temperature: -40,
      tint: 30,
    },
    { id: "adjust-tint-magenta", adjustment: "temperatureTint", temperature: 0, tint: -80 },
    {
      id: "adjust-highlights-brighten",
      adjustment: "highlightsShadows",
      highlights: 60,
      shadows: 0,
      clarity: 0,
      radius: 1.25,
    },
    {
      id: "adjust-highlights-shadows-mixed",
      adjustment: "highlightsShadows",
      highlights: -40,
      shadows: 70,
      clarity: 0,
      radius: 4,
    },
    {
      id: "adjust-highlights-clarity-unblurred",
      adjustment: "highlightsShadows",
      highlights: 0,
      shadows: -30,
      clarity: 60,
      radius: 0,
    },
    {
      id: "adjust-highlights-long-radius",
      adjustment: "highlightsShadows",
      highlights: 100,
      shadows: -100,
      clarity: -100,
      radius: 10,
    },
    {
      id: "adjust-levels-channels",
      adjustment: "levels",
      levelsParams: {
        inputBlack: [0.1, 0, 0.2],
        inputWhite: [0.9, 1, 0.7],
        gamma: [1.5, 0.6, 1],
        outputBlack: [0, 0.1, 0],
        outputWhite: [1, 0.8, 0.9],
      },
    },
    {
      id: "adjust-levels-output-gamma",
      adjustment: "levels",
      levelsParams: {
        inputBlack: [0.2, 0.2, 0.2],
        inputWhite: [0.8, 0.8, 0.8],
        gamma: [0.5, 2.5, 10],
        outputBlack: [0.25, 0, 0],
        outputWhite: [1, 1, 0.5],
      },
    },
    {
      id: "adjust-brightnessContrast-b40",
      adjustment: "brightnessContrast",
      brightness: 40,
      contrast: 0,
    },
    {
      id: "adjust-brightnessContrast-bm35",
      adjustment: "brightnessContrast",
      brightness: -35,
      contrast: 0,
    },
    {
      id: "adjust-brightnessContrast-c50",
      adjustment: "brightnessContrast",
      brightness: 0,
      contrast: 50,
    },
    {
      id: "adjust-brightnessContrast-cm60",
      adjustment: "brightnessContrast",
      brightness: 0,
      contrast: -60,
    },
    {
      id: "adjust-brightnessContrast-c100",
      adjustment: "brightnessContrast",
      brightness: 0,
      contrast: 100,
    },
    {
      id: "adjust-brightnessContrast-mix",
      adjustment: "brightnessContrast",
      brightness: -25,
      contrast: 35,
    },
    {
      id: "adjust-hueSaturation-hue",
      adjustment: "hueSaturation",
      hue: 70,
      saturation: 100,
      lightness: 0,
    },
    {
      id: "adjust-hueSaturation-desat",
      adjustment: "hueSaturation",
      hue: 0,
      saturation: 30,
      lightness: 0,
    },
    {
      id: "adjust-hueSaturation-boost",
      adjustment: "hueSaturation",
      hue: -150,
      saturation: 170,
      lightness: 0,
    },
    {
      id: "adjust-hueSaturation-lightness-down",
      adjustment: "hueSaturation",
      hue: 0,
      saturation: 100,
      lightness: -40,
    },
    {
      id: "adjust-hueSaturation-lightness-up",
      adjustment: "hueSaturation",
      hue: 0,
      saturation: 100,
      lightness: 65,
    },
    {
      id: "adjust-hueSaturation-mix",
      adjustment: "hueSaturation",
      hue: 180,
      saturation: 60,
      lightness: 25,
    },
    {
      id: "adjust-posterize-16",
      adjustment: "posterize",
      levels: [16, 16, 16, 0],
    },
    {
      id: "adjust-posterize-2",
      adjustment: "posterize",
      levels: [2, 2, 2, 0],
    },
    {
      id: "adjust-posterize-mixed-alpha",
      adjustment: "posterize",
      levels: [5, 7, 0, 4],
    },
    {
      id: "adjust-curves-luminosity",
      adjustment: "curves",
      curves: {
        mode: "luminosity",
        luminosity: [
          [0, 0],
          [64, 40],
          [160, 210],
          [255, 255],
        ],
      },
    },
    {
      id: "adjust-curves-luminosity-clip",
      adjustment: "curves",
      curves: {
        mode: "luminosity",
        luminosity: [
          [0, 0],
          [128, 255],
          [255, 255],
        ],
      },
    },
    {
      id: "adjust-curves-rgb",
      adjustment: "curves",
      curves: {
        mode: "rgb",
        red: [
          [0, 0],
          [128, 180],
          [255, 255],
        ],
        green: [
          [0, 40],
          [255, 200],
        ],
        blue: [
          [0, 255],
          [90, 120],
          [255, 0],
        ],
      },
    },
  ] as const satisfies readonly Omit<AdjustmentCase, "expected">[]
).map((kase) => ({ ...kase, expected: `fixtures/adjust/${kase.id}.png` }));

export const BLEND_CASES: readonly BlendCase[] = BLEND_MODE_NAMES.flatMap((modeName, mode) =>
  BLEND_OPACITIES.map((opacity) => {
    const stem = `${modeName}-${opacity}`;
    return {
      id: `blend-${stem}`,
      mode,
      modeName,
      opacity,
      expected: `fixtures/blend/${stem}.png`,
    };
  }),
);
