import { distort_affine_rgba8, rgss_offsets } from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import type { ChoiceProperty, Int32Property, PropertyValues, Vector2 } from "@openpaint/properties";
import type { EffectDocumentSize, EffectRegionOrigin } from "./framework/binding";

/** The highest Quality of the distortion engine (FX-A-00-04). */
export const DISTORTION_MAX_QUALITY = 8;

/**
 * The resource key of the live thumbnail of the source under a pan control (FX-A-00-02e). The
 * host resolves it to the source pixels, clipped to the selection bounds.
 */
export const SOURCE_UNDERLAY_KEY = "effect.source";

/**
 * The edge modes in value order (FX-A-00-04 step 4): the array index is the code the engine takes,
 * Clamp (0), Wrap (1), Reflect (2) and Transparent (3).
 */
export const EDGE_BEHAVIORS = ["clamp", "wrap", "reflect", "transparent"] as const;

export type EdgeBehavior = (typeof EDGE_BEHAVIORS)[number];

/** The engine's code of an edge behavior (0-3). */
export function edgeBehaviorCode(edge: EdgeBehavior): number {
  return EDGE_BEHAVIORS.indexOf(edge);
}

/**
 * The integer Quality slider of the distortion effects (FX-A-00-03 case 1). The default is the
 * Default Quality Level value, and it cannot pass the effect's own maximum (Crystalize uses 5).
 */
export function distortionQualityProperty(
  defaultQuality: number,
  max: number = DISTORTION_MAX_QUALITY,
): Int32Property {
  return {
    kind: "int32",
    key: "quality",
    label: "property.quality",
    defaultValue: Math.min(defaultQuality, max),
    min: 1,
    max,
  };
}

/** The "Edge Behavior:" dropdown of the distortion effects (FX-A-00-04 step 4). */
export function edgeBehaviorProperty(defaultEdge: EdgeBehavior): ChoiceProperty {
  return {
    kind: "choice",
    key: "edge",
    label: "property.edgeBehavior",
    defaultValue: defaultEdge,
    options: [
      { value: "clamp", label: "edgeBehavior.clamp" },
      { value: "wrap", label: "edgeBehavior.wrap" },
      { value: "reflect", label: "edgeBehavior.reflect" },
      { value: "transparent", label: "edgeBehavior.transparent" },
    ],
  };
}

/** The edge behavior of a parameter set. The schema has already checked the value. */
export function edgeBehaviorOf(values: PropertyValues): EdgeBehavior {
  const edge = EDGE_BEHAVIORS.find((candidate) => candidate === values.edge);
  if (edge === undefined) throw new TypeError('Property "edge" is not an edge behavior.');
  return edge;
}

/** An (x, y) pair of a parameter set, such as a pan control's value. */
export function vector2Value(values: PropertyValues, key: string): Vector2 {
  const value = values[key];
  if (typeof value === "object" && "x" in value && "y" in value) {
    return { x: value.x, y: value.y };
  }
  throw new TypeError(`Property "${key}" is not an (x, y) pair.`);
}

/**
 * The center of an effect that works on the whole document (FX-BLUR-RADIAL-03, FX-BLUR-ZOOM-03), in
 * the region's pixels: the document center plus `Center` times half the document size. Undefined
 * sizes read as the input's own size, and an undefined origin reads as (0, 0).
 */
export function documentCenter(
  center: Vector2,
  width: number,
  height: number,
  document: EffectDocumentSize | undefined,
  regionOrigin: EffectRegionOrigin | undefined,
): Float32Array {
  const size = document ?? { width, height };
  const origin = regionOrigin ?? { x: 0, y: 0 };
  return Float32Array.of(
    size.width / 2 + (center.x * size.width) / 2 - origin.x,
    size.height / 2 + (center.y * size.height) / 2 - origin.y,
  );
}

/** The straight-alpha RGBA8 bytes of a surface, without a copy. */
export function surfaceBytes(input: Surface): Uint8Array {
  return new Uint8Array(input.data.buffer, input.data.byteOffset, input.data.byteLength);
}

/** The engine's straight-alpha RGBA8 output as a surface of the input's size. */
export function distortedSurface(input: Surface, bytes: Uint8Array): Surface {
  return new Surface(input.width, input.height, new Uint8ClampedArray(bytes));
}

/**
 * The sub-pixel offsets of one Quality level, as x, y pairs in pixels (FX-A-00-04 step 2). Quality
 * `q` gives `q²` samples. Requires the WASM kernels to be initialized.
 */
export function planDistortionOffsets(quality: number): Float32Array {
  return rgss_offsets(quality);
}

/**
 * The Rust reference of the distortion engine with an affine sample map. `matrix` is
 * `[a, b, c, d, e, f]`, with `x' = a x + c y + e` and `y' = b x + d y + f`.
 */
export function distortAffineCpu(
  input: Surface,
  matrix: readonly number[],
  quality: number,
  edge: EdgeBehavior,
): Surface {
  const out = distort_affine_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    quality,
    edgeBehaviorCode(edge),
    Float32Array.from(matrix),
  );
  return distortedSurface(input, out);
}
