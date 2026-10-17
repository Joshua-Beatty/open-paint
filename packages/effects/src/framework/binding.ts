import type { Rect, Selection, Surface } from "@openpaint/document";
import type { EffectDescriptor } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import type { ColorValue, PropertySchema, PropertyValues } from "@openpaint/properties";

/** The primary and secondary colors, in the document's color space (FX-FW-ENV-01). */
export interface EffectColors {
  readonly primary: ColorValue;
  readonly secondary: ColorValue;
}

/** The size of the document an effect runs in, in pixels. */
export interface EffectDocumentSize {
  readonly width: number;
  readonly height: number;
}

/** The top-left corner of the region an effect runs over, in document pixels. */
export interface EffectRegionOrigin {
  readonly x: number;
  readonly y: number;
}

/**
 * The resource key of the live thumbnail of the whole layer under a pan control, for the effects
 * that center on the document rather than the selection (FX-A-00-02e). The host resolves it to the
 * layer as it was when the effect opened.
 */
export const LAYER_UNDERLAY_KEY = "effect.layer";

/**
 * The host-side half of one effect: its registry descriptor (metadata, schema, kind) and the code
 * that computes it (FX-FW-REG-01). The menus, dialogs and Repeat read the descriptor. The runtime
 * reads the binding for the computation. Methods (not properties) keep bindings of different
 * parameter types in one list.
 */
export interface EffectBinding<P = unknown, A = unknown> {
  readonly descriptor: EffectDescriptor;
  /**
   * Reads the parameters from property values, clamped to the schema (FX-FW-TOKEN-01). `document`
   * is the size of the document being edited, for the effects that scale by it (FX-DIST-TWIST-03).
   * `instanceSeed` is the effect instance's seed (FX-A-00-05), which the seeded effects combine with
   * their Seed. Undefined reads as 0. `regionOrigin` is where the region sits in the document, for
   * the effects that center on the whole layer (FX-DIST-TILE-03). Undefined reads as (0, 0).
   * `analysis` is the result of `analyze` for this session, when the binding has one.
   */
  params(
    values: PropertyValues,
    document?: EffectDocumentSize,
    instanceSeed?: number,
    regionOrigin?: EffectRegionOrigin,
    analysis?: A,
  ): P;
  /**
   * Scans the source once per session, before the first render, for what every render shares,
   * such as Align Object's object box (FX-OBJ-ALIGN-09). It reads the pixels as they were when the
   * session opened and the selection over them (undefined when every pixel is selected). Changing a
   * value does not scan again. Repeat opens a new session, so it scans again.
   */
  analyze?(pixels: Surface, coverage: Uint8Array | undefined): A;
  /** An inline notice for the dialog about this source, such as "nothing to align". */
  notice?(analysis: A): MessageId | undefined;
  /**
   * Whether these parameters leave the layer exactly as it is. The session then writes nothing,
   * and OK records no history step (FX-OBJ-ALIGN-06).
   */
  unchanged?(params: P): boolean;
  /**
   * The selection once the effect is applied, for an effect that moves the selected pixels and
   * their outline with them (FX-OBJ-FLIP-03). `selection` is the document's selection and `region`
   * the area the effect rendered. The session records it with the pixels as one history item, so
   * undo restores both. Undefined keeps the selection.
   */
  selectionAfter?(selection: Selection, region: Rect, params: P): Selection;
  /**
   * The dialog's schema, when a default depends on the primary and secondary colors (FX-FW-TOKEN-01).
   * The runtime calls it when the dialog opens, so the defaults use the colors at that time.
   * Undefined uses the descriptor's schema.
   */
  dialogSchema?(colors: EffectColors): PropertySchema;
  /**
   * The CPU implementation, which is the reference (WEB-GPU-03). `coverage` is the selection over
   * the input, 0-255, when a selection limits the effect. Analysis such as a histogram reads only
   * the covered pixels (ADJ-COMMON-05). The framework still clips the output by coverage.
   */
  cpu(input: Surface, params: P, coverage?: ArrayLike<number>): Surface;
  /**
   * The WebGPU implementation, when the engine supplies one (WEB-GPU-01). Omitted, or when it
   * throws, the CPU implementation runs instead (WEB-GPU-04). `coverage` as for `cpu`.
   */
  gpu?(input: Surface, params: P, coverage?: ArrayLike<number>): Promise<Surface>;
}
