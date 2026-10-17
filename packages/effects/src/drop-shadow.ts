import { drop_shadow_plan, drop_shadow_rgba8, drop_shadow_weights } from "@openpaint/cpu";
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

export const DROP_SHADOW_ID = "drop-shadow";

/** Parameters of Drop Shadow (FX-OBJ-DROPSHADOW-01). */
export interface DropShadowParams {
  /** Shadow Radius, 0 to 100 (the engine accepts up to 300). The Gaussian has σ = radius / 3. */
  readonly radius: number;
  /** Distance, 0 to 100 pixels. */
  readonly distance: number;
  /** Angle, -180 to 180 degrees. The default -45 casts the shadow down and to the right. */
  readonly angle: number;
  /** Opacity, 0 to 1. */
  readonly opacity: number;
  /** The shadow color, 24-bit RGB (0xRRGGBB). */
  readonly color: number;
  /** Whether the shadow is drawn without the object over it. */
  readonly onlyShadow: boolean;
}

/** The Drop Shadow schema (FX-OBJ-DROPSHADOW-01), in the dialog order of the spec. */
export function dropShadowSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "radius",
        label: "property.shadowRadius",
        defaultValue: 10,
        min: 0,
        max: 100,
        control: { decimalPlaces: 1, useExponentialScale: true },
      },
      {
        kind: "double",
        key: "distance",
        label: "property.distance",
        defaultValue: 10,
        min: 0,
        max: 100,
        control: { decimalPlaces: 1 },
      },
      {
        kind: "double",
        key: "angle",
        label: "property.angle",
        defaultValue: -45,
        min: -180,
        max: 180,
        control: { controlType: "anglePicker" },
      },
      {
        kind: "double",
        key: "opacity",
        label: "property.opacity",
        defaultValue: 0.75,
        min: 0,
        max: 1,
        control: {
          decimalPlaces: 2,
          upDownIncrement: 0.01,
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
        },
      },
      {
        kind: "int32",
        key: "color",
        label: "property.color",
        defaultValue: 0,
        min: 0,
        max: 0xff_ff_ff,
        control: { controlType: "colorWheel" },
      },
      {
        kind: "boolean",
        key: "onlyShadow",
        label: "property.noCaption",
        defaultValue: false,
        control: {
          description: "property.onlyDrawShadow",
          footnote: "property.dropShadowNote",
        },
      },
    ],
  });
}

export function dropShadowDescriptor(): EffectDescriptor {
  return {
    id: DROP_SHADOW_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.dropShadow",
    icon: "icon.dropShadow",
    category: "effect",
    submenu: "object",
    configurable: true,
    kind: "gpuImage",
    schema: dropShadowSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Drop Shadow's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function dropShadowParams(values: PropertyValues): DropShadowParams {
  const resolved = resolveValues(dropShadowSchema(), values);
  return {
    radius: numberValue(resolved, "radius"),
    distance: numberValue(resolved, "distance"),
    angle: numberValue(resolved, "angle"),
    opacity: numberValue(resolved, "opacity"),
    color: numberValue(resolved, "color"),
    onlyShadow: resolved.onlyShadow === true,
  };
}

/**
 * The numbers both backends compute from the parameters: the blur kernel (from the Rust
 * `drop_shadow_weights`) and the plan `[dx, dy, r, g, b, opacity]` (from `drop_shadow_plan`). The
 * WGSL twin reads both. Requires the Rust/WASM kernels to be initialized (`initCpu`).
 */
export interface DropShadowPlan {
  readonly weights: Float32Array;
  readonly plan: Float32Array;
  readonly onlyShadow: boolean;
}

export function planDropShadow(params: DropShadowParams): DropShadowPlan {
  return {
    weights: drop_shadow_weights(params.radius),
    plan: drop_shadow_plan(params.distance, params.angle, params.opacity, params.color),
    onlyShadow: params.onlyShadow,
  };
}

/** The Rust reference of Drop Shadow: returns the shadow, with the layer over it, as a new surface. */
export function dropShadowCpu(input: Surface, params: DropShadowParams): Surface {
  const out = drop_shadow_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.radius,
    params.distance,
    params.angle,
    params.opacity,
    params.color,
    params.onlyShadow,
  );
  return distortedSurface(input, out);
}

/** The host binding of Drop Shadow: its descriptor, parameter reader and CPU reference. */
export function dropShadowBinding(): EffectBinding<DropShadowParams> {
  return {
    descriptor: dropShadowDescriptor(),
    params: dropShadowParams,
    cpu: dropShadowCpu,
  };
}
