import { motion_blur_rgba8, motion_plan } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import {
  definePropertySchema,
  numberValue,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import {
  distortedSurface,
  type EdgeBehavior,
  edgeBehaviorCode,
  edgeBehaviorOf,
  edgeBehaviorProperty,
  surfaceBytes,
} from "./distortion";
import type { EffectBinding } from "./framework/binding";

export const MOTION_BLUR_ID = "motion-blur";

/** Parameters of Motion Blur (FX-BLUR-MOTION-02). */
export interface MotionBlurParams {
  /** Direction of the motion in degrees; positive angles point up and right. */
  readonly angle: number;
  /** Length of the blur path in pixels. */
  readonly distance: number;
  /** Whether the path is centered on the pixel or trails behind it. */
  readonly centered: boolean;
  /** What the blur reads outside the image. */
  readonly edge: EdgeBehavior;
}

/** The Motion Blur schema, in the UI order of FX-BLUR-MOTION-02. Clamp is the default edge. */
export function motionBlurSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "double",
        key: "angle",
        label: "property.angle",
        defaultValue: 25,
        min: -180,
        max: 180,
        control: { controlType: "anglePicker", rangeWraps: true, sliderLargeChange: 36 },
      },
      {
        kind: "double",
        key: "distance",
        label: "property.distance",
        defaultValue: 10,
        min: 1,
        max: 500,
        control: { decimalPlaces: 2, useExponentialScale: true },
      },
      {
        kind: "boolean",
        key: "centered",
        label: "property.noCaption",
        defaultValue: true,
        control: { description: "property.centered" },
      },
      edgeBehaviorProperty("clamp"),
    ],
  });
}

export function motionBlurDescriptor(): EffectDescriptor {
  return {
    id: MOTION_BLUR_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.motionBlur",
    icon: "icon.motionBlur",
    category: "effect",
    submenu: "blurs",
    configurable: true,
    kind: "gpuImage",
    schema: motionBlurSchema(),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Motion Blur's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function motionBlurParams(values: PropertyValues): MotionBlurParams {
  const resolved = resolveValues(motionBlurSchema(), values);
  return {
    angle: numberValue(resolved, "angle"),
    distance: numberValue(resolved, "distance"),
    centered: resolved.centered === true,
    edge: edgeBehaviorOf(resolved),
  };
}

/**
 * The kernel both backends sample, as `dx, dy, weight` triples (FX-BLUR-MOTION-03). Empty when the
 * distance is 0 or less, which passes the image through. Requires the WASM kernels to be initialized.
 */
export function motionBlurPlan(params: MotionBlurParams): Float32Array {
  return motion_plan(params.distance, params.angle, params.centered);
}

/** The Rust reference of Motion Blur: returns the blurred `input` as a new surface. */
export function motionBlurCpu(input: Surface, params: MotionBlurParams): Surface {
  const out = motion_blur_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.distance,
    params.angle,
    params.centered,
    edgeBehaviorCode(params.edge),
  );
  return distortedSurface(input, out);
}

/** The host binding of Motion Blur: its descriptor, parameter reader and CPU reference. */
export function motionBlurBinding(): EffectBinding<MotionBlurParams> {
  return {
    descriptor: motionBlurDescriptor(),
    params: motionBlurParams,
    cpu: motionBlurCpu,
  };
}
