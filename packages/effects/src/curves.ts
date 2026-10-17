import { curve_lut, curves_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import type { EffectDescriptor } from "@openpaint/extension-api";
import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValue,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import {
  type AdjustmentPlan,
  adjustmentDescriptor,
  bytesOf,
  CURVE_LUT_SIZE,
  CURVE_TABLES,
  identityPlan,
  rgbaSurface,
} from "./adjustments";
import type { EffectBinding } from "./framework/binding";

export const CURVES_ID = "curves";
/** The custom dialog that edits Curves, registered by the UI (ADJ-CURVES-UI, EXT-V1-02). */
export const CURVES_DIALOG_ID = "curves";
/** The op codes of the WGSL twin for the luminosity and the RGB Curves (`ADJUSTMENTS_WGSL`). */
export const CURVES_LUMINOSITY_OP = 8;
export const CURVES_RGB_OP = 9;

/** The transfer mode of Curves (ADJ-CURVES-UI-02). */
export type CurveMode = "luminosity" | "rgb";
/** One control point, x and y as integers on 0..255 (ADJ-CURVES-MATH-01). */
export type CurvePoint = readonly [number, number];
/** The control points of one curve, sorted by x with unique x. */
export type CurveList = readonly CurvePoint[];

/** Curves parameters (ADJ-CURVES-MATH-01). Each mode reads only its own curves. */
export interface CurvesParams {
  readonly mode: CurveMode;
  readonly luminosity: CurveList;
  readonly red: CurveList;
  readonly green: CurveList;
  readonly blue: CurveList;
}

/** The default curve, the identity {(0, 0), (255, 255)}. */
export const CURVE_IDENTITY: CurveList = [
  [0, 0],
  [255, 255],
];

const POINT_PATTERN = /^(\d{1,3}),(\d{1,3})$/;

/** A curve as the settings store holds it: `x,y` pairs separated by spaces. */
export function encodeCurve(points: CurveList): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

/**
 * Reads a stored curve (ADJ-COMMON-07). A value with any malformed pair, a repeated x or no point
 * falls back to the identity. The points come back sorted by x.
 */
export function decodeCurve(text: string): CurveList {
  const points: CurvePoint[] = [];
  for (const token of text.trim().split(/\s+/)) {
    const match = POINT_PATTERN.exec(token);
    if (match === null) return CURVE_IDENTITY;
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (x > 255 || y > 255) return CURVE_IDENTITY;
    points.push([x, y]);
  }
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0 || new Set(sorted.map(([x]) => x)).size !== sorted.length) {
    return CURVE_IDENTITY;
  }
  return sorted;
}

type CurveKey = "luminosity" | "red" | "green" | "blue";

function curveProperty(key: CurveKey, label: `curves.channel.${CurveKey}`) {
  return {
    kind: "string" as const,
    key,
    label,
    defaultValue: encodeCurve(CURVE_IDENTITY),
  };
}

/**
 * The Curves schema: the mode, and one stored point list per curve. Only the active mode's lists
 * are written (ADJ-CURVES-UI-02), and the custom dialog edits them.
 */
export function curvesSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "choice",
        key: "mode",
        label: "curves.group.transferMap",
        defaultValue: "luminosity",
        options: [
          { value: "luminosity", label: "curves.mode.luminosity" },
          { value: "rgb", label: "curves.mode.rgb" },
        ],
      },
      curveProperty("luminosity", "curves.channel.luminosity"),
      curveProperty("red", "curves.channel.red"),
      curveProperty("green", "curves.channel.green"),
      curveProperty("blue", "curves.channel.blue"),
    ],
  });
}

/** Curves: an adjustment with a custom dialog, so the menu item ends in "..." (ADJ-MENU-03). */
export function curvesDescriptor(): EffectDescriptor {
  return {
    ...adjustmentDescriptor(CURVES_ID, "effect.curves", "icon.curves", true, curvesSchema()),
    customDialog: CURVES_DIALOG_ID,
  };
}

function listOf(value: PropertyValue | undefined): CurveList {
  return typeof value === "string" ? decodeCurve(value) : CURVE_IDENTITY;
}

/** Reads the Curves parameters from property values, falling back to the defaults (FX-FW-TOKEN-01). */
export function curvesParams(values: PropertyValues): CurvesParams {
  const resolved = resolveValues(curvesSchema(), values);
  return {
    mode: resolved.mode === "rgb" ? "rgb" : "luminosity",
    luminosity: listOf(resolved.luminosity),
    red: listOf(resolved.red),
    green: listOf(resolved.green),
    blue: listOf(resolved.blue),
  };
}

/**
 * The property values to store and preview. Only the active mode's curves keep their points, and
 * the other curves are stored as the identity (ADJ-CURVES-UI-02).
 */
export function curvesValues(params: CurvesParams): PropertyValues {
  const rgb = params.mode === "rgb";
  return {
    mode: params.mode,
    luminosity: encodeCurve(rgb ? CURVE_IDENTITY : params.luminosity),
    red: encodeCurve(rgb ? params.red : CURVE_IDENTITY),
    green: encodeCurve(rgb ? params.green : CURVE_IDENTITY),
    blue: encodeCurve(rgb ? params.blue : CURVE_IDENTITY),
  };
}

/** The 1024-entry lookup table of one curve, from the Rust reference (ADJ-CURVES-MATH-02). */
export function curveLut(points: CurveList): Float32Array {
  return curve_lut(Uint8Array.from(points.flat()));
}

/**
 * The output of a curve table at input `t` on 0..1, interpolated as the kernel does. The curve
 * editor samples its drawn lines with it.
 */
export function curveValueAt(lut: ArrayLike<number>, t: number): number {
  const pos = Math.min(Math.max(t, 0), 1) * (CURVE_LUT_SIZE - 1);
  const i = Math.min(Math.floor(pos), CURVE_LUT_SIZE - 2);
  const a = lut[i] ?? 0;
  const b = lut[i + 1] ?? 0;
  return a + (b - a) * (pos - i);
}

/** The Curves tables of a plan: luminosity, red, green and blue, `CURVE_LUT_SIZE` entries each. */
export function curvesTables(params: CurvesParams): Float32Array {
  const tables = new Float32Array(CURVE_TABLES * CURVE_LUT_SIZE);
  [params.luminosity, params.red, params.green, params.blue].forEach((points, table) => {
    tables.set(curveLut(points), table * CURVE_LUT_SIZE);
  });
  return tables;
}

/** The plan of the WGSL twin for Curves: the same tables as the Rust reference. */
export function curvesPlan(params: CurvesParams): AdjustmentPlan {
  const op = params.mode === "rgb" ? CURVES_RGB_OP : CURVES_LUMINOSITY_OP;
  return { ...identityPlan(op), curves: curvesTables(params) };
}

/** The Rust reference of Curves (ADJ-CURVES-MATH-03, -04). The input is not modified. */
export function curvesCpu(input: Surface, params: CurvesParams): Surface {
  return rgbaSurface(
    input,
    curves_rgba8(bytesOf(input), params.mode === "rgb", curvesTables(params)),
  );
}

/** The host binding of Curves: its descriptor, parameter reader and CPU reference. */
export function curvesBinding(): EffectBinding<CurvesParams> {
  return {
    descriptor: curvesDescriptor(),
    params: curvesParams,
    cpu: (input, params) => curvesCpu(input, params),
  };
}
