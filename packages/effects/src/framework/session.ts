import {
  type Document,
  intersectRects,
  isEmptyRect,
  type Layer,
  type Rect,
  type Surface,
} from "@openpaint/document";
import type { MessageId } from "@openpaint/i18n";
import {
  defaultValues,
  type PropertySchema,
  type PropertyValue,
  type PropertyValues,
  serializeValues,
} from "@openpaint/properties";
import { pixelAdjustment } from "../pixel-adjustments";
import { createInstanceSeed } from "../rng";
import { type EffectBinding, LAYER_UNDERLAY_KEY } from "./binding";
import type { CpuOffloader } from "./cpu-offload";
import { type EffectError, toEffectError } from "./errors";
import type { GpuOffloader } from "./gpu-offload";
import type { EffectMemory } from "./memory";
import { type RenderBackend, renderRegion } from "./render";

/**
 * "idle": nothing rendered yet. "rendering": a preview is in flight. "ready": the layer shows the
 * output for the last values. "failed": the effect errored and the layer is restored.
 * "committed" and "canceled" are final.
 */
export type SessionPhase = "idle" | "rendering" | "ready" | "failed" | "committed" | "canceled";

/** The pixels an effect reads over its region, and the selection that limits them (ADJ-COMMON-05). */
export interface EffectSource {
  readonly pixels: Surface;
  /** One byte per pixel of `pixels`, or undefined when every pixel is selected. */
  readonly coverage: Uint8Array | undefined;
  /**
   * The whole layer as it was when the session opened, for a dialog whose pan control shows it
   * (FX-A-00-02e). Undefined when the dialog does not use it.
   */
  readonly layer?: Surface | undefined;
}

function isSameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Whether a dialog has a pan control over the whole layer (FX-A-00-02e). */
function hasLayerUnderlay(schema: PropertySchema): boolean {
  return schema.properties.some(
    (property) => property.control?.staticImageUnderlay === LAYER_UNDERLAY_KEY,
  );
}

export interface EffectSessionOptions<P> {
  readonly document: Document;
  readonly layer: Layer;
  readonly binding: EffectBinding<P>;
  readonly memory: EffectMemory;
  /** The history item name, which is the effect's translated name (FX-FW-PROGRESS-01). */
  readonly historyName: string;
  readonly backend: RenderBackend;
  /** Runs the CPU implementation off the main thread when it can (PRD-NF-02). */
  readonly offload?: CpuOffloader;
  /** Runs the WGSL implementation on the engine's GPU device when `backend` is "gpu". */
  readonly gpu?: GpuOffloader;
  /**
   * The effect instance's seed (FX-A-00-05). Undefined draws a new one when the session opens, so
   * each opening of an effect gives a new pattern.
   */
  readonly instanceSeed?: number;
  /** The visible part of the canvas in image pixels, rendered first (FX-FW-PREVIEW-01). */
  readonly priority?: Rect;
  readonly onProgress?: (percent: number | undefined) => void;
  /**
   * Called when a preview first reaches the canvas, with the `clock` time its values were asked
   * for (the benchmark's time to a visible update).
   */
  readonly onPreviewShown?: (requestedAt: number) => void;
  /**
   * Whether the host's canvas draws layer live filters (`Document.setLayerLivePreview`). Then the
   * previews of per-pixel adjustments are live filters, and only OK computes and writes the output.
   */
  readonly liveFilters?: boolean;
  readonly log: (message: string, cause: unknown) => void;
  readonly clock?: () => number;
  readonly yieldToHost?: () => Promise<void>;
}

/**
 * One use of an effect on one layer: the live preview, then Cancel or OK (FX-FW-PREVIEW-01). The
 * session copies the original pixels when it opens. Previews write into the layer without history.
 * Cancel writes the original back. OK writes the original back, then records the rendered pixels
 * as one history item (ADJ-COMMON-03). The selection decides the region and the coverage.
 */
export class EffectSession<P = unknown> {
  readonly #options: EffectSessionOptions<P>;
  readonly #region: Rect;
  readonly #original: Surface | undefined;
  readonly #coverage: Uint8Array | undefined;
  readonly #clipsOutput: boolean;
  readonly #layer: Surface | undefined;
  #controller = new AbortController();
  #current: Promise<void> = Promise.resolve();
  #phase: SessionPhase = "idle";
  #error: EffectError | undefined;
  #renderedKey: string | undefined;
  /** The values of the render in flight. */
  #renderingKey: string | undefined;
  /** The newest values waiting for a GPU render in flight to finish. */
  #queued:
    | { readonly values: PropertyValues; readonly key: string; readonly requestedAt: number }
    | undefined;
  /** Whether a render wrote the layer, so cancel() has pixels to put back. */
  #written = false;
  /** The result of the binding's `analyze`, boxed so an undefined result is still cached. */
  #analysis: { readonly value: unknown } | undefined;
  /** Whether the layer holds a rendered preview rather than the original pixels. */
  #previewShown = false;
  /** Whether the last finished render left the layer unchanged (`binding.unchanged`). */
  #renderedUnchanged = false;
  /** Whether the last render ran on the GPU, whose errors arrive after its pixels (`confirm`). */
  #renderedOnGpu = false;
  readonly #instanceSeed: number;

  constructor(options: EffectSessionOptions<P>) {
    this.#options = options;
    this.#instanceSeed = options.instanceSeed ?? createInstanceSeed();
    const { document, layer, binding } = options;
    const bounds = layer.pixels.bounds;
    const { selection } = document;
    const quality = binding.descriptor.options?.forceAliasedSelection
      ? selection.withQuality("aliased")
      : selection;
    this.#clipsOutput = !binding.descriptor.options?.disableSelectionClipping;
    this.#region = selection.isEmpty ? bounds : intersectRects(quality.bounds(), bounds);
    if (isEmptyRect(this.#region)) {
      this.#original = undefined;
      this.#coverage = undefined;
      this.#layer = undefined;
      return;
    }
    this.#original = layer.pixels.readRegion(this.#region);
    this.#coverage = selection.isEmpty ? undefined : quality.mask(this.#region);
    if (!hasLayerUnderlay(binding.descriptor.schema)) {
      this.#layer = undefined;
    } else if (isSameRect(this.#region, bounds)) {
      this.#layer = this.#original;
    } else {
      this.#layer = layer.pixels.readRegion(bounds);
    }
  }

  get phase(): SessionPhase {
    return this.#phase;
  }

  /** The error of a failed render, or undefined. The layer has already been restored. */
  get error(): EffectError | undefined {
    return this.#error;
  }

  /** The area the effect covers: the selection's bounds, or the whole layer. */
  get region(): Rect {
    return this.#region;
  }

  /**
   * The pixels the effect reads, copied before any preview, and the selection over them (nonzero
   * coverage selects a pixel). Undefined when the region is empty. A dialog reads its analysis here.
   */
  get source(): EffectSource | undefined {
    if (this.#original === undefined) return undefined;
    return { pixels: this.#original, coverage: this.#coverage, layer: this.#layer };
  }

  /** The binding's inline notice about the source, such as "nothing to align", or undefined. */
  get notice(): MessageId | undefined {
    const analysis = this.#analyze();
    const { binding } = this.#options;
    return analysis === undefined ? undefined : binding.notice?.(analysis.value);
  }

  /** Runs the binding's `analyze` once, on the pixels as they were when the session opened. */
  #analyze(): { readonly value: unknown } | undefined {
    const { binding } = this.#options;
    if (this.#analysis !== undefined || binding.analyze === undefined) return this.#analysis;
    if (this.#original === undefined) return undefined;
    this.#analysis = { value: binding.analyze(this.#original, this.#coverage) };
    return this.#analysis;
  }

  /** The values OK and Repeat render: preview-only properties go back to their defaults. */
  #committedValues(values: PropertyValues): PropertyValues {
    const { descriptor } = this.#options.binding;
    const keys = descriptor.options?.previewOnlyProperties ?? [];
    if (keys.length === 0) return values;
    const defaults = defaultValues(descriptor.schema);
    const committed: Record<string, PropertyValue> = { ...values };
    for (const key of keys) {
      const value = defaults[key];
      if (value !== undefined) committed[key] = value;
    }
    return committed;
  }

  /**
   * Renders `values` into the layer as a live preview. A CPU render still in flight is cancelled
   * first, and the preview waits until it has stopped. A GPU render in flight is short, so it
   * finishes and shows, and only the newest values wait behind it: earlier waiting values are
   * dropped at once. A dragged slider then keeps showing previews instead of cancelling each one
   * before it lands. Resolves when the render finishes or fails. Errors are kept in `error` and
   * never thrown here, so a live preview cannot reject. `requestedAt` is when the dialog asked for
   * the values (`clock` time), for `onPreviewShown`.
   */
  preview(values: PropertyValues, requestedAt: number = this.#now()): Promise<void> {
    this.#assertOpen();
    const key = this.#keyOf(values);
    if (this.#phase === "rendering" && this.#queued === undefined && this.#renderingKey === key) {
      return this.#current;
    }
    if (this.#phase === "ready" && this.#renderedKey === key) {
      this.#queued = undefined;
      return this.#current;
    }
    if (this.#phase === "rendering" && !this.#live && this.#onGpu) {
      const waiting = this.#queued !== undefined;
      this.#queued = { values, key, requestedAt };
      if (!waiting) this.#current = this.#current.then(() => this.#renderQueued());
      return this.#current;
    }
    this.#queued = undefined;
    const signal = this.#restart();
    const params = this.#paramsOf(values);
    if (this.#live) {
      // The canvas applies the adjustment as it draws the layer: nothing is computed or written.
      this.#showLive(params, key, requestedAt);
      return this.#current;
    }
    this.#phase = "rendering";
    this.#renderingKey = key;
    this.#current = this.#current.then(() => this.#render(params, key, signal, requestedAt));
    return this.#current;
  }

  /** Whether renders run on the GPU offloader, so one in flight finishes quickly. */
  get #onGpu(): boolean {
    const { backend, gpu, binding } = this.#options;
    return backend === "gpu" && gpu?.canRun(binding as EffectBinding<unknown>) === true;
  }

  /** Renders the newest values that waited for the render before them. */
  async #renderQueued(): Promise<void> {
    const queued = this.#queued;
    this.#queued = undefined;
    const signal = this.#controller.signal;
    if (queued === undefined || signal.aborted) return;
    if (this.#phase === "ready" && this.#renderedKey === queued.key) return;
    this.#phase = "rendering";
    this.#renderingKey = queued.key;
    await this.#render(this.#paramsOf(queued.values), queued.key, signal, queued.requestedAt);
  }

  /**
   * Commits `values` (OK). Renders them first if needed, waits for the render, then records one
   * history item and remembers the values (FX-FW-TOKEN-01). Preview-only properties are reset to
   * their defaults first. A render that leaves the layer unchanged records no history item. Throws
   * the render error, if any, and then the layer is unchanged. With a live filter on the canvas,
   * the output is computed now and written in one task that also takes the filter down.
   */
  async ok(values: PropertyValues): Promise<void> {
    const committed = this.#committedValues(values);
    if (this.#live && this.#original !== undefined) {
      this.#assertOpen();
      const key = this.#keyOf(committed);
      const signal = this.#restart();
      const params = this.#paramsOf(committed);
      const requestedAt = this.#now();
      this.#showLive(params, key, requestedAt);
      this.#queued = undefined;
      this.#phase = "rendering";
      this.#current = this.#current.then(() => this.#render(params, key, signal, requestedAt));
      await this.#current;
    } else {
      await this.preview(committed);
    }
    if (this.#phase === "ready" && this.#renderedOnGpu) {
      const confirmed = await this.#options.gpu?.confirm?.(
        this.#options.binding as EffectBinding<unknown>,
      );
      if (confirmed === false && this.#phase === "ready") {
        // The GPU reported an error after its pixels came back: rendered again on the CPU.
        this.#renderedKey = undefined;
        await this.preview(committed);
      }
    }
    if (this.#phase === "failed") throw this.#error;
    if (this.#phase !== "ready") throw new RangeError("The effect was canceled.");
    this.#commit(committed);
  }

  /** Stops the render in flight and restores the original pixels. Nothing is recorded. */
  async cancel(): Promise<void> {
    if (this.#phase === "committed" || this.#phase === "canceled") return;
    this.#phase = "canceled";
    this.#controller.abort();
    await this.#current;
    const { document, layer } = this.#options;
    const original = this.#original;
    if (original !== undefined && this.#written) {
      document.restoreLayerPixels(layer, (pixels) => {
        pixels.writeRegion(original, this.#region.x, this.#region.y);
      });
    }
    if (this.#live) document.setLayerLivePreview(layer, undefined);
    this.#release();
  }

  /** Lets the GPU offloader drop its copy of the source once the session is over. */
  #release(): void {
    if (this.#original !== undefined) this.#options.gpu?.release?.(this.#original);
  }

  /**
   * Whether previews are a live filter on the canvas (FX-FW-PREVIEW-01): the host draws them and
   * the effect maps each pixel on its own.
   */
  get #live(): boolean {
    return (
      this.#options.liveFilters === true &&
      pixelAdjustment(this.#options.binding.descriptor.id) !== undefined
    );
  }

  #keyOf(values: PropertyValues): string {
    return JSON.stringify(serializeValues(this.#options.binding.descriptor.schema, values));
  }

  #paramsOf(values: PropertyValues): P {
    return this.#options.binding.params(
      values,
      { width: this.#options.document.width, height: this.#options.document.height },
      this.#instanceSeed,
      { x: this.#region.x, y: this.#region.y },
      this.#analyze()?.value,
    );
  }

  #now(): number {
    return (this.#options.clock ?? Date.now)();
  }

  /** Cancels the render in flight and returns the signal of the next one. */
  #restart(): AbortSignal {
    this.#controller.abort();
    this.#controller = new AbortController();
    return this.#controller.signal;
  }

  /** Shows `params` as the layer's live filter. The canvas draws it on its next frame. */
  #showLive(params: P, key: string, requestedAt: number): void {
    const { binding, document, layer, onPreviewShown } = this.#options;
    this.#phase = "ready";
    this.#renderedKey = key;
    if (this.#original === undefined) return;
    document.setLayerLivePreview(layer, {
      effectId: binding.descriptor.id,
      params,
      region: this.#region,
      coverage: this.#clipsOutput ? this.#coverage : undefined,
    });
    onPreviewShown?.(requestedAt);
  }

  #assertOpen(): void {
    if (this.#phase === "committed" || this.#phase === "canceled") {
      throw new RangeError(`The effect session is already ${this.#phase}.`);
    }
  }

  async #render(params: P, key: string, signal: AbortSignal, requestedAt: number): Promise<void> {
    const { binding, document, layer, backend, offload, gpu, log, onPreviewShown } = this.#options;
    const live = this.#live;
    let shown = false;
    if (signal.aborted) return;
    const original = this.#original;
    if (original === undefined) {
      this.#phase = "ready";
      this.#renderedKey = key;
      return;
    }
    if (binding.unchanged?.(params) === true) {
      if (this.#previewShown) {
        document.restoreLayerPixels(layer, (pixels) => {
          pixels.writeRegion(original, this.#region.x, this.#region.y);
        });
        this.#previewShown = false;
      }
      this.#renderedUnchanged = true;
      this.#phase = "ready";
      this.#renderedKey = key;
      return;
    }
    this.#renderedUnchanged = false;
    this.#previewShown = true;
    this.#renderedOnGpu = this.#onGpu;
    try {
      const outcome = await renderRegion({
        binding,
        params,
        store: layer.pixels,
        region: this.#region,
        original,
        coverage: this.#coverage,
        clipsOutput: this.#clipsOutput,
        backend,
        offload,
        gpu,
        accountant: document.accountant,
        signal,
        priority: this.#options.priority,
        onProgress: this.#options.onProgress,
        // Each written tile reaches the canvas through the document (FX-FW-PREVIEW-01). A live
        // filter's output lands in one write, which takes the filter down in the same task.
        onWrite: () => {
          this.#written = true;
          if (live && layer.livePreview !== undefined) {
            document.setLayerLivePreview(layer, undefined);
            return;
          }
          document.layerPreviewChanged(layer);
          if (!shown && !signal.aborted) onPreviewShown?.(requestedAt);
          shown = true;
        },
        // The next preview overwrites every tile, and cancel() restores the original itself.
        restoreOnCancel: false,
        atOnce: live,
        log,
        clock: this.#options.clock,
        yieldToHost: this.#options.yieldToHost,
      });
      if (outcome === "canceled" || signal.aborted) return;
      this.#phase = "ready";
      this.#renderedKey = key;
    } catch (cause) {
      // A failed render has written the original back.
      this.#previewShown = false;
      if (signal.aborted) return;
      log(`Effect "${binding.descriptor.id}" failed.`, cause);
      this.#error = toEffectError(binding.descriptor.id, cause);
      this.#phase = "failed";
    }
  }

  #commit(values: PropertyValues): void {
    const { binding, document, layer, historyName, memory } = this.#options;
    const original = this.#original;
    // A render that left the layer unchanged has nothing to record (FX-OBJ-ALIGN-06).
    if (original !== undefined && !this.#renderedUnchanged) {
      // The preview is already on the layer: it is recorded as it is, with the original as the
      // before-state, rather than written out and back in (L9).
      try {
        // An effect that moves the outline with the pixels records both in one item.
        const selection = binding.selectionAfter?.(
          document.selection,
          this.#region,
          this.#paramsOf(values),
        );
        document.recordLayerPixels(historyName, layer, this.#region, original, selection);
      } catch (cause) {
        throw toEffectError(binding.descriptor.id, cause);
      }
    }
    if (binding.descriptor.configurable) memory.remember(binding.descriptor, values);
    memory.recordRun(binding.descriptor, values);
    this.#phase = "committed";
    this.#release();
  }
}
