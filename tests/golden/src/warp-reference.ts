import type { Surface } from "@openpaint/document";
import {
  type BulgeParams,
  bulgeCpu,
  bulgePlan,
  type CrystalizeParams,
  crystalizeCpu,
  crystalizePlan,
  type DentsParams,
  dentsCpu,
  dentsPlan,
  type EdgeBehavior,
  type PolarInversionParams,
  polarInversionCpu,
  polarInversionPlan,
  type TileReflectionParams,
  type TwistParams,
  tileReflectionCpu,
  tileReflectionPlan,
  twistCpu,
  twistPlan,
} from "@openpaint/effects";
import type {
  BulgeCase,
  CrystalizeCase,
  DentsCase,
  PolarCase,
  TileCase,
  TwistCase,
  WarpCase,
} from "./cases";

/** The parameters of a Bulge case, as the binding reads them. */
export function bulgeParamsOf(kase: BulgeCase): BulgeParams {
  return {
    bulge: kase.bulge,
    center: { x: kase.center[0], y: kase.center[1] },
    edge: kase.edge,
    quality: kase.quality,
  };
}

/** The parameters of a Twist case, as the binding reads them. */
export function twistParamsOf(kase: TwistCase): TwistParams {
  return {
    amount: kase.amount,
    size: kase.size,
    center: { x: kase.center[0], y: kase.center[1] },
    quality: kase.quality,
    document: kase.document,
  };
}

/** The parameters of a Polar Inversion case, as the binding reads them. */
export function polarParamsOf(kase: PolarCase): PolarInversionParams {
  return {
    scale: kase.scale,
    offset: { x: kase.offset[0], y: kase.offset[1] },
    edge: kase.edge,
    quality: kase.quality,
    document: kase.document,
  };
}

/** The parameters of a Tile Reflection case, as the binding reads them. */
export function tileParamsOf(kase: TileCase): TileReflectionParams {
  return {
    angle: kase.angle,
    tileSize: kase.tileSize,
    curvature: kase.curvature,
    edge: kase.edge,
    quality: kase.quality,
    document: kase.document,
    regionOrigin: { x: kase.origin[0], y: kase.origin[1] },
  };
}

/** The parameters of a Crystalize case, as the binding reads them. */
export function crystalizeParamsOf(kase: CrystalizeCase): CrystalizeParams {
  return {
    cellSize: kase.cellSize,
    quality: kase.quality,
    userSeed: kase.userSeed,
    instanceSeed: kase.instanceSeed,
  };
}

/** The parameters of a Dents case, as the binding reads them. */
export function dentsParamsOf(kase: DentsCase): DentsParams {
  return {
    scale: kase.scale,
    refraction: kase.refraction,
    detail: kase.detail,
    turbulence: kase.turbulence,
    angle: kase.angle,
    quality: kase.quality,
    userSeed: kase.userSeed,
    instanceSeed: kase.instanceSeed,
  };
}

/** The Rust reference of a warp case over `input`. */
export function warpReference(kase: WarpCase, input: Surface): Surface {
  switch (kase.kind) {
    case "bulge":
      return bulgeCpu(input, bulgeParamsOf(kase));
    case "twist":
      return twistCpu(input, twistParamsOf(kase));
    case "polar":
      return polarInversionCpu(input, polarParamsOf(kase));
    case "tile":
      return tileReflectionCpu(input, tileParamsOf(kase));
    case "crystalize":
      return crystalizeCpu(input, crystalizeParamsOf(kase));
    case "dents":
      return dentsCpu(input, dentsParamsOf(kase));
  }
}

/** The sample-map plan that the WGSL twin reads for a case over a `width` × `height` input. */
export function warpPlanOf(kase: WarpCase, width: number, height: number): Float32Array {
  switch (kase.kind) {
    case "bulge":
      return bulgePlan(bulgeParamsOf(kase), width, height);
    case "twist":
      return twistPlan(twistParamsOf(kase), width, height);
    case "polar":
      return polarInversionPlan(polarParamsOf(kase), width, height);
    case "tile":
      return tileReflectionPlan(tileParamsOf(kase), width, height);
    case "crystalize":
      return crystalizePlan(crystalizeParamsOf(kase));
    case "dents":
      return dentsPlan(dentsParamsOf(kase), width, height);
  }
}

/**
 * The edge mode of a case: Bulge's, Polar's and Tile's own, Clamp for Twist and Crystalize, and
 * Reflect for Dents.
 */
export function warpEdgeOf(kase: WarpCase): EdgeBehavior {
  switch (kase.kind) {
    case "bulge":
    case "polar":
    case "tile":
      return kase.edge;
    case "twist":
    case "crystalize":
      return "clamp";
    case "dents":
      return "reflect";
  }
}
