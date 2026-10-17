import { twist_plan, twist_rgba8 } from "@openpaint/cpu";
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
import {
  distortedSurface,
  distortionQualityProperty,
  type EdgeBehavior,
  edgeBehaviorCode,
  SOURCE_UNDERLAY_KEY,
  surfaceBytes,
  vector2Value,
} from "./distortion";
import type { EffectBinding, EffectDocumentSize } from "./framework/binding";

export const TWIST_ID = "twist";

/** Twist always uses the Clamp edge mode (FX-DIST-TWIST-03), so it has no Edge Behavior control. */
const TWIST_EDGE: EdgeBehavior = "clamp";

/** Parameters of Twist (FX-DIST-TWIST-02). */
export interface TwistParams {
  /** Amount / Direction, -200 to 200. The sign gives the direction. */
  readonly amount: number;
  /** Twist radius factor, 0.01 to 2. */
  readonly size: number;
  /** Center offset from the center of the selection bounds, in half-bounds units. */
  readonly center: Vector2;
  /** Supersampling Quality 1-8 (q² samples). */
  readonly quality: number;
  /**
   * The document's size, which scales the Size (FX-DIST-TWIST-03). Undefined means the selection
   * is the document, so the Size is not scaled.
   */
  readonly document: EffectDocumentSize | undefined;
}

/**
 * The Twist schema (FX-DIST-TWIST-02). The Quality default is the Default Quality Level value
 * (FX-A-00-03 case 1).
 */
export function twistSchema(defaultQuality: number): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "int32",
        key: "amount",
        label: "property.amountDirection",
        defaultValue: 30,
        min: -200,
        max: 200,
        control: { useExponentialScale: true },
      },
      {
        kind: "double",
        key: "size",
        label: "property.size",
        defaultValue: 1,
        min: 0.01,
        max: 2,
      },
      {
        kind: "vector2",
        key: "center",
        label: "property.center",
        defaultValue: { x: 0, y: 0 },
        min: { x: -2, y: -2 },
        max: { x: 2, y: 2 },
        control: {
          sliderSmallChange: 0.05,
          sliderLargeChange: 0.25,
          upDownIncrement: 0.01,
          staticImageUnderlay: SOURCE_UNDERLAY_KEY,
        },
      },
      distortionQualityProperty(defaultQuality),
    ],
  });
}

export function twistDescriptor(defaultQuality: number): EffectDescriptor {
  return {
    id: TWIST_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.twist",
    icon: "icon.twist",
    category: "effect",
    submenu: "distort",
    configurable: true,
    kind: "gpuImage",
    schema: twistSchema(defaultQuality),
    options: { gpu: { workingSpace: "linear", inputAlpha: "straight", outputAlpha: "straight" } },
  };
}

/** Reads Twist's parameters from property values, clamped to the schema (FX-FW-TOKEN-01). */
export function twistParams(
  values: PropertyValues,
  defaultQuality: number,
  document?: EffectDocumentSize,
): TwistParams {
  const resolved = resolveValues(twistSchema(defaultQuality), values);
  return {
    amount: numberValue(resolved, "amount"),
    size: numberValue(resolved, "size"),
    center: vector2Value(resolved, "center"),
    quality: numberValue(resolved, "quality"),
    document,
  };
}

/**
 * The plan of Twist for the sample map: `[cx, cy, limit, gain]` over the region, which is the
 * selection bounds. Requires the WASM kernels to be initialized.
 */
export function twistPlan(params: TwistParams, width: number, height: number): Float32Array {
  const document = params.document ?? { width, height };
  return twist_plan(
    width,
    height,
    Float32Array.of(document.width, document.height),
    Float32Array.of(params.center.x, params.center.y),
    params.amount,
    params.size,
  );
}

/** The Rust reference of Twist (FX-DIST-TWIST-03): returns the distorted `input` as a new surface. */
export function twistCpu(input: Surface, params: TwistParams): Surface {
  const out = twist_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    params.quality,
    edgeBehaviorCode(TWIST_EDGE),
    twistPlan(params, input.width, input.height),
  );
  return distortedSurface(input, out);
}

/** The host binding of Twist: its descriptor, parameter reader and CPU reference. */
export function twistBinding(defaultQuality: number): EffectBinding<TwistParams> {
  return {
    descriptor: twistDescriptor(defaultQuality),
    params: (values, document) => twistParams(values, defaultQuality, document),
    cpu: twistCpu,
  };
}
