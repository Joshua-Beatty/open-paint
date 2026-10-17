import { align_object_box, align_object_offset, align_object_rgba8 } from "@openpaint/cpu";
import type { Surface } from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
  resolveValues,
} from "@openpaint/properties";
import { distortedSurface, surfaceBytes } from "./distortion";
import type { EffectBinding } from "./framework/binding";

export const ALIGN_OBJECT_ID = "align-object";

/**
 * The positions in the engine's code order (FX-OBJ-ALIGN-04): the index is the code the Rust and
 * WGSL kernels take.
 */
export const ALIGN_POSITIONS = [
  "center",
  "topLeft",
  "bottomLeft",
  "topRight",
  "bottomRight",
  "middleLeft",
  "middleRight",
  "middleTop",
  "middleBottom",
  "left",
  "centerHorizontally",
  "right",
  "top",
  "centerVertically",
  "bottom",
  "original",
] as const;

export type AlignPosition = (typeof ALIGN_POSITIONS)[number];

/**
 * The positions in the dialog's order (FX-OBJ-ALIGN-02): the 3 x 3 grid row by row, then the
 * horizontal-only and vertical-only rows, then Original Position.
 */
export const ALIGN_POSITION_ORDER: readonly AlignPosition[] = [
  "topLeft",
  "middleTop",
  "topRight",
  "middleLeft",
  "center",
  "middleRight",
  "bottomLeft",
  "middleBottom",
  "bottomRight",
  "left",
  "centerHorizontally",
  "right",
  "top",
  "centerVertically",
  "bottom",
  "original",
];

/** The object box, with exclusive right and bottom edges, in the region's pixels. */
export interface ObjectBox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * The scan of the region, done once per session (FX-OBJ-ALIGN-09): its size, and the object box,
 * or null when nothing in the selection has an alpha above 0.
 */
export interface AlignObjectAnalysis {
  readonly width: number;
  readonly height: number;
  readonly box: ObjectBox | null;
}

/** Parameters of Align Object (FX-OBJ-ALIGN-01). */
export interface AlignObjectParams {
  readonly position: AlignPosition;
  /** Draws moved pixels opaque. Preview only: OK and Repeat always render it off. */
  readonly showFaintPixels: boolean;
  /**
   * The scan of the source, shared by both backends. Undefined when the parameters were read
   * without one, and the implementations then scan the input themselves.
   */
  readonly analysis?: AlignObjectAnalysis;
}

/** A frame with a small block at column `x` and row `y` (0 to 2) of it, on the 16 px icon grid. */
function blockIcon(x: number, y: number): string {
  const left = 4.5 + 2 * x;
  const top = 4.5 + 2 * y;
  return `M2.5 2.5h11v11h-11zM${left} ${top}h3v3h-3z`;
}

/** The icon of each position: a block in the frame, or arrows for one axis, or a return arrow. */
export const ALIGN_POSITION_ICONS: Readonly<Record<AlignPosition, string>> = {
  topLeft: blockIcon(0, 0),
  middleTop: blockIcon(1, 0),
  topRight: blockIcon(2, 0),
  middleLeft: blockIcon(0, 1),
  center: blockIcon(1, 1),
  middleRight: blockIcon(2, 1),
  bottomLeft: blockIcon(0, 2),
  middleBottom: blockIcon(1, 2),
  bottomRight: blockIcon(2, 2),
  left: "M2.5 3v10M13.5 8H5M8.5 4.5 5 8l3.5 3.5",
  centerHorizontally: "M8 2.5v11M1.5 8h4M3.5 6l2 2-2 2M14.5 8h-4M12.5 6l-2 2 2 2",
  right: "M13.5 3v10M2.5 8H11M7.5 4.5 11 8l-3.5 3.5",
  top: "M3 2.5h10M8 13.5V5M4.5 8.5 8 5l3.5 3.5",
  centerVertically: "M2.5 8h11M8 1.5v4M6 3.5l2 2 2-2M8 14.5v-4M6 12.5l2-2 2 2",
  bottom: "M3 13.5h10M8 2.5V11M4.5 7.5 8 11l3.5-3.5",
  original: "M2.5 6.5h7a3.5 3.5 0 0 1 0 7h-4M5 4 2.5 6.5 5 9",
};

/**
 * The positions as a 4 x 4 grid of buttons: the 3 x 3 block of both-axes positions at the bottom
 * left, the horizontal-only positions in the row above it, the vertical-only positions in the
 * column to its right, and Original Position in the corner between them.
 */
export const ALIGN_POSITION_GRID: readonly (readonly AlignPosition[])[] = [
  ["left", "centerHorizontally", "right", "original"],
  ["topLeft", "middleTop", "topRight", "top"],
  ["middleLeft", "center", "middleRight", "centerVertically"],
  ["bottomLeft", "middleBottom", "bottomRight", "bottom"],
];

/** The Align Object schema (FX-OBJ-ALIGN-01): Position as a grid of buttons, then Show faint pixels. */
export function alignObjectSchema(): PropertySchema {
  return definePropertySchema({
    properties: [
      {
        kind: "choice",
        key: "position",
        label: "property.position",
        // The default keeps the object where it is, so opening the dialog changes nothing until a
        // position is chosen, and Reset goes back to that.
        defaultValue: "original",
        options: ALIGN_POSITION_ORDER.map((value) => ({
          value,
          label: `alignPosition.${value}` as const,
          icon: ALIGN_POSITION_ICONS[value],
        })),
        control: {
          controlType: "radioButtons",
          dialogHelpMessage: "property.alignObjectHelp",
          choiceGrid: { rows: ALIGN_POSITION_GRID, gapAfterRows: [0], gapAfterColumns: [2] },
        },
      },
      {
        kind: "boolean",
        key: "showFaintPixels",
        label: "property.noCaption",
        defaultValue: false,
        control: {
          description: "property.showFaintPixels",
          footnote: "property.alignObjectNote",
        },
      },
    ],
  });
}

export function alignObjectDescriptor(): EffectDescriptor {
  return {
    id: ALIGN_OBJECT_ID,
    apiVersion: EXTENSION_API_MAJOR,
    label: "effect.alignObject",
    icon: "icon.alignObject",
    category: "effect",
    submenu: "object",
    configurable: true,
    kind: "gpuImage",
    schema: alignObjectSchema(),
    options: {
      // Detection and clipping use the same bi-level mask, and the effect masks itself
      // (FX-OBJ-ALIGN-08).
      forceAliasedSelection: true,
      disableSelectionClipping: true,
      previewOnlyProperties: ["showFaintPixels"],
      // Every open starts at Original Position, so opening never moves the object; Repeat still
      // runs the last confirmed position (FX-OBJ-ALIGN-10, owner decision).
      openAtDefaultProperties: ["position"],
      gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" },
    },
  };
}

/** The coverage bytes the kernels take: one per pixel, or none when every pixel is selected. */
function coverageBytes(coverage: ArrayLike<number> | undefined): Uint8Array {
  if (coverage === undefined) return new Uint8Array(0);
  return coverage instanceof Uint8Array ? coverage : Uint8Array.from(coverage);
}

/** Scans `input` for the object box (FX-OBJ-ALIGN-03). Requires the WASM kernels. */
export function analyzeAlignObject(
  input: Surface,
  coverage?: ArrayLike<number>,
): AlignObjectAnalysis {
  const found = align_object_box(
    surfaceBytes(input),
    input.width,
    input.height,
    coverageBytes(coverage),
  );
  const [x1, y1, x2, y2] = found;
  const box =
    x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined
      ? null
      : { x1, y1, x2, y2 };
  return { width: input.width, height: input.height, box };
}

/** Whether aligning changes nothing: no object, or an object box equal to the frame (FX-OBJ-ALIGN-06). */
export function alignObjectIsNoop(analysis: AlignObjectAnalysis): boolean {
  const { box } = analysis;
  return (
    box === null ||
    (box.x1 === 0 && box.y1 === 0 && box.x2 === analysis.width && box.y2 === analysis.height)
  );
}

/** The dialog's notice when there is nothing to align (FX-OBJ-ALIGN-06). */
export function alignObjectNotice(analysis: AlignObjectAnalysis): MessageId | undefined {
  if (analysis.box === null) return "effect.alignObject.noObject";
  return alignObjectIsNoop(analysis) ? "effect.alignObject.filled" : undefined;
}

/** Reads Align Object's parameters from property values (FX-FW-TOKEN-01). */
export function alignObjectParams(
  values: PropertyValues,
  analysis?: AlignObjectAnalysis,
): AlignObjectParams {
  const resolved = resolveValues(alignObjectSchema(), values);
  const position = ALIGN_POSITIONS.find((candidate) => candidate === resolved.position);
  return {
    position: position ?? "original",
    showFaintPixels: resolved.showFaintPixels === true,
    ...(analysis === undefined ? {} : { analysis }),
  };
}

/** The kernel code of a position: its index in `ALIGN_POSITIONS`. */
export function alignPositionCode(position: AlignPosition): number {
  return ALIGN_POSITIONS.indexOf(position);
}

/**
 * The scan the parameters carry, or a new one of `input` when they carry none. Throws when the
 * scan is of an image of another size.
 */
function analysisFor(
  input: Surface,
  params: AlignObjectParams,
  coverage: ArrayLike<number> | undefined,
): AlignObjectAnalysis {
  const analysis = params.analysis ?? analyzeAlignObject(input, coverage);
  if (analysis.width !== input.width || analysis.height !== input.height) {
    throw new RangeError(
      `The Align Object scan is ${analysis.width}x${analysis.height}, the input ${input.width}x${input.height}.`,
    );
  }
  return analysis;
}

/**
 * The translation the WGSL twin runs: the object box, how far it moves, and whether moved pixels
 * are drawn opaque. Null when the layer stays as it is. Requires the WASM kernels.
 */
export interface AlignObjectPlan {
  readonly box: ObjectBox;
  readonly dx: number;
  readonly dy: number;
  readonly faint: boolean;
}

export function planAlignObject(
  input: Surface,
  params: AlignObjectParams,
  coverage?: ArrayLike<number>,
): AlignObjectPlan | null {
  const analysis = analysisFor(input, params, coverage);
  const { box } = analysis;
  if (box === null || alignObjectIsNoop(analysis)) return null;
  const [dx = 0, dy = 0] = align_object_offset(
    box.x1,
    box.y1,
    box.x2,
    box.y2,
    input.width,
    input.height,
    alignPositionCode(params.position),
  );
  return { box, dx, dy, faint: params.showFaintPixels };
}

/**
 * The Rust reference of Align Object (FX-OBJ-ALIGN-05): returns the aligned `input` as a new
 * surface. `coverage` is the aliased selection, nonzero for selected pixels. Unselected pixels are
 * kept. Requires the WASM kernels.
 */
export function alignObjectCpu(
  input: Surface,
  params: AlignObjectParams,
  coverage?: ArrayLike<number>,
): Surface {
  const analysis = analysisFor(input, params, coverage);
  const { box } = analysis;
  if (box === null || alignObjectIsNoop(analysis)) return input.clone();
  const out = align_object_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    coverageBytes(coverage),
    box.x1,
    box.y1,
    box.x2,
    box.y2,
    alignPositionCode(params.position),
    params.showFaintPixels,
  );
  return distortedSurface(input, out);
}

/** The host binding of Align Object: its descriptor, scan, parameter reader and CPU reference. */
export function alignObjectBinding(): EffectBinding<AlignObjectParams, AlignObjectAnalysis> {
  return {
    descriptor: alignObjectDescriptor(),
    params: (values, _document, _seed, _origin, analysis) => alignObjectParams(values, analysis),
    analyze: analyzeAlignObject,
    notice: alignObjectNotice,
    unchanged: (params) =>
      (params.position === "original" && !params.showFaintPixels) ||
      (params.analysis !== undefined && alignObjectIsNoop(params.analysis)),
    cpu: alignObjectCpu,
  };
}
