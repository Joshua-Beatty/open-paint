import { sharpen_rgba8 } from "@openpaint/cpu";
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

export const SHARPEN_ID = "sharpen";

/** Parameters of Sharpen (FX-PHOTO-SHARPEN-01). */
export interface SharpenParams {
  /** Amount, 0-10. Scales the edge enhancement. */
  readonly amount: number;
  /** Threshold, 0-1. Differences below it are left alone. */
  readonly threshold: number;
}

/** The Sharpen schema (FX-PHOTO-SHARPEN-01). */
export function sharpenSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "amount",
        label: "property.amount",
        defaultValue: 2,
        min: 0,
        max: 10,
        control: { decimalPlaces: 2 },
      },
      {
        kind: "double",
        key: "threshold",
        label: "property.threshold",
        defaultValue: 0,
        min: 0,
        max: 1,
        control: { decimalPlaces: 2, useExponentialScale: true },
      },
    ],
  });
}

export function sharpenDescriptor(): EffectDescriptor {
  return {
    id: SHARPEN_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.sharpen",
    icon: "icon.sharpen",
    category: "effect",
    submenu: "photo",
    configurable: true,
    kind: "gpuImage",
    schema: sharpenSchema(),
    options: { gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Sharpen's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function sharpenParams(values: PropertyValues): SharpenParams {
  const resolved = resolveValues(sharpenSchema(), values);
  return {
    amount: numberValue(resolved, "amount"),
    threshold: numberValue(resolved, "threshold"),
  };
}

/** The Rust reference of Sharpen: returns the sharpened `input` as a new surface. */
export function sharpenCpu(input: Surface, params: SharpenParams): Surface {
  const out = sharpen_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.amount,
    params.threshold,
  );
  return distortedSurface(input, out);
}

/** The host binding of Sharpen: its descriptor, parameter reader and CPU reference. */
export function sharpenBinding(): EffectBinding<SharpenParams> {
  return {
    descriptor: sharpenDescriptor(),
    params: sharpenParams,
    cpu: sharpenCpu,
  };
}
