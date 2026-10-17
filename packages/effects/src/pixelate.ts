import { pixelate_grid, pixelate_plan, pixelate_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
  type Vector2,
} from "@openpaint/properties";
import { distortedSurface, SOURCE_UNDERLAY_KEY, surfaceBytes, vector2Value } from "./distortion";
import type { EffectBinding } from "./framework/binding";

export const PIXELATE_ID = "pixelate";

/**
 * The Scale Down interpolations (FX-DIST-PIXELATE-02), in code order: the array index is the code the
 * kernel takes.
 */
export const SCALE_DOWN_MODES = [
  "nearestNeighbor",
  "bilinear",
  "bicubic",
  "multisampleBilinear",
  "bicubicHighQuality",
  "anisotropic",
] as const;

/** The Scale Up interpolations (FX-DIST-PIXELATE-02), in code order. */
export const SCALE_UP_MODES = ["nearestNeighbor", "bilinear", "bicubic"] as const;

export type ScaleDownMode = (typeof SCALE_DOWN_MODES)[number];
export type ScaleUpMode = (typeof SCALE_UP_MODES)[number];

/** Parameters of Pixelate (FX-DIST-PIXELATE-02). */
export interface PixelateParams {
  /** Cell size in pixels, 1 to 256. */
  readonly cellSize: number;
  /** Grid origin relative to the selection bounds, each component from -1 to 1. */
  readonly anchor: Vector2;
  readonly scaleDown: ScaleDownMode;
  readonly scaleUp: ScaleUpMode;
}

/** The Pixelate schema (FX-DIST-PIXELATE-02). Pixelate has no Quality or seed. */
export function pixelateSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "cellSize",
        label: "property.cellSize",
        defaultValue: 2,
        min: 1,
        max: 256,
      },
      {
        kind: "vector2",
        key: "anchor",
        label: "property.anchor",
        defaultValue: { x: 0, y: 0 },
        min: { x: -1, y: -1 },
        max: { x: 1, y: 1 },
        control: {
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
          upDownIncrement: 0.01,
          staticImageUnderlay: SOURCE_UNDERLAY_KEY,
        },
      },
      {
        kind: "choice",
        key: "scaleDown",
        label: "property.scaleDown",
        defaultValue: "multisampleBilinear",
        options: [
          { value: "anisotropic", label: "interpolation.anisotropic" },
          { value: "bicubicHighQuality", label: "interpolation.bicubicHighQuality" },
          { value: "multisampleBilinear", label: "interpolation.multisampleBilinear" },
          { value: "bicubic", label: "interpolation.bicubic" },
          { value: "bilinear", label: "interpolation.bilinear" },
          { value: "nearestNeighbor", label: "interpolation.nearestNeighbor" },
        ],
      },
      {
        kind: "choice",
        key: "scaleUp",
        label: "property.scaleUp",
        defaultValue: "nearestNeighbor",
        options: [
          { value: "bicubic", label: "interpolation.bicubic" },
          { value: "bilinear", label: "interpolation.bilinear" },
          { value: "nearestNeighbor", label: "interpolation.nearestNeighbor" },
        ],
      },
    ],
  });
}

export function pixelateDescriptor(): EffectDescriptor {
  return {
    id: PIXELATE_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.pixelate",
    icon: "icon.pixelate",
    category: "effect",
    submenu: "distort",
    configurable: true,
    kind: "gpuImage",
    schema: pixelateSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Pixelate's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function pixelateParams(values: PropertyValues): PixelateParams {
  const resolved = resolveValues(pixelateSchema(), values);
  return {
    cellSize: numberValue(resolved, "cellSize"),
    anchor: vector2Value(resolved, "anchor"),
    scaleDown: choiceOf(SCALE_DOWN_MODES, resolved.scaleDown, "scaleDown"),
    scaleUp: choiceOf(SCALE_UP_MODES, resolved.scaleUp, "scaleUp"),
  };
}

function choiceOf<T extends string>(options: readonly T[], value: unknown, key: string): T {
  const found = options.find((candidate) => candidate === value);
  if (found === undefined) throw new TypeError(`Property "${key}" is not a listed choice.`);
  return found;
}

/** The kernel codes of the two interpolations, which are their positions in the lists. */
export function pixelateCodes(params: PixelateParams): { down: number; up: number } {
  return {
    down: SCALE_DOWN_MODES.indexOf(params.scaleDown),
    up: SCALE_UP_MODES.indexOf(params.scaleUp),
  };
}

/**
 * The plan of Pixelate over a `width` × `height` region, as `[ax, ay, cell]` (FX-DIST-PIXELATE-03
 * step 1). Requires the WASM kernels to be initialized.
 */
export function pixelatePlan(params: PixelateParams, width: number, height: number): Float32Array {
  return pixelate_plan(
    width,
    height,
    Float32Array.of(params.anchor.x, params.anchor.y),
    params.cellSize,
  );
}

/**
 * The cells that cover a region for a plan, as `[first column, first row, columns, rows]`. Requires
 * the WASM kernels to be initialized.
 */
export function pixelateGrid(plan: Float32Array, width: number, height: number): Int32Array {
  return pixelate_grid(width, height, plan);
}

/**
 * The Rust reference of Pixelate (FX-DIST-PIXELATE-03): returns the pixelated `input` as a new
 * surface.
 */
export function pixelateCpu(input: Surface, params: PixelateParams): Surface {
  const { down, up } = pixelateCodes(params);
  const out = pixelate_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    pixelatePlan(params, input.width, input.height),
    down,
    up,
  );
  return distortedSurface(input, out);
}

/**
 * The host binding of Pixelate: its descriptor, parameter reader and CPU reference. The anchor is
 * relative to the selection bounds, which the session passes as the region.
 */
export function pixelateBinding(): EffectBinding<PixelateParams> {
  return {
    descriptor: pixelateDescriptor(),
    params: (values) => pixelateParams(values),
    cpu: pixelateCpu,
  };
}
