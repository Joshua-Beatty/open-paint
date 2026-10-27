import { affineBounds, isIntegerTranslation, sameAffine, translationAffine } from "./affine";
import type { Document } from "./document";
import type { FloatBase, FloatContent, FloatPlacement } from "./float-preview";
import {
  composeFloating,
  type FloatingComposeJob,
  type FloatingComposeResult,
  type FloatingComposer,
  FloatingSource,
  type FloatingStep,
} from "./floating-compose";
import {
  intersectRects,
  isEmptyRect,
  type Point,
  type Rect,
  rect,
  rectContainsRect,
  unionRects,
} from "./geometry";
import type { ToolStep } from "./history/history";
import type { Layer } from "./layer";
import {
  renderTransformedWith,
  type TransformedPixels,
  type TransformOptions,
  type TransformResampler,
} from "./pixel-transform";
import { Selection } from "./selection";
import type { AffineMatrix, SelectionPolygon, SelectionQuality } from "./selection-polygons";
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
  /**
   * The content's committed placement, when the session is taken up again from history. Defaults
   * to the content at `origin`. `base` and `committed` must then match it.
   */
  readonly transform?: AffineMatrix;
  /** The copies already drawn into `base` (Ctrl-drag stamps), oldest first, kept for `state`. */
  readonly stamps?: readonly FloatingStep[];
  /** The resampling options the committed placement was made with. */
  readonly options?: TransformOptions;
}

/**
 * A floating session's committed state, as a history item keeps it (TL-FRAME-01): the content's
 * placement and anchor, the area the session covers, the copies drawn into its base and the
 * resampling options. With the content and the layer before the session, it gives the session
 * back exactly.
 */
export interface FloatingState {
  readonly transform: AffineMatrix;
  readonly anchor: Point;
  readonly area: Rect;
  readonly stamps: readonly FloatingStep[];
  readonly options: TransformOptions;
}

/** Makes the tool step a recorded item belongs to, from the state the item ends with. */
export type FloatingStepFor = (after: FloatingState) => ToolStep;

/**
 * Draws a session's previews on the canvas instead of in the layer (`LayerFloatPreview`), such as
 * the engine's GPU: a preview frame then costs a transform, not a write of the moved pixels.
 */
export interface FloatingDisplay {
  /** Whether the canvas can draw floating content over the layer now. */
  available(): boolean;
}

/** Floating regions are aligned to this many pixels, so the canvas's mip levels line up with them. */
export const FLOAT_REGION_ALIGN = 256;

/**
 * A live "Move Selected Pixels" session on one layer (TL-MOVE-PIX-01). The content is drawn into the
 * layer on every preview, without history, or shown over it by a `FloatingDisplay`. Each committed
 * step records one tile-level history item that holds the layer before and after the step, and the
 * selection moves with the content. An edit that changes the document in any other way ends the
 * session, since its layer state is then out of date.
 *
 * With a `FloatingComposer`, a step whose result needs resampling is computed elsewhere (the CPU
 * worker) with the same reference, so history is byte-identical; until it lands the history is
 * held, `settling` is pending and later calls wait their turn.
 */
export class FloatingPixels {
  readonly #document: Document;
  readonly #layer: Layer;
  readonly #source: FloatingSource;
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
  /** Shows previews over the layer, when the host gave one (`setDisplay`). */
  #display: FloatingDisplay | undefined;
  /**
   * Whether previews go to the display: decided at the first preview, and given up for good when
   * the display stops being available. The layer then shows the committed state until a commit.
   */
  #floating: boolean | undefined;
  /** The content as the display gets it, made once. */
  #floatContent: FloatContent | undefined;
  /** The base as the display gets it, in a region around the area; made again when either changes. */
  #floatBase: FloatBase | undefined;
  /** The copies (Ctrl-drag stamps) made in display mode since the base was last computed. */
  #stamps: FloatPlacement[] = [];
  /** Computes resampled steps elsewhere (`setComposer`). */
  #composer: FloatingComposer | undefined;
  /** The copies drawn into the committed base, oldest first. */
  #bakedStamps: readonly FloatingStep[];
  /** The copies drawn since the last commit, in either display mode, oldest first. */
  #newStamps: FloatingStep[] = [];
  /** The step being computed by the composer. Later calls wait in `#waiting`. */
  #inflight: Promise<void> | undefined;
  readonly #waiting: (() => void)[] = [];
  #settled: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;

  constructor(plan: FloatingPlan) {
    for (const surface of [plan.base, plan.committed]) {
      if (surface.width !== plan.area.width || surface.height !== plan.area.height) {
        throw new RangeError("The session surfaces must match its area.");
      }
    }
    this.#document = plan.document;
    this.#layer = plan.layer;
    if (
      plan.coverage !== undefined &&
      plan.coverage.length !== plan.pixels.width * plan.pixels.height
    ) {
      throw new RangeError("The coverage must match the content.");
    }
    this.#outline = plan.outline;
    this.#quality = plan.selection.quality;
    this.#source = new FloatingSource(plan.pixels, plan.coverage, plan.outline, this.#quality);
    this.start = { content: this.#source, origin: plan.origin, area: plan.area, base: plan.base };
    this.#area = plan.area;
    this.#base = plan.base;
    this.#committed = plan.committed;
    this.#transform = plan.transform ?? translationAffine(plan.origin.x, plan.origin.y);
    this.#committedTransform = this.#transform;
    this.#bakedStamps = plan.stamps ?? [];
    if (plan.options !== undefined) this.#options = plan.options;
    const anchor = plan.anchor ?? { x: plan.pixels.width / 2, y: plan.pixels.height / 2 };
    this.#anchor = anchor;
    this.#committedAnchor = anchor;
    this.#selection = plan.selection;
    this.#committedSelection = plan.selection;
    this.#token = this.#historyToken();
    this.#onLayer = this.#contentBounds();
  }

  /**
   * What the session started from: the content, its first placement's origin, the area it first
   * covered and the base there (for a paste, the layer under it before the paste). Nothing here
   * changes later.
   */
  readonly start: {
    readonly content: FloatingSource;
    readonly origin: Point;
    readonly area: Rect;
    readonly base: Surface;
  };

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
    return { width: this.#source.pixels.width, height: this.#source.pixels.height };
  }

  /** The canvas rectangle the content covers at its current transform, before any clipping. */
  get bounds(): Rect {
    return affineBounds(this.#source.pixels.bounds, this.#transform);
  }

  /** True while changes are not yet committed (Dirty, TL-FRAME-01). */
  get pending(): boolean {
    return this.#pending;
  }

  /** The committed state, as a history item keeps it. */
  get state(): FloatingState {
    return {
      transform: this.#committedTransform,
      anchor: this.#committedAnchor,
      area: this.#area,
      stamps: this.#bakedStamps,
      options: this.#options,
    };
  }

  /**
   * True while the session can still be used: it has not finished, its layer is still in the
   * document, and no undo, redo or other edit has happened since its last change. A session that
   * is no longer live takes its floating preview down.
   */
  get live(): boolean {
    const live =
      !this.#ended &&
      this.#document.layers.includes(this.#layer) &&
      this.#document.selection === this.#selection &&
      this.#token === this.#historyToken();
    if (!live && this.#inflight === undefined) this.#takeDownFloat();
    return live;
  }

  /**
   * While a step is computed by the composer, a promise that settles once it is recorded and the
   * calls made meanwhile have run. Undefined otherwise.
   */
  settling(): Promise<void> | undefined {
    return this.#settled?.promise;
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

  /**
   * Shows previews with `display` while it is available, instead of writing them into the layer.
   * Must be set before the first preview.
   */
  setDisplay(display: FloatingDisplay | undefined): void {
    this.#display = display;
  }

  /** Computes steps that resample with `composer`, off this thread. */
  setComposer(composer: FloatingComposer | undefined): void {
    this.#composer = composer;
  }

  /** Draws the content at `m`, and resamples it with `options`. Nothing is recorded. */
  preview(m: AffineMatrix, options: TransformOptions = this.#options): boolean {
    if (this.#defer(() => this.preview(m, options))) return this.live;
    if (!this.live) return false;
    this.#options = options;
    this.#transform = m;
    this.#pending = true;
    this.#paint();
    return true;
  }

  /** Moves the rotation anchor. The anchor is not drawn, so nothing changes on the canvas. */
  setAnchor(anchor: Point): boolean {
    if (this.#defer(() => this.setAnchor(anchor))) return this.live;
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
    if (this.#defer(() => this.stamp())) return this.live;
    if (!this.live) return false;
    this.#growToContent();
    this.#pending = true;
    this.#newStamps.push({ transform: this.#transform, options: this.#options });
    if (this.#floating === true) {
      this.#stamps.push(this.#placement(this.#transform));
      this.#showFloat();
      return true;
    }
    const drawn = this.#compose();
    this.#savedBase ??= this.#base;
    this.#base = drawn;
    return true;
  }

  /**
   * Records the pending changes as one history item named `name`. Returns false when nothing is
   * pending or the session is no longer live.
   */
  commit(name: string, step?: FloatingStepFor): boolean {
    if (this.#defer(() => this.commit(name, step))) return this.live;
    if (!this.live || !this.#pending) return false;
    this.#record(name, false, step);
    return true;
  }

  /**
   * Records one history item named `name`, even when nothing changed, and ends the session. This is
   * the "Finish" of the tool (TL-FRAME-01).
   */
  finish(name: string, step?: FloatingStepFor): boolean {
    if (this.#defer(() => this.finish(name, step))) return this.live;
    if (!this.live) return false;
    this.#record(name, true, step);
    return true;
  }

  /** Drops the uncommitted changes (Enter or Esc while a drag is in progress). Nothing is recorded. */
  cancel(): boolean {
    if (this.#defer(() => this.cancel())) return this.live;
    if (!this.live) return false;
    if (!this.#pending) return true;
    this.#base = this.#savedBase ?? this.#base;
    this.#savedBase = undefined;
    this.#stamps = [];
    this.#newStamps = [];
    this.#transform = this.#committedTransform;
    this.#anchor = this.#committedAnchor;
    this.#pending = false;
    this.#stopResampling();
    if (this.#floating === true) {
      // The layer kept its committed pixels while the display showed the previews.
      this.#takeDownFloat();
    } else {
      this.#exact = true;
      this.#document.restoreLayerPixels(this.#layer, (pixels) => {
        pixels.writeRegion(this.#committed, this.#area.x, this.#area.y);
      });
    }
    this.#onLayer = this.#contentBounds();
    this.#selection = this.#committedSelection;
    this.#document.restoreSelection(this.#committedSelection);
    return true;
  }

  /** Runs `action` once the step in flight is recorded. Returns false when nothing is in flight. */
  #defer(action: () => void): boolean {
    if (this.#inflight === undefined) return false;
    this.#waiting.push(action);
    return true;
  }

  /** Keeps `work` in flight, and runs the calls that wait for it once it ends. */
  #track(work: Promise<void>): void {
    if (this.#settled === undefined) {
      let resolve = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      this.#settled = { promise, resolve };
    }
    const inflight: Promise<void> = work.finally(() => {
      if (this.#inflight === inflight) this.#inflight = undefined;
      while (this.#inflight === undefined && this.#waiting.length > 0) {
        const action = this.#waiting.shift();
        try {
          action?.();
        } catch (cause) {
          queueMicrotask(() => {
            throw cause;
          });
        }
      }
      if (this.#inflight === undefined) {
        const settled = this.#settled;
        this.#settled = undefined;
        settled?.resolve();
      }
    });
    this.#inflight = inflight;
  }

  /** The selection the content has at `m`: the outline moved with the content. */
  #selectionAt(m: AffineMatrix): Selection {
    this.#outlineSelection ??= new Selection(this.#outline, this.#quality);
    return this.#outlineSelection.placed(m);
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
   * With a display the layer is not written at all.
   */
  #paint(): void {
    this.#growToContent();
    if (this.#usesDisplay()) {
      this.#showFloat();
      return;
    }
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

  /**
   * Whether previews go to the display. It is decided while the layer shows the committed state,
   * and given up when the display goes away (a lost GPU): the floating preview is taken down and
   * the layer, which still holds the committed state, is drawn into from then on.
   */
  #usesDisplay(): boolean {
    if (this.#floating === undefined) {
      this.#floating = this.#display?.available() === true;
    } else if (this.#floating && this.#display?.available() !== true) {
      this.#floating = false;
      this.#takeDownFloat();
      if (this.#stamps.length > 0) {
        // The copies were only shown: they are drawn into the base now, with the reference.
        const result = this.#composeNow(this.#transform, this.#options);
        this.#savedBase ??= this.#base;
        this.#base = result.base;
        this.#stamps = [];
      }
      this.#onLayer = this.#contentBounds(this.#committedTransform);
    }
    return this.#floating;
  }

  /**
   * The content placed at `m` with the current options, as the display draws it. `selection` is
   * the outline at `m` when the caller has it.
   */
  #placement(m: AffineMatrix, selection?: Selection): FloatPlacement {
    let shape: readonly SelectionPolygon[] = [];
    if (!isIntegerTranslation(m)) {
      shape =
        this.#outline.length > 0
          ? (selection ?? this.#selectionAt(m)).effectivePolygons()
          : this.#source.shape.placed(m).effectivePolygons();
    }
    return { transform: m, options: this.#options, shape, quality: this.#quality };
  }

  /** Shows the current transform with the display, or the layer as it is when nothing moved. */
  #showFloat(): void {
    const m = this.#transform;
    const selection = this.#selectionAt(m);
    if (this.#stamps.length === 0 && sameAffine(m, this.#committedTransform)) {
      this.#takeDownFloat();
    } else {
      this.#floatContent ??= {
        pixels: this.#source.pixels,
        coverage: this.#source.coverage,
      };
      const placement = this.#placement(m, selection);
      this.#document.setLayerFloatPreview(this.#layer, {
        ...placement,
        content: this.#floatContent,
        base: this.#floatBaseCovering(this.#area),
        stamps: this.#stamps,
      });
    }
    this.#setSelection(selection);
  }

  #takeDownFloat(): void {
    if (this.#layer.floatPreview === undefined) return;
    this.#document.setLayerFloatPreview(this.#layer, undefined);
  }

  /**
   * The base as the display gets it, over a region that covers `area`: aligned to
   * `FLOAT_REGION_ALIGN` and grown with room to spare, so a drag that grows the area seldom makes
   * it again (L2). Outside the area the layer's own pixels are the base, since the session changes
   * nothing there.
   */
  #floatBaseCovering(area: Rect): FloatBase {
    const held = this.#floatBase;
    if (held !== undefined && rectContainsRect(held.region, area)) return held;
    const bounds = this.#layer.pixels.bounds;
    const pad = held === undefined ? 0 : Math.ceil(Math.max(area.width, area.height) / 4);
    const wanted = intersectRects(
      rect(area.x - pad, area.y - pad, area.width + 2 * pad, area.height + 2 * pad),
      bounds,
    );
    const region = alignedRect(held === undefined ? wanted : unionRects(held.region, wanted));
    const pixels = new Surface(region.width, region.height);
    const inside = intersectRects(region, bounds);
    if (!isEmptyRect(inside)) {
      const read = this.#layer.pixels.readRegion(inside);
      pixels.copyFrom(read, read.bounds, inside.x - region.x, inside.y - region.y);
    }
    pixels.copyFrom(
      this.#base,
      this.#base.bounds,
      this.#area.x - region.x,
      this.#area.y - region.y,
    );
    this.#floatBase = { region, pixels };
    return this.#floatBase;
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
      this.#source.pixels,
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
    return intersectRects(affineBounds(this.#source.pixels.bounds, m), this.#layer.pixels.bounds);
  }

  /** `r`, in canvas pixels, in the coordinates of the area's surfaces. */
  #local(r: Rect): Rect {
    return rect(r.x - this.#area.x, r.y - this.#area.y, r.width, r.height);
  }

  /**
   * Records the current transform as one history item named `name`, and ends the session when
   * `end` is set. A result that the layer does not show yet and that needs resampling is computed
   * by the composer when there is one: the history is held until it lands.
   */
  #record(name: string, end = false, step?: FloatingStepFor): void {
    this.#stopResampling();
    this.#growToContent();
    const m = this.#transform;
    const unchanged =
      this.#savedBase === undefined &&
      this.#stamps.length === 0 &&
      sameAffine(m, this.#committedTransform);
    // Whether the layer already shows the result: the committed state, or the last exact preview.
    const shown = unchanged || (this.#floating !== true && this.#exact);
    const resamples = this.#stamps.length > 0 || !isIntegerTranslation(m);
    const composer = this.#composer;
    if (unchanged || composer === undefined || !resamples) {
      // Nothing to compute, or a whole-pixel placement, which is cheap: done here.
      const result = unchanged
        ? { drawn: this.#committed.clone(), base: this.#base }
        : this.#composeNow(m, this.#options);
      this.#apply(name, end, m, result, shown, step);
      return;
    }
    const job = this.#job(m, this.#options);
    const release = this.#document.history.hold();
    this.#track(
      composer(job).then(
        (result) => {
          release();
          this.#apply(name, end, m, result, shown, step);
        },
        () => {
          // The worker could not compute it: the reference runs here instead.
          release();
          this.#apply(name, end, m, this.#composeNow(m, job.placement.options), shown, step);
        },
      ),
    );
  }

  /** The commit of placement `m` as a job: the content, the base, the stamps and the placement. */
  #job(m: AffineMatrix, options: TransformOptions): FloatingComposeJob {
    return {
      pixels: this.#source.pixels,
      coverage: this.#source.coverage,
      outline: this.#outline,
      quality: this.#quality,
      area: this.#area,
      base: this.#base,
      stamps: this.#stamps.map(({ transform, options }) => ({ transform, options })),
      placement: { transform: m, options },
    };
  }

  #composeNow(m: AffineMatrix, options: TransformOptions): FloatingComposeResult {
    return composeFloating(this.#job(m, options));
  }

  /** Writes a computed step into the layer and records it. */
  #apply(
    name: string,
    end: boolean,
    m: AffineMatrix,
    result: FloatingComposeResult,
    shown: boolean,
    step?: FloatingStepFor,
  ): void {
    const area = this.#area;
    const committed = this.#committed;
    const { drawn } = result;
    const stamps =
      this.#newStamps.length === 0 ? this.#bakedStamps : [...this.#bakedStamps, ...this.#newStamps];
    if (this.#stamps.length > 0) {
      this.#base = result.base;
      this.#stamps = [];
      this.#floatBase = undefined;
    }
    if (!shown) {
      this.#document.previewLayerPixels(this.#layer, (pixels) => {
        pixels.writeRegion(drawn, area.x, area.y);
      });
    }
    this.#exact = true;
    this.#takeDownFloat();
    const selection = this.#selectionAt(m);
    // The item's "before" selection is the committed one, not the preview left on screen.
    this.#document.restoreSelection(this.#committedSelection);
    const record = () =>
      this.#document.recordLayerPixels(name, this.#layer, area, committed, selection);
    if (step === undefined) record();
    else {
      const after = { transform: m, anchor: this.#anchor, area, stamps, options: this.#options };
      this.#document.history.withStep(step(after), record);
    }
    this.#bakedStamps = stamps;
    this.#newStamps = [];
    this.#committed = drawn;
    this.#onLayer = this.#contentBounds(m);
    this.#committedTransform = m;
    this.#transform = m;
    this.#committedAnchor = this.#anchor;
    this.#committedSelection = selection;
    this.#selection = selection;
    this.#savedBase = undefined;
    this.#pending = false;
    this.#token = this.#historyToken();
    if (end) this.#ended = true;
  }

  #growToContent(): void {
    this.#grow(this.#contentBounds());
  }

  /** The area at the current transform, from the base (see `FloatingSource.compose`). */
  #compose(
    region: Rect = this.#area,
    out?: Surface,
    m: AffineMatrix = this.#transform,
    resampled?: TransformedPixels | null,
  ): Surface {
    return this.#source.compose(this.#base, this.#area, region, m, this.#options, out, resampled);
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

  /**
   * What identifies the history's state: the stack sizes and the top item, read from the stacks
   * themselves, since `undoName` reads as none while a step is held for the composer.
   */
  #historyToken(): string {
    const history = this.#document.history;
    const top = history.appliedCommands.at(-1);
    let id = this.#commandIds.get(top ?? this);
    if (id === undefined) {
      this.#nextCommandId += 1;
      id = this.#nextCommandId;
      this.#commandIds.set(top ?? this, id);
    }
    return [history.appliedCommands.length, history.undoneCommands.length, id].join("|");
  }

  /** Numbers for history items, so the token can name the top one. */
  readonly #commandIds = new WeakMap<object, number>();
  #nextCommandId = 0;
}

/** `r` grown outward to multiples of `FLOAT_REGION_ALIGN`. */
function alignedRect(r: Rect): Rect {
  const step = FLOAT_REGION_ALIGN;
  const x = Math.floor(r.x / step) * step;
  const y = Math.floor(r.y / step) * step;
  const right = Math.ceil((r.x + r.width) / step) * step;
  const bottom = Math.ceil((r.y + r.height) / step) * step;
  return rect(x, y, right - x, bottom - y);
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
