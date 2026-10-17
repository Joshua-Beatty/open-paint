import { oil_painting_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { distortedSurface, surfaceBytes } from "./distortion";
import type { EffectBinding } from "./framework/binding";

export const OIL_PAINTING_ID = "oil-painting";

/** The Kernel Shape choices (FX-ART-OIL-02), in code order. */
export const OIL_KERNEL_SHAPES = ["circle", "square"] as const;

export type OilKernelShape = (typeof OIL_KERNEL_SHAPES)[number];

/** Parameters of Oil Painting (FX-ART-OIL-02). */
export interface OilPaintingParams {
  /** Kernel radius in pixels, 1-50. */
  readonly brushSize: number;
  /** Granularity, 0.01-1. The bin count is `int(granularity * 256)`, clamped to 4-256. */
  readonly granularity: number;
  readonly kernelShape: OilKernelShape;
}

/** The Oil Painting schema (FX-ART-OIL-02). Circle is the default Kernel Shape. */
export function oilPaintingSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "brushSize",
        label: "property.brushSize",
        defaultValue: 10,
        min: 1,
        max: 50,
      },
      {
        kind: "double",
        key: "granularity",
        label: "property.granularity",
        defaultValue: 0.2,
        min: 0.01,
        max: 1,
        control: { decimalPlaces: 2, useExponentialScale: true },
      },
      {
        kind: "choice",
        key: "kernelShape",
        label: "property.noCaption",
        defaultValue: "circle",
        options: [
          { value: "circle", label: "oilPainting.circle" },
          { value: "square", label: "oilPainting.square" },
        ],
        control: { description: "property.kernelShape" },
      },
    ],
  });
}

export function oilPaintingDescriptor(): EffectDescriptor {
  return {
    id: OIL_PAINTING_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.oilPainting",
    icon: "icon.oilPainting",
    category: "effect",
    submenu: "artistic",
    configurable: true,
    kind: "gpuImage",
    schema: oilPaintingSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Oil Painting's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function oilPaintingParams(values: PropertyValues): OilPaintingParams {
  const resolved = resolveValues(oilPaintingSchema(), values);
  const shape = OIL_KERNEL_SHAPES.find((candidate) => candidate === resolved.kernelShape);
  return {
    brushSize: numberValue(resolved, "brushSize"),
    granularity: numberValue(resolved, "granularity"),
    kernelShape: shape ?? "circle",
  };
}

/**
 * The numbers both backends compute from the parameters: the bin count, the disc limit
 * `r² + r / 2` (FX-ART-OIL-03) and the kernel shape. The square kernel ignores the limit.
 */
export interface OilPaintingPlan {
  readonly radius: number;
  readonly bins: number;
  readonly limit: number;
  readonly square: boolean;
}

export function planOilPainting(params: OilPaintingParams): OilPaintingPlan {
  const radius = Math.round(params.brushSize);
  return {
    radius,
    bins: Math.min(256, Math.max(4, Math.floor(Math.fround(params.granularity) * 256))),
    limit: radius * radius + radius * 0.5,
    square: params.kernelShape === "square",
  };
}

/** The Rust reference of Oil Painting: returns the painted `input` as a new surface. */
export function oilPaintingCpu(input: Surface, params: OilPaintingParams): Surface {
  const out = oil_painting_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.brushSize,
    params.granularity,
    params.kernelShape === "square",
  );
  return distortedSurface(input, out);
}

/** The host binding of Oil Painting: its descriptor, parameter reader and CPU reference. */
export function oilPaintingBinding(): EffectBinding<OilPaintingParams> {
  return {
    descriptor: oilPaintingDescriptor(),
    params: oilPaintingParams,
    cpu: oilPaintingCpu,
  };
}
