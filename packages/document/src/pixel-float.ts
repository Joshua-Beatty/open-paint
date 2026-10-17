import { affineBounds, isIntegerTranslation, sameAffine, translationAffine } from "./affine";
import { type CoverageRuns, coverageRuns, placeByCoverage } from "./coverage-place";
import type { Document } from "./document";
import {
  intersectRects,
  isEmptyRect,
  type Point,
  type Rect,
  rect,
  rectContainsRect,
  rectsEqual,
  unionRects,
} from "./geometry";
import type { Layer } from "./layer";
import {
  renderTransformed,
  renderTransformedWith,
  type TransformedPixels,
  type TransformOptions,
  type TransformResampler,
} from "./pixel-transform";
import { Selection } from "./selection";
import {
  type AffineMatrix,
  rectPolygon,
  type SelectionPolygon,
  type SelectionQuality,
} from "./selection-polygons";
import { Surface } from "./surface";

/** What a floating session starts from. The document builds it in `liftSelectedPixels` and `pasteFloating`. */
export interface FloatingPlan {
  readonly document: Document;
  readonly layer: Layer;
  /** The floating content, straight RGBA. Its pixel (0, 0) is at `origin` before any transform. */
  readonly pixels: Surface;
  /**
   * The selection's coverage of the content, in the content's pixels. Where the content lands,
   * it replaces the layer by this coverage. Undefined covers the whole content.
   */
  readonly coverage?: Uint8Array;
  readonly origin: Point;
  /** The selection outline in the content's own coordinates, so it moves with the content. */
  readonly outline: readonly SelectionPolygon[];
  /** The canvas region the session covers. It starts at the content and grows as the content moves. */
  readonly area: Rect;
  /** The layer in `area` with the content taken out, as the content is drawn onto it. */
  readonly base: Surface;
  /** The layer in `area` as it is when the session starts. This is the state a cancel returns to. */
  readonly committed: Surface;
  /** The selection when the session starts. */
  readonly selection: Selection;
  /** The content's rotation anchor, in its own coordinates. Defaults to the content's center. */
  readonly anchor?: Point;
}

/**
 * A live "Move Selected Pixels" session on one layer (TL-MOVE-PIX-01). The content is drawn into the
 * layer on every preview, without history. Each committed step records one tile-level history item
 * that holds the layer before and after the step, and the selection moves with the content. An
 * edit that changes the document in any other way ends the session, since its layer state is then
 * out of date.
 */
export class FloatingPixels {
  readonly #document: Document;
  readonly #layer: Layer;
  readonly #pixels: Surface;
  readonly #coverage: Uint8Array | undefined;
  readonly #outline: readonly SelectionPolygon[];
  #area: Rect;
  #base: Surface;
  #committed: Surface;
  #savedBase: Surface | undefined;
  #transform: AffineMatrix;
  #committedTransform: AffineMatrix;
  #anchor: Point;
  #committedAnchor: Point;
  readonly #quality: SelectionQuality;
  #selection: Selection;
  #committedSelection: Selection;
  #options: TransformOptions = { sampling: "cubic", linearLight: true };
  #pending = false;
  #ended = false;
  #token: string;
  /** The outline as a selection at the content's own coordinates, made once. */
  #outlineSelection: Selection | undefined;
  /** The surface the last preview was drawn into, reused by the next one of the same size. */
  #scratch: Surface | undefined;
  /** The content's coverage runs, for placing it moved by whole pixels. Made on first use. */
  #runs: CoverageRuns | undefined;
  /** The shape the content covers, in its own coordinates, for transforms that resample it. */
  #shape: Selection | undefined;
  /**
   * Where, in canvas pixels, the layer may differ from the base: where the content was last shown.
   * Outside it the layer shows the base, so a preview redraws only this and the content's new place.
   */
  #onLayer: Rect;
  /** Resamples previews elsewhere (the GPU), when the host gave one (`setResampler`). */
  #resampler: TransformResampler | undefined;
  /** The resampled preview in flight. */
  #resampling: AbortController | undefined;
  /** Whether the transform changed while a resampled preview was in flight. */
  #resampleAgain = false;
  /**
   * Whether the layer shows the reference result (`transform_rgba8`) at the current transform.
   * A resampled preview is within ±1 of it, or an earlier frame, so a commit writes it first.
   */
  #exact = true;

  constructor(plan: FloatingPlan) {
    for (const surface of [plan.base, plan.committed]) {
      if (surface.width !== plan.area.width || surface.height !== plan.area.height) {
        throw new RangeError("The session surfaces must match its area.");
      }
    }
    this.#document = plan.document;
    this.#layer = plan.layer;
    this.#pixels = plan.pixels;
    if (
      plan.coverage !== undefined &&
      plan.coverage.length !== plan.pixels.width * plan.pixels.height
    ) {
      throw new RangeError("The coverage must match the content.");
    }
    this.#coverage = plan.coverage;
    this.#outline = plan.outline;
    this.#area = plan.area;
    this.#base = plan.base;
    this.#committed = plan.committed;
    this.#transform = translationAffine(plan.origin.x, plan.origin.y);
    this.#committedTransform = this.#transform;
    const anchor = plan.anchor ?? { x: plan.pixels.width / 2, y: plan.pixels.height / 2 };
    this.#anchor = anchor;
    this.#committedAnchor = anchor;
    this.#quality = plan.selection.quality;
    this.#selection = plan.selection;
    this.#committedSelection = plan.selection;
    this.#token = this.#historyToken();
    this.#onLayer = this.#contentBounds();
  }

  /** The layer the content is drawn on. */
  get layer(): Layer {
    return this.#layer;
  }

  /** The map from the content's coordinates to the canvas. */
  get transform(): AffineMatrix {
    return this.#transform;
  }

  /** The rotation anchor, in the content's coordinates. */
  get anchor(): Point {
    return this.#anchor;
  }

  /** The content's size in pixels, before any transform. */
  get size(): { readonly width: number; readonly height: number } {
    return { width: this.#pixels.width, height: this.#pixels.height };
  }

  /** The canvas rectangle the content covers at its current transform, before any clipping. */
  get bounds(): Rect {
    return affineBounds(this.#pixels.bounds, this.#transform);
  }

  /** True while changes are not yet committed (Dirty, TL-FRAME-01). */
  get pending(): boolean {
    return this.#pending;
  }

  /**
   * True while the session can still be used: it has not finished, its layer is still in the
   * document, and no undo, redo or other edit has happened since its last change.
   */
  get live(): boolean {
    return (
      !this.#ended &&
      this.#document.layers.includes(this.#layer) &&
      this.#document.selection === this.#selection &&
      this.#token === this.#historyToken()
    );
  }

  /**
   * Resamples the previews of transforms that are not whole-pixel moves with `resampler`, such as
   * the WGSL twin on the engine's GPU (L7): a preview then costs no resampling on this thread.
   * One runs at a time, and the newest transform follows when it lands. Commits keep the Rust
   * reference, so history is the same with or without it. A failure goes back to the reference.
   */
  setResampler(resampler: TransformResampler | undefined): void {
    this.#resampler = resampler;
  }

  /** Draws the content at `m`, and resamples it with `options`. Nothing is recorded. */
  preview(m: AffineMatrix, options: TransformOptions = this.#options): boolean {
    if (!this.live) return false;
    this.#options = options;
    this.#transform = m;
    this.#pending = true;
    this.#paint();
    return true;
  }

  /** Moves the rotation anchor. The anchor is not drawn, so nothing changes on the canvas. */
  setAnchor(anchor: Point): boolean {
    if (!this.live) return false;
    this.#anchor = anchor;
    this.#pending = true;
    return true;
  }

  /**
   * Copies the content into the base at its current transform, so the content can move away and
   * leave a copy behind (TL-MOVE-PIX-01 Ctrl). A later `cancel` puts the base back.
   */
  stamp(): boolean {
    if (!this.live) return false;
    this.#growToContent();
    const drawn = this.#compose();
    this.#savedBase ??= this.#base;
    this.#base = drawn;
    this.#pending = true;
    return true;
  }

  /**
   * Records the pending changes as one history item named `name`. Returns false when nothing is
   * pending or the session is no longer live.
   */
  commit(name: string): boolean {
    if (!this.live || !this.#pending) return false;
    this.#record(name);
    return true;
  }

  /**
   * Records one history item named `name`, even when nothing changed, and ends the session. This is
   * the "Finish" of the tool (TL-FRAME-01).
   */
  finish(name: string): boolean {
    if (!this.live) return false;
    this.#record(name);
    this.#ended = true;
    return true;
  }

  /** Drops the uncommitted changes (Enter or Esc while a drag is in progress). Nothing is recorded. */
  cancel(): boolean {
    if (!this.live) return false;
    if (!this.#pending) return true;
    this.#base = this.#savedBase ?? this.#base;
    this.#savedBase = undefined;
    this.#transform = this.#committedTransform;
    this.#anchor = this.#committedAnchor;
    this.#pending = false;
    this.#stopResampling();
    this.#exact = true;
    this.#document.restoreLayerPixels(this.#layer, (pixels) => {
      pixels.writeRegion(this.#committed, this.#area.x, this.#area.y);
    });
    this.#onLayer = this.#contentBounds();
    this.#selection = this.#committedSelection;
    this.#document.restoreSelection(this.#committedSelection);
    return true;
  }

  /** The selection the content has at `m`: the outline moved with the content. */
  #selectionAt(m: AffineMatrix): Selection {
    this.#outlineSelection ??= new Selection(this.#outline, this.#quality);
    return this.#outlineSelection.transform(m).commit();
  }

  #setSelection(selection: Selection): void {
    this.#selection = selection;
    this.#document.previewSelection(selection);
  }

  /**
   * Shows the content at the current transform. Only the part of the area where the layer can
   * change is drawn and written: where the content was shown, and where it is now. Outside both,
   * the layer already shows the base. The preview is drawn into a scratch surface that is kept
   * between previews of the same size, since a drag of a large selection redraws it every frame.
   */
  #paint(): void {
    this.#growToContent();
    if (this.#resampler !== undefined && this.#resamples()) {
      this.#setSelection(this.#selectionAt(this.#transform));
      this.#requestResample();
      return;
    }
    this.#stopResampling();
    this.#exact = true;
    const next = this.#contentBounds();
    const changed = intersectRects(joinRects(this.#onLayer, next), this.#area);
    this.#onLayer = next;
    if (!isEmptyRect(changed)) {
      let drawn: Surface;
      if (this.#savedBase === undefined && sameAffine(this.#transform, this.#committedTransform)) {
        drawn = new Surface(changed.width, changed.height);
        drawn.copyFrom(this.#committed, this.#local(changed), 0, 0);
      } else {
        const scratch = this.#scratch;
        const fits = scratch?.width === changed.width && scratch.height === changed.height;
        drawn = this.#compose(changed, fits ? scratch : undefined);
        this.#scratch = drawn;
      }
      this.#document.previewLayerPixels(this.#layer, (pixels) => {
        pixels.writeRegion(drawn, changed.x, changed.y);
      });
    }
    this.#setSelection(this.#selectionAt(this.#transform));
  }

  /** Whether a preview at the current transform resamples the content. */
  #resamples(): boolean {
    if (isIntegerTranslation(this.#transform)) return false;
    return !(
      this.#savedBase === undefined && sameAffine(this.#transform, this.#committedTransform)
    );
  }

  /** Starts a resampled preview of the current transform, or marks it to follow the one in flight. */
  #requestResample(): void {
    const resampler = this.#resampler;
    if (resampler === undefined) return;
    if (this.#resampling !== undefined) {
      this.#resampleAgain = true;
      return;
    }
    const controller = new AbortController();
    this.#resampling = controller;
    const m = this.#transform;
    const options = this.#options;
    renderTransformedWith(
      resampler,
      this.#pixels,
      m,
      options,
      this.#contentBounds(),
      controller.signal,
    ).then(
      (drawn) => this.#showResampled(controller, m, drawn),
      () => {
        if (this.#resampling !== controller) return;
        this.#resampling = undefined;
        if (controller.signal.aborted) return;
        // The resampler failed: this session previews with the reference from now on.
        this.#resampler = undefined;
        this.#resampleAgain = false;
        if (this.live && this.#pending) this.#paint();
      },
    );
  }

  /**
   * Shows a resampled preview at the transform it was made for, even when the drag moved on, since
   * an earlier frame shows more than none. The newest transform is then requested.
   */
  #showResampled(
    controller: AbortController,
    m: AffineMatrix,
    drawn: TransformedPixels | undefined,
  ): void {
    if (this.#resampling !== controller) return;
    this.#resampling = undefined;
    const again = this.#resampleAgain || !sameAffine(m, this.#transform);
    this.#resampleAgain = false;
    if (controller.signal.aborted || !this.live || !this.#pending) return;
    const next = this.#contentBounds(m);
    const changed = intersectRects(joinRects(this.#onLayer, next), this.#area);
    this.#onLayer = next;
    if (!isEmptyRect(changed)) {
      const scratch = this.#scratch;
      const fits = scratch?.width === changed.width && scratch.height === changed.height;
      const out = this.#compose(changed, fits ? scratch : undefined, m, drawn ?? null);
      this.#scratch = out;
      this.#document.previewLayerPixels(this.#layer, (pixels) => {
        pixels.writeRegion(out, changed.x, changed.y);
      });
    }
    this.#exact = false;
    if (again) this.#paint();
  }

  #stopResampling(): void {
    this.#resampling?.abort();
    this.#resampling = undefined;
    this.#resampleAgain = false;
  }

  /** The canvas pixels the content covers at `m` (the current transform), on the layer. */
  #contentBounds(m: AffineMatrix = this.#transform): Rect {
    return intersectRects(affineBounds(this.#pixels.bounds, m), this.#layer.pixels.bounds);
  }

  /** `r`, in canvas pixels, in the coordinates of the area's surfaces. */
  #local(r: Rect): Rect {
    return rect(r.x - this.#area.x, r.y - this.#area.y, r.width, r.height);
  }

  #record(name: string): void {
    this.#stopResampling();
    const drawn = this.#renderArea();
    const area = this.#area;
    const committed = this.#committed;
    if (!this.#exact) {
      // The layer shows a resampled preview: the reference result replaces it before it is recorded.
      this.#document.previewLayerPixels(this.#layer, (pixels) => {
        pixels.writeRegion(drawn, area.x, area.y);
      });
      this.#exact = true;
    }
    const selection = this.#selectionAt(this.#transform);
    // The item's "before" selection is the committed one, not the preview left on screen.
    this.#document.restoreSelection(this.#committedSelection);
    // The last preview drew the area at the current transform, so the layer already shows `drawn`:
    // the item is recorded as it is, with the committed state before it (L9).
    this.#document.recordLayerPixels(name, this.#layer, area, committed, selection);
    this.#committed = drawn;
    this.#onLayer = this.#contentBounds();
    this.#committedTransform = this.#transform;
    this.#committedAnchor = this.#anchor;
    this.#committedSelection = selection;
    this.#selection = selection;
    this.#savedBase = undefined;
    this.#pending = false;
    this.#token = this.#historyToken();
  }

  /**
   * The area's pixels as the session should show them. At the committed transform, with no copy
   * pending, that is exactly the committed state. Placing the content again would lighten the
   * antialiased edges of a lifted selection, since the lift splits their alpha between two parts.
   */
  #renderArea(): Surface {
    this.#growToContent();
    if (this.#savedBase === undefined && sameAffine(this.#transform, this.#committedTransform)) {
      return this.#committed.clone();
    }
    return this.#compose();
  }

  #growToContent(): void {
    this.#grow(this.#contentBounds());
  }

  /**
   * The part `region` of the area (canvas pixels, the whole area by default) with the content
   * placed on the base at the current transform, into `out` when given (the size of `region`).
   * Inside the moved selection the content replaces the base, transparent pixels included, and
   * its antialiased edge blends by coverage (`placeByCoverage`). The area must cover the content.
   * A whole-pixel move places the content straight from its own pixels by its coverage runs, since
   * nothing needs resampling. Any other transform resamples the content and covers it with the
   * moved selection shape.
   */
  #compose(
    region: Rect = this.#area,
    out?: Surface,
    m: AffineMatrix = this.#transform,
    resampled?: TransformedPixels | null,
  ): Surface {
    const result = out ?? new Surface(region.width, region.height);
    if (rectsEqual(region, this.#area)) result.data.set(this.#base.data);
    else result.copyFrom(this.#base, this.#local(region), 0, 0);
    if (isIntegerTranslation(m)) {
      const { width, height } = this.#pixels;
      this.#runs ??= coverageRuns(width, height, this.#coverage);
      const dx = m.e - region.x;
      const dy = m.f - region.y;
      placeByCoverage(result, this.#pixels, dx, dy, this.#coverage, this.#runs);
      return result;
    }
    // `resampled` is the content already resampled within the content bounds (null: none landed).
    const drawn =
      resampled === undefined
        ? renderTransformed(this.#pixels, m, this.#options, region)
        : (resampled ?? undefined);
    if (drawn) {
      const { x, y } = drawn.origin;
      const covered = rect(x, y, drawn.pixels.width, drawn.pixels.height);
      const coverage = this.#coverageShape().transform(m).mask(covered);
      placeByCoverage(result, drawn.pixels, x - region.x, y - region.y, coverage);
    }
    return result;
  }

  /** The selection outline, or the content's bounds when nothing was selected, as one shape. */
  #coverageShape(): Selection {
    this.#shape ??= new Selection(
      this.#outline.length > 0 ? this.#outline : [rectPolygon(this.#pixels.bounds)],
      this.#quality,
    );
    return this.#shape;
  }

  /**
   * Extends the session area to cover `wanted`. Pixels outside the old area are still the layer's
   * original pixels, because the session only ever writes inside its area.
   */
  #grow(wanted: Rect): void {
    if (isEmptyRect(wanted) || rectContainsRect(this.#area, wanted)) return;
    const old = this.#area;
    const next = unionRects(old, wanted);
    const regrow = (surface: Surface): Surface => {
      const grown = this.#layer.pixels.readRegion(next);
      grown.copyFrom(surface, surface.bounds, old.x - next.x, old.y - next.y);
      return grown;
    };
    this.#base = regrow(this.#base);
    this.#committed = regrow(this.#committed);
    if (this.#savedBase) this.#savedBase = regrow(this.#savedBase);
    this.#area = next;
  }

  #historyToken(): string {
    const history = this.#document.history;
    return [
      history.appliedCommands.length,
      history.undoneCommands.length,
      history.undoName ?? "",
    ].join("|");
  }
}

/**
 * The layer's pixels with a lift taken out: each pixel keeps the alpha its selection coverage
 * leaves behind, so the vacated area becomes transparent and an antialiased edge keeps the part of
 * its alpha outside the selection.
 */
export function remainingAfterLift(pixels: Surface, coverage: Uint8Array | undefined): Surface {
  const remaining = pixels.clone();
  const data = remaining.data;
  if (coverage === undefined) {
    // Everything is lifted: only the alpha bytes change, four bytes at a time.
    const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    const keep = LITTLE_ENDIAN ? 0x00ffffff : 0xffffff00;
    for (let i = 0; i < words.length; i++) words[i] = (words[i] as number) & keep;
    return remaining;
  }
  for (let i = 0; i < coverage.length; i++) {
    const c = coverage[i] ?? 0;
    if (c === 0) continue;
    if (c === 255) {
      data[i * 4 + 3] = 0;
      continue;
    }
    const alpha = data[i * 4 + 3] ?? 0;
    data[i * 4 + 3] = alpha - Math.round((alpha * c) / 255);
  }
  return remaining;
}

/** Whether a `Uint32Array` reads RGBA bytes with red in its low byte. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** The union of two rectangles, where an empty one adds nothing. */
function joinRects(a: Rect, b: Rect): Rect {
  if (isEmptyRect(a)) return b;
  if (isEmptyRect(b)) return a;
  return unionRects(a, b);
}
