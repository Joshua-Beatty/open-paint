import type { Document, Layer, Rect } from "@openpaint/document";
import {
  type CpuOffloader,
  type EffectBinding,
  type EffectColors,
  EffectError,
  type EffectMemory,
  EffectSession,
  type EffectSource,
  type GpuOffloader,
  type RenderBackend,
} from "@openpaint/effects";
import type { EffectRegistry } from "@openpaint/extension-api";
import type { MessageId, MessageValues, Translate } from "@openpaint/i18n";
import type { PropertySchema, PropertyValues } from "@openpaint/properties";
import { describeError, errorDetailsText } from "../errors/error-entry";
import { perfMonitor } from "../perf/perf-monitor";
import { FrameCoalescer, type ScheduleFrame } from "../tools/frame-coalescer";

/** The colors a dialog uses when the runtime is given none: black and white. */
const FALLBACK_COLORS: EffectColors = {
  primary: { r: 0, g: 0, b: 0, a: 1 },
  secondary: { r: 1, g: 1, b: 1, a: 1 },
};

/** What the effect UI shows: a configuration dialog, the progress dialog, or an error. */
export type EffectRunState =
  | {
      readonly phase: "dialog";
      readonly title: string;
      readonly schema: PropertySchema;
      readonly values: PropertyValues;
      /** The custom dialog token of the effect, when it has its own editor (EXT-V1-02). */
      readonly customDialog?: string;
      /** The pixels the dialog analyzes, read before any preview. */
      readonly source?: EffectSource;
      /** The translated inline notice about the source, such as "nothing to align". */
      readonly notice?: string;
    }
  | {
      readonly phase: "rendering";
      readonly title: string;
      /** Undefined while the effect is being computed ("Initializing..."). */
      readonly percent: number | undefined;
      readonly canceling: boolean;
    }
  | {
      readonly phase: "error";
      readonly title: string;
      readonly message: string;
      /** The stack of the underlying error, shown under "Show details" (SET-ERR-03). */
      readonly details: string;
    };

export interface EffectRuntimeOptions {
  readonly registry: EffectRegistry;
  readonly bindings: readonly EffectBinding<unknown>[];
  readonly memory: EffectMemory;
  /** The active image's document, or undefined when no image is open. */
  readonly document: () => Document | undefined;
  readonly translate: Translate;
  readonly backend: () => RenderBackend;
  readonly log: (message: string, cause: unknown) => void;
  /** The primary and secondary colors, read when a dialog opens (FX-FW-TOKEN-01). */
  readonly colors?: () => EffectColors;
  /** Runs the CPU implementations off the main thread (PRD-NF-02). Undefined runs them here. */
  readonly offload?: CpuOffloader;
  /** Runs the WGSL implementations on the engine's GPU device (WEB-GPU-01). */
  readonly gpu?: GpuOffloader;
  /** The part of the image on screen, in image pixels: previews write it first. */
  readonly visibleArea?: () => Rect | undefined;
  /**
   * Whether the canvas draws layer live filters, so per-pixel adjustments preview as one
   * (`EffectSessionOptions.liveFilters`).
   */
  readonly liveFilters?: boolean;
  /**
   * Schedules the next preview before the next repaint (L1): the dialog's changes in between are
   * dropped for the newest. Undefined previews every change at once.
   */
  readonly scheduleFrame?: ScheduleFrame;
  /**
   * Runs before an effect starts, so a pending tool result is finished before the effect reads the
   * layer (TL-FRAME-01).
   */
  readonly beforeStart?: () => void;
}

interface Target {
  readonly binding: EffectBinding<unknown>;
  readonly document: Document;
  readonly layer: Layer;
  readonly title: string;
}

interface Active {
  readonly session: EffectSession<unknown>;
  readonly target: Target;
  /** Shows the progress dialog of a run with no dialog, once it has run for a while. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A run with no configuration dialog (ADJ-COMMON-01) shows the progress dialog only when it is
 * still running after this long, so a quick adjustment shows no dialog at all.
 */
export const RUN_PROGRESS_DELAY_MS = 300;

type Listener = () => void;

/**
 * Runs the effects of the active image (FX-FW-PREVIEW-01, FX-FW-PROGRESS-01, FX-FW-REPEAT-01). It
 * owns at most one session at a time. A configurable effect opens its dialog and previews into the
 * layer. A non-configurable effect, and Repeat, run at once behind the progress dialog. The runtime
 * is plain TypeScript: React reads `state` through `subscribe`.
 */
export class EffectRuntime {
  readonly #options: EffectRuntimeOptions;
  readonly #listeners = new Set<Listener>();
  #state: EffectRunState | undefined;
  #active: Active | undefined;
  readonly #previews: FrameCoalescer;

  constructor(options: EffectRuntimeOptions) {
    this.#options = options;
    this.#previews = new FrameCoalescer(options.scheduleFrame);
  }

  get state(): EffectRunState | undefined {
    return this.#state;
  }

  /** True while a live preview or a commit is still rendering. */
  get rendering(): boolean {
    return this.#active?.session.phase === "rendering" || this.#state?.phase === "rendering";
  }

  /** True while a session is open: a dialog with its live preview, or a run in progress. */
  get active(): boolean {
    return this.#active !== undefined;
  }

  /** The Effect-category effect that ran last this session, for the Repeat item. */
  get lastEffectId(): string | undefined {
    return this.#options.memory.last?.effectId;
  }

  /** Whether an effect can start now: nothing is running and the active image has a layer. */
  get canStart(): boolean {
    return (
      this.#state === undefined &&
      this.#active === undefined &&
      this.#options.document()?.activeLayer !== undefined
    );
  }

  /** Whether Repeat can run now: a last effect exists and an effect can start. */
  get canRepeat(): boolean {
    return this.lastEffectId !== undefined && this.canStart;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** An Effects menu item: opens the dialog, or runs at once when the effect is not configurable. */
  start(effectId: string): void {
    this.#options.beforeStart?.();
    const target = this.#target(effectId);
    if (target === undefined) return;
    const { binding, title } = target;
    if (!binding.descriptor.configurable) {
      this.#run(target, this.#options.memory.defaultsFor(binding.descriptor));
      return;
    }
    const schema =
      binding.dialogSchema?.(this.#options.colors?.() ?? FALLBACK_COLORS) ??
      binding.descriptor.schema;
    const values = this.#options.memory.valuesFor(binding.descriptor, schema);
    const session = this.#openSession(target);
    this.#active = { session, target };
    const notice = session.notice;
    this.#set({
      phase: "dialog",
      title,
      schema,
      values,
      customDialog: binding.descriptor.customDialog,
      source: session.source,
      notice: notice === undefined ? undefined : this.#options.translate(notice),
    });
    void session.preview(values).then(() => this.#checkPreview(session));
  }

  /** Repeat Last Effect (FX-FW-REPEAT-01): re-runs the stored parameters with no dialog. */
  repeat(): void {
    const last = this.#options.memory.last;
    if (last === undefined) return;
    this.#options.beforeStart?.();
    const target = this.#target(last.effectId);
    if (target === undefined) return;
    this.#run(target, last.values);
  }

  /**
   * A change in the dialog: re-renders the layer with the new values (FX-FW-PREVIEW-01), once per
   * frame with the newest values.
   */
  preview(values: PropertyValues): void {
    const active = this.#active;
    if (active === undefined || this.#state?.phase !== "dialog") return;
    const requestedAt = performance.now();
    this.#previews.request(() => {
      if (this.#active !== active || this.#state?.phase !== "dialog") return;
      void active.session
        .preview(values, requestedAt)
        .then(() => this.#checkPreview(active.session));
    });
  }

  /** OK: commits the values. The progress dialog stays open while the render finishes. */
  ok(values: PropertyValues): void {
    const active = this.#active;
    const state = this.#state;
    if (active === undefined || state?.phase !== "dialog") return;
    // OK commits its own values, which are the newest.
    this.#previews.cancel();
    this.#set({ phase: "rendering", title: state.title, percent: undefined, canceling: false });
    this.#settle(active, active.session.ok(values));
  }

  /** Cancel, Esc, or the progress dialog's Cancel: the original pixels come back (FX-FW-PREVIEW-01). */
  cancel(): void {
    const active = this.#active;
    const state = this.#state;
    if (active === undefined || state === undefined || state.phase === "error") return;
    this.#previews.cancel();
    if (state.phase === "rendering") this.#set({ ...state, canceling: true });
    this.#active = undefined;
    void active.session.cancel().then(() => this.#set(undefined));
  }

  /** Closes the error message. */
  dismissError(): void {
    if (this.#state?.phase === "error") this.#set(undefined);
  }

  #target(effectId: string): Target | undefined {
    if (this.#state !== undefined || this.#active !== undefined) return undefined;
    const descriptor = this.#options.registry.get(effectId);
    const binding = this.#options.bindings.find((item) => item.descriptor.id === effectId);
    if (descriptor === undefined || binding === undefined) return undefined;
    const document = this.#options.document();
    const layer = document?.activeLayer;
    if (document === undefined || layer === undefined) return undefined;
    return { binding, document, layer, title: this.#options.translate(descriptor.label) };
  }

  #openSession({ binding, document, layer, title }: Target): EffectSession<unknown> {
    return new EffectSession({
      document,
      layer,
      binding,
      memory: this.#options.memory,
      historyName: title,
      backend: this.#options.backend(),
      offload: this.#options.offload,
      gpu: this.#options.gpu,
      priority: this.#options.visibleArea?.(),
      log: this.#options.log,
      onProgress: (percent) => this.#progress(percent),
      liveFilters: this.#options.liveFilters,
      clock: () => performance.now(),
      onPreviewShown: (requestedAt) => perfMonitor?.previewShown(requestedAt, performance.now()),
    });
  }

  #run(target: Target, values: PropertyValues): void {
    const active: Active = { session: this.#openSession(target), target };
    this.#active = active;
    active.timer = setTimeout(() => {
      if (this.#active !== active || this.#state !== undefined) return;
      this.#set({ phase: "rendering", title: target.title, percent: undefined, canceling: false });
    }, RUN_PROGRESS_DELAY_MS);
    this.#settle(active, active.session.ok(values));
  }

  /** Ends the session when its commit settles, and shows an error when it fails. */
  #settle(active: Active, pending: Promise<void>): void {
    pending.then(
      () => {
        clearTimeout(active.timer);
        if (this.#active !== active) return;
        this.#active = undefined;
        this.#set(undefined);
      },
      (cause: unknown) => {
        clearTimeout(active.timer);
        if (this.#active !== active) return;
        this.#active = undefined;
        this.#showError(active.target.title, cause);
      },
    );
  }

  /** A failed live preview closes the dialog and shows the error (FX-FW-ERR-01). */
  #checkPreview(session: EffectSession<unknown>): void {
    const active = this.#active;
    if (active === undefined || active.session !== session || session.phase !== "failed") return;
    this.#active = undefined;
    this.#showError(active.target.title, session.error);
  }

  /** A failed effect is written to the local error log (SET-ERR-01); an out-of-memory stop is not. */
  #showError(title: string, cause: unknown): void {
    const failure = cause instanceof EffectError ? cause.failure : "failed";
    const id: MessageId =
      failure === "outOfMemory" ? "effect.error.outOfMemory" : "effect.error.failed";
    const values: MessageValues = { effect: title };
    const underlying =
      cause instanceof EffectError && cause.cause !== undefined ? cause.cause : cause;
    if (failure !== "outOfMemory") this.#options.log(`The effect "${title}" failed.`, underlying);
    this.#set({
      phase: "error",
      title,
      message: this.#options.translate(id, values),
      details: errorDetailsText(describeError(underlying)),
    });
  }

  #progress(percent: number | undefined): void {
    const state = this.#state;
    if (state?.phase !== "rendering") return;
    this.#set({ ...state, percent });
  }

  #set(state: EffectRunState | undefined): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
