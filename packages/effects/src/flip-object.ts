import { flip_object_rgba8 } from "@openpaint/cpu";
import {
  type AffineMatrix,
  type Rect,
  rectPolygon,
  type Selection,
  type Surface,
} from "@openpaint/document";
import { type EffectDescriptor, EXTENSION_API_MAJOR } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import { definePropertySchema } from "@openpaint/properties";
import { distortedSurface, surfaceBytes } from "./distortion";
import type { EffectBinding } from "./framework/binding";

export const FLIP_HORIZONTAL_ID = "flip-horizontal";
export const FLIP_VERTICAL_ID = "flip-vertical";

/** Parameters of Flip Horizontal and Flip Vertical: only the axis, fixed per effect (FX-OBJ-FLIP-01). */
export interface FlipObjectParams {
  /** True mirrors top to bottom (Flip Vertical), false left to right (Flip Horizontal). */
  readonly vertical: boolean;
}

function flipDescriptor(id: string, label: MessageId, icon: string): EffectDescriptor {
  return {
    id,
    apiVersion: EXTENSION_API_MAJOR,
    label,
    icon,
    category: "effect",
    submenu: "object",
    configurable: false,
    kind: "gpuImage",
    schema: definePropertySchema({ properties: [] }),
    options: {
      // The kernel lifts and drops by the selection's coverage itself, and writes inside the
      // selection's bounding box, where the mirrored selection lands (FX-OBJ-FLIP-03).
      disableSelectionClipping: true,
      gpu: { workingSpace: "document", inputAlpha: "straight", outputAlpha: "straight" },
    },
  };
}

export function flipHorizontalDescriptor(): EffectDescriptor {
  return flipDescriptor(FLIP_HORIZONTAL_ID, "effect.flipHorizontal", "icon.flipHorizontal");
}

export function flipVerticalDescriptor(): EffectDescriptor {
  return flipDescriptor(FLIP_VERTICAL_ID, "effect.flipVertical", "icon.flipVertical");
}

/** The coverage bytes the kernel takes: one per pixel, or none when every pixel is selected. */
function coverageBytes(coverage: ArrayLike<number> | undefined): Uint8Array {
  if (coverage === undefined) return new Uint8Array(0);
  return coverage instanceof Uint8Array ? coverage : Uint8Array.from(coverage);
}

/**
 * The Rust reference of Flip (FX-OBJ-FLIP-02 to 04): the selected pixels of `input` mirrored about
 * its centre line, as a new surface. `input` is the selection's bounding box, and `coverage` the
 * selection over it (undefined: everything). Requires the WASM kernels.
 */
export function flipObjectCpu(
  input: Surface,
  params: FlipObjectParams,
  coverage?: ArrayLike<number>,
): Surface {
  const out = flip_object_rgba8(
    surfaceBytes(input),
    input.width,
    input.height,
    coverageBytes(coverage),
    params.vertical,
  );
  return distortedSurface(input, out);
}

/** The mirror across `region`'s vertical (or, with `vertical`, horizontal) centre line. */
export function flipMatrix(region: Rect, vertical: boolean): AffineMatrix {
  return vertical
    ? { a: 1, b: 0, c: 0, d: -1, e: 0, f: 2 * region.y + region.height }
    : { a: -1, b: 0, c: 0, d: 1, e: 2 * region.x + region.width, f: 0 };
}

/**
 * The selection after a flip over `region` (FX-OBJ-FLIP-03): the outline mirrored with the pixels,
 * so it covers exactly what landed. Mirroring a pixel's square maps it onto its mirror's square, so
 * the new outline's coverage is the old coverage remapped as the pixels were. A part outside
 * `region` (off the canvas) is dropped first, since no pixels move there. Nothing selected stays so.
 */
export function flipSelection(selection: Selection, region: Rect, vertical: boolean): Selection {
  if (selection.isEmpty) return selection;
  const bounds = selection.bounds();
  const sameBox =
    bounds.x === region.x &&
    bounds.y === region.y &&
    bounds.width === region.width &&
    bounds.height === region.height;
  // A solid rectangle is its own mirror.
  if (sameBox && selection.coversRect(region)) return selection;
  const inside = sameBox ? selection : selection.combine([rectPolygon(region)], "intersect");
  return inside.transform(flipMatrix(region, vertical)).commit();
}

function flipBinding(
  descriptor: EffectDescriptor,
  vertical: boolean,
): EffectBinding<FlipObjectParams> {
  return {
    descriptor,
    params: () => ({ vertical }),
    cpu: flipObjectCpu,
    selectionAfter: (selection, region, params) =>
      flipSelection(selection, region, params.vertical),
  };
}

/** The host binding of Flip Horizontal: mirrors the selection left to right, pixels and outline. */
export function flipHorizontalBinding(): EffectBinding<FlipObjectParams> {
  return flipBinding(flipHorizontalDescriptor(), false);
}

/** The host binding of Flip Vertical: mirrors the selection top to bottom, pixels and outline. */
export function flipVerticalBinding(): EffectBinding<FlipObjectParams> {
  return flipBinding(flipVerticalDescriptor(), true);
}
