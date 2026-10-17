import type { Size } from "@openpaint/document";
import {
  type BackendSetting,
  GraphicsErrorFlags,
  type PerformanceCache,
  type ResolvedBackend,
  resolveBackend,
} from "../backend";
import type { RenderCanvas } from "../canvas";
import type { CompositeDocument } from "../composite";
import { DeviceLossTracker } from "../device-loss";
import type { DocumentSync } from "../document-sync";
import type { EngineHost } from "../engine";
import {
  type CanvasStyle,
  type CanvasTheme,
  canvasTheme,
  DEFAULT_CANVAS_THEME,
  frameStyle,
} from "../frame";
import { adapterKey } from "../gpu-device";
import {
  PresentFailureTracker,
  presentChecked,
  presentFault,
  watchUncapturedErrors,
} from "../present-failures";
import type { EngineSettings, EngineSize, EngineStatus } from "../protocol";
import {
  applyCommand,
  applyWheel,
  FIT_VIEW,
  type ViewCommand,
  type ViewLayout,
  type ViewState,
  type ViewStatus,
  viewLayout,
  viewStatus,
  type WheelInput,
} from "../view";
import { planComposite } from "./composite-plan";
import { GpuCompositorV2 } from "./compositor";
import { GpuDocument } from "./gpu-document";
import { PresenterV2 } from "./presenter";
import { SlotBuffer } from "./slot-buffer";
import { GpuStroke, type StrokeBegin, StrokePipelines, type StrokeTile } from "./stroke";

/** Platform services of the v2 engine: the v1 host's, plus a request for a full document sync. */
export interface EngineV2Host extends Omit<EngineHost, "createPresenter"> {
  /** The GPU document was lost (device loss): the main thread must send a full sync. */
  emitResync(): void;
  /** Test hook (`?gpu-fault=present`): every present fails, as on a canvas that cannot present. */
  readonly presentFault?: boolean;
}

/** The WebGPU context of the on-screen canvas. Narrowed per type, as both overload `getContext`. */
function webgpuContext(canvas: RenderCanvas): GPUCanvasContext | null {
  const context =
    "transferToImageBitmap" in canvas ? canvas.getContext("webgpu") : canvas.getContext("webgpu");
  return context as GPUCanvasContext | null;
}

/** A committed v2 stroke: the layer and its painted tiles, read back from the GPU. */
export interface StrokeCommit {
  readonly layerId: number;
  readonly tiles: readonly StrokeTile[];
}

/** Everything that lives on one GPU device. Rebuilt after a device loss. */
interface DeviceState {
  readonly device: GPUDevice;
  readonly document: GpuDocument;
  readonly compositor: GpuCompositorV2;
  readonly presenter: PresenterV2;
  readonly pipelines: StrokePipelines;
  readonly slots: SlotBuffer;
}

/**
 * Engine v2: the document lives on the GPU as tiled textures, every frame
 * composites the visible tiles that changed and presents straight to the canvas's WebGPU
 * context, and Paintbrush and Eraser strokes are painted here, incrementally. It runs only on the
 * WebGPU backend; `start` reports when the backend resolves to the CPU so the host can use v1.
 *
 * The canvas is bound to WebGPU, so v2 cannot move to the CPU presenter. After repeated device
 * loss, `MAX_PRESENT_FAILURES` failed presents in a row, or a presenter that cannot be built, it
 * drops its device and reports the CPU backend (still as v2); the main thread then starts v1 on
 * the CPU with a new canvas.
 */
export class EngineV2 {
  readonly #losses = new DeviceLossTracker();
  readonly #presentFailures = new PresentFailureTracker();
  #retryPresent = false;
  #fallingBack = false;
  #theme: CanvasTheme = DEFAULT_CANVAS_THEME;
  #setting: BackendSetting;
  #errorFlags: number;
  #cache: PerformanceCache;
  #size: EngineSize;
  #resolved: ResolvedBackend | undefined;
  #context: GPUCanvasContext | undefined;
  #state: DeviceState | undefined;
  #view: ViewState = FIT_VIEW;
  #layout: ViewLayout | undefined;
  #stroke: GpuStroke | undefined;
  #readbacks = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly host: EngineV2Host,
    settings: EngineSettings & EngineSize,
    readonly canvas: RenderCanvas,
  ) {
    this.#setting = settings.backend;
    this.#errorFlags = settings.errorFlags;
    this.#cache = settings.performanceCache;
    this.#size = { width: settings.width, height: settings.height, scale: settings.scale };
  }

  get status(): EngineStatus {
    const resolved = this.#resolved;
    if (!resolved) throw new Error("The engine has not started.");
    return {
      setting: this.#setting,
      backend: resolved.backend,
      reason: resolved.reason,
      webgpuAvailable: resolved.webgpuAvailable,
      ...(resolved.adapter && { adapter: resolved.adapter }),
      performanceClass: resolved.performanceClass,
      errorFlags: this.#errorFlags,
      performanceCache: this.#cache,
      deviceLossCount: this.#losses.count,
      engine: "v2",
    };
  }

  /** The WebGPU device the engine renders with, or undefined after repeated device losses. */
  get gpuDevice(): GPUDevice | undefined {
    return this.#state?.device;
  }

  /** True when no stroke work or readback is pending. Frames are presented synchronously. */
  get idle(): boolean {
    return this.#readbacks === 0 && !(this.#stroke?.pending ?? false);
  }

  /**
   * Resolves the backend and, on WebGPU, takes the canvas's WebGPU context. Returns undefined
   * (and leaves the canvas untouched) when the backend is the CPU, so the host can run v1.
   */
  start(): Promise<EngineStatus | undefined> {
    return this.#serialize(async () => {
      const resolved = await this.#resolve();
      if (!resolved.device) return undefined;
      try {
        this.#activate(resolved);
      } catch (error) {
        // The canvas may already hold a WebGPU context, so v1 needs a new canvas: report the CPU.
        this.host.reportError?.(error);
        await this.#dropDevice();
      }
      return this.status;
    });
  }

  /**
   * Applies a user-picked backend. The canvas is bound to WebGPU for good, so a CPU choice takes
   * effect after a reload; until then the engine keeps its device.
   */
  setBackend(setting: BackendSetting): Promise<EngineStatus> {
    return this.#serialize(async () => {
      this.#setting = setting;
      if (this.#state) this.#errorFlags &= ~GraphicsErrorFlags.CpuFallbackAfterDeviceLoss;
      this.#losses.reset();
      this.#presentFailures.reset();
      return this.status;
    });
  }

  setCanvasStyle(style: CanvasStyle): void {
    this.#theme = canvasTheme(style);
    this.#frame();
  }

  resize(size: EngineSize): void {
    this.#size = size;
    this.canvas.width = Math.max(1, size.width);
    this.canvas.height = Math.max(1, size.height);
    this.#frame();
  }

  setVisible(visible: boolean): void {
    if (visible) this.#frame();
  }

  view(command: ViewCommand): ViewStatus {
    const { doc, viewport } = this.#geometry();
    this.#view = applyCommand(this.#view, doc, viewport, command);
    this.#frame();
    return viewStatus(this.#view, doc, viewport);
  }

  wheel(input: WheelInput): ViewStatus {
    const { doc, viewport } = this.#geometry();
    this.#view = applyWheel(this.#view, doc, viewport, this.#size.scale, input);
    this.#frame();
    return viewStatus(this.#view, doc, viewport);
  }

  /** Applies a document sync from the main thread: only the listed tiles are uploaded. */
  sync(sync: DocumentSync): void {
    const state = this.#state;
    if (!state) return;
    const stroke = this.#stroke;
    if (stroke && (sync.full || !sync.layers.some((layer) => layer.id === stroke.layerId))) {
      this.strokeCancel();
    }
    state.document.apply(sync);
    this.#frame();
  }

  /** Shows a CPU-side test document (M0.09). */
  load(doc: CompositeDocument): void {
    this.strokeCancel();
    this.#state?.document.load(doc);
    this.#frame();
  }

  /** Starts a Paintbrush or Eraser stroke on a layer. */
  strokeBegin(begin: StrokeBegin): void {
    this.strokeCancel();
    const state = this.#state;
    if (!state) return;
    this.#stroke = new GpuStroke(state.device, state.document, state.pipelines, state.slots, begin);
  }

  /** Adds a batch of samples (flat `x, y, pressure` in image pixels) and presents the result. */
  strokeSamples(samples: Float32Array): void {
    const stroke = this.#stroke;
    if (!stroke) return;
    stroke.push(samples);
    this.#frame((encoder) => stroke.encode(encoder));
  }

  /**
   * Ends the stroke: its last dabs are stamped, its tiles become the layer's, and they are read
   * back for the main thread's history. Undefined when no stroke is running.
   */
  async strokeEnd(): Promise<StrokeCommit | undefined> {
    const stroke = this.#stroke;
    if (!stroke) return undefined;
    this.#stroke = undefined;
    stroke.finish();
    let read: (() => Promise<StrokeTile[]>) | undefined;
    this.#frame((encoder) => {
      stroke.encode(encoder);
      read = stroke.commit(encoder);
    });
    if (!read) return undefined;
    this.#readbacks += 1;
    try {
      return { layerId: stroke.layerId, tiles: await read() };
    } finally {
      this.#readbacks -= 1;
    }
  }

  /** Drops the stroke in progress; the layer shows its own tiles again. */
  strokeCancel(): void {
    const stroke = this.#stroke;
    if (!stroke) return;
    this.#stroke = undefined;
    stroke.cancel();
    this.#frame();
  }

  #geometry(): { doc: Size; viewport: Size } {
    const doc = this.#state?.document;
    return {
      doc: { width: doc?.width ?? 0, height: doc?.height ?? 0 },
      viewport: { width: this.#size.width, height: this.#size.height },
    };
  }

  /**
   * Records and submits one frame: `before` (stroke stamping), stale tile mips, the composite
   * tiles that need blending, and the present pass, all in one submission.
   */
  #frame(before?: (encoder: GPUCommandEncoder) => void): void {
    const start = this.host.presented ? this.host.now() : 0;
    const { doc, viewport } = this.#geometry();
    this.#reportLayout(doc, viewport);
    const state = this.#state;
    if (!state) return;
    this.#retryPresent = false;
    // A present that cannot reach the canvas still submits the frame's stroke and composite work,
    // so a stroke's commit is never lost with it.
    let failure: { error: unknown } | undefined;
    const checked = presentChecked(state.device, () => {
      const encoder = state.device.createCommandEncoder({ label: "v2 frame" });
      before?.(encoder);
      const document = state.document;
      document.pool.flushMips(encoder);
      const plan = planComposite(this.#view, doc, viewport);
      state.compositor.setLive(document.live);
      const slots = state.compositor.encode(
        encoder,
        plan.draws,
        document.table.build(),
        document.table.tilesX,
        doc,
      );
      try {
        if (this.host.presentFault) throw presentFault();
        state.presenter.encode(
          encoder,
          plan,
          frameStyle(this.#theme, this.#size.scale),
          state.compositor.slots,
          slots,
        );
      } catch (error) {
        failure = { error };
      }
      state.device.queue.submit([encoder.finish()]);
      document.pool.afterSubmit();
    });
    if (failure) {
      checked.catch(() => undefined);
      this.#presentFailed(state, failure.error);
    } else {
      checked.then(
        () => {
          if (this.#state === state) this.#presentFailures.succeeded();
        },
        (error: unknown) => this.#presentFailed(state, error),
      );
    }
    this.host.presented?.(start, this.host.now());
  }

  /**
   * A present threw or the GPU reported an error for it. The frame is tried again; after
   * `MAX_PRESENT_FAILURES` failures in a row the engine gives up its device (`#dropDevice`).
   */
  #presentFailed(state: DeviceState, error: unknown): void {
    if (state !== this.#state || this.#fallingBack) return;
    if (!this.#presentFailures.failing) this.host.reportError?.(error);
    if (!this.#presentFailures.failed()) {
      if (!this.#retryPresent) {
        this.#retryPresent = true;
        this.host.requestFrame(() => {
          if (this.#retryPresent) this.#frame();
        });
      }
      return;
    }
    this.#fallingBack = true;
    void this.#serialize(async () => {
      try {
        await this.#dropDevice();
      } finally {
        this.#fallingBack = false;
      }
      return this.status;
    }).then((status) => this.host.emitStatus(status));
  }

  /**
   * Gives up the GPU as after repeated device loss (WEB-GPU-05): the CPU fallback flag is set, the
   * device and its resources are released, and the status reports the CPU backend.
   */
  async #dropDevice(): Promise<void> {
    this.#errorFlags |= GraphicsErrorFlags.CpuFallbackAfterDeviceLoss;
    // A device whose resources failed to build has no state to release it with.
    const orphan = this.#state ? undefined : this.#resolved?.device;
    this.#destroyState();
    orphan?.destroy();
    this.#resolved = await this.#resolve();
  }

  #reportLayout(doc: Size, viewport: Size): void {
    const layout = viewLayout(this.#view, doc, viewport);
    if (JSON.stringify(layout) === JSON.stringify(this.#layout)) return;
    this.#layout = layout;
    this.host.emitView(layout);
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #resolve(): Promise<ResolvedBackend> {
    const resolved = await resolveBackend({
      setting: this.#setting,
      errorFlags: this.#errorFlags,
      gpu: this.host.gpu,
      performanceCache: this.#cache,
      benchmark: (device) => this.host.benchmark(device),
    });
    const { device, adapter } = resolved;
    if (device && adapter && !adapter.isFallbackAdapter) {
      this.#cache = { ...this.#cache, [adapterKey(adapter)]: resolved.performanceClass };
    }
    if (device) this.#resolved = resolved;
    else if (!this.#resolved) this.#resolved = resolved;
    return resolved;
  }

  /** Builds every GPU resource on the resolved device and presents. */
  #activate(resolved: ResolvedBackend): void {
    const device = resolved.device;
    const gpu = this.host.gpu;
    if (!device || !gpu) return;
    this.#destroyState();
    this.#presentFailures.reset();
    const context = this.#context ?? webgpuContext(this.canvas);
    if (!context) throw new Error("WebGPU canvas context is unavailable.");
    this.#context = context;
    this.canvas.width = Math.max(1, this.#size.width);
    this.canvas.height = Math.max(1, this.#size.height);
    const compositor: { current?: GpuCompositorV2 } = {};
    const document = new GpuDocument(device, {
      tileChanged: (tx, ty) => compositor.current?.cache.invalidateTile(tx, ty),
      stackChanged: () => compositor.current?.cache.invalidateAll(),
    });
    compositor.current = new GpuCompositorV2(device, document.pool);
    this.#state = {
      device,
      document,
      compositor: compositor.current,
      presenter: new PresenterV2(device, context, gpu.getPreferredCanvasFormat()),
      pipelines: new StrokePipelines(device),
      slots: new SlotBuffer(device),
    };
    watchUncapturedErrors(device, (error) => this.host.reportError?.(error));
    void device.lost.then(() => {
      if (this.#state?.device === device) void this.#recover();
    });
    this.#frame();
  }

  #destroyState(): void {
    const state = this.#state;
    if (!state) return;
    this.#stroke = undefined;
    this.#state = undefined;
    state.document.destroy();
    state.compositor.destroy();
    state.presenter.destroy();
    state.slots.destroy();
    state.device.destroy();
  }

  /**
   * Recovers from device loss (WEB-GPU-05): a new device, an empty GPU document and a request
   * for a full sync from the main thread, whose document is the backing store. Repeated losses
   * leave the engine without a device, since the canvas cannot switch to the CPU presenter.
   */
  async #recover(): Promise<void> {
    const status = await this.#serialize(async () => {
      if (this.#losses.record(this.host.now())) {
        this.#errorFlags |= GraphicsErrorFlags.CpuFallbackAfterDeviceLoss;
      }
      const resolved = await this.#resolve();
      if (resolved.device) {
        this.#activate(resolved);
        this.host.emitResync();
      } else {
        this.#resolved = resolved;
        this.#destroyState();
      }
      return this.status;
    });
    this.host.emitStatus(status);
  }
}
