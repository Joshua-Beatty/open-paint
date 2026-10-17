import { type Rect, rect, type Size } from "@openpaint/document";
import {
  type BackendSetting,
  GraphicsErrorFlags,
  type PerformanceCache,
  type ResolvedBackend,
  resolveBackend,
} from "./backend";
import { type CompositeDocument, EMPTY_DOCUMENT } from "./composite";
import { DeviceLossTracker } from "./device-loss";
import {
  DisplayTileBuilder,
  DisplayTileCache,
  displayLevels,
  mipLevel,
  type TileRef,
  tileEdge,
} from "./display-tiles";
import type { FloatLayer } from "./document-sync";
import { FloatDisplay } from "./float-display";
import {
  type CanvasStyle,
  type CanvasTheme,
  canvasTheme,
  DEFAULT_CANVAS_THEME,
  type FramePlan,
  planFrame,
} from "./frame";
import { adapterKey } from "./gpu-device";
import { perfStages, timedStage } from "./perf";
import type { PerformanceClass } from "./performance-class";
import { PresentFailureTracker, watchUncapturedErrors } from "./present-failures";
import type { Presenter, TileOverrides } from "./presenter";
import type { EngineSettings, EngineSize, EngineStatus } from "./protocol";
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
} from "./view";

/** Display tiles drawn from floating content, and the image region the content can change. */
interface FloatTiles {
  readonly tiles: TileOverrides;
  readonly region: Rect;
}

/** Platform services the engine runs on; the worker supplies real ones, tests supply fakes. */
export interface EngineHost {
  gpu: GPU | undefined;
  now(): number;
  benchmark(device: GPUDevice): Promise<PerformanceClass>;
  /** A presenter for `device`, or for the CPU backend when `device` is undefined. */
  createPresenter(device: GPUDevice | undefined): Presenter;
  /** Reports status changes that no request returns (device loss, failed presents). */
  emitStatus(status: EngineStatus): void;
  /** Reports an error the engine recovered from or worked around, so the page can log it. */
  reportError?(error: unknown): void;
  /** Reports the view layout whenever it changes (zoom, origin, image size). */
  emitView(layout: ViewLayout): void;
  /** Runs `callback` in a later task, so that tile builds never block message handling. */
  requestFrame(callback: () => void): void;
  /**
   * Called after each present with the frame's start and end (`now()` ms), for the benchmark
   * harness, and whether it showed floating content. Absent unless the app runs with `?perf=1`.
   */
  presented?(start: number, end: number, float?: boolean): void;
}

/** Milliseconds of tile building per slice before the engine yields (ARC-03-06). */
const TILE_SLICE_MS = 12;
/**
 * Milliseconds of tile building done before presenting a frame. Small edits (a brush dab) rebuild
 * their few tiles within this budget and appear in the same frame. Larger ones keep the stale
 * tiles on screen and finish in later slices.
 */
const PRESENT_BUILD_MS = 6;
/**
 * Milliseconds without an edit before draft mip tiles on screen are rebuilt with Lanczos-3
 * (ARC-03-04), so the slower final build never competes with an edit in progress.
 */
export const REFINE_DELAY_MS = 150;

/**
 * The engine worker's rendering core. It resolves the backend and owns the GPU device and
 * presenter. It also owns the view (fit or fixed zoom, pan) and the display tile cache that feeds
 * the presenter. It recovers from device loss by recreating the device and presenting again from
 * the CPU tiles, falling back to the CPU backend after repeated losses (WEB-GPU-05). A GPU
 * presenter that cannot be created, or fails `MAX_PRESENT_FAILURES` presents in a row, takes the
 * same fallback, so the canvas never stays blank.
 */
export class Engine {
  readonly #tiles = new DisplayTileCache();
  readonly #builder = new DisplayTileBuilder(this.#tiles, () => this.#document);
  readonly #losses = new DeviceLossTracker();
  readonly #presentFailures = new PresentFailureTracker();
  /** A present failed and the next frame tries again. */
  #retryPresent = false;
  /** Persistent present failures are moving the engine to the CPU backend. */
  #fallingBack = false;
  #theme: CanvasTheme = DEFAULT_CANVAS_THEME;
  #setting: BackendSetting;
  #errorFlags: number;
  #cache: PerformanceCache;
  #size: EngineSize;
  #resolved: ResolvedBackend | undefined;
  #presenter: Presenter | undefined;
  #document: CompositeDocument = EMPTY_DOCUMENT;
  #view: ViewState = FIT_VIEW;
  #layout: ViewLayout | undefined;
  #scheduled = false;
  #queue: Promise<unknown> = Promise.resolve();
  /** When the document last changed (`now()`), which holds back the final mip builds. */
  #lastEdit = Number.NEGATIVE_INFINITY;
  /** The tiles the last frame drew, whose drafts are refined once edits pause. */
  #drawn: TileRef[] = [];
  /** The floating content shown over its layer, and what draws it on the current device. */
  #float: FloatLayer | undefined;
  #floatDisplay: { readonly device: GPUDevice; readonly display: FloatDisplay } | undefined;
  /** The float tiles the last frame drew, and the ones kept after the float went until tiles are fresh. */
  #shownTiles: FloatTiles | undefined;
  #retiring: FloatTiles | undefined;

  constructor(
    readonly host: EngineHost,
    settings: EngineSettings & EngineSize,
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
    };
  }

  /** The WebGPU device the engine renders with, or undefined on the CPU backend. */
  get gpuDevice(): GPUDevice | undefined {
    return this.#resolved?.device;
  }

  /** True when no tile builds are pending and no frame is scheduled. */
  get idle(): boolean {
    return !this.#scheduled && !this.#builder.pending;
  }

  start(): Promise<EngineStatus> {
    return this.#serialize(() => this.#activate());
  }

  /** Applies a user-picked backend; this clears the device-loss fallback (SET-DLG-07). */
  setBackend(setting: BackendSetting): Promise<EngineStatus> {
    return this.#serialize(() => {
      this.#setting = setting;
      this.#errorFlags &= ~GraphicsErrorFlags.CpuFallbackAfterDeviceLoss;
      this.#losses.reset();
      this.#presentFailures.reset();
      return this.#activate();
    });
  }

  /** Applies the canvas chrome settings (SET-DLG-04) and presents the frame again. */
  setCanvasStyle(style: CanvasStyle): void {
    this.#theme = canvasTheme(style);
    this.#frame();
  }

  /** Replaces the document shown on the canvas and presents it. */
  setDocument(doc: CompositeDocument): void {
    this.#document = doc;
    this.#lastEdit = this.host.now();
    this.#tiles.clear();
    this.#builder.clear();
    this.render();
  }

  /**
   * Shows a new layer stack of the same size, such as a hidden layer or a new blend mode. Every
   * display tile is marked stale rather than dropped, so the canvas keeps the previous image until
   * each tile's rebuild replaces it (L4), instead of flashing to the checkerboard.
   */
  restack(doc: CompositeDocument): void {
    if (doc.width !== this.#document.width || doc.height !== this.#document.height) {
      this.setDocument(doc);
      return;
    }
    this.#document = doc;
    this.#lastEdit = this.host.now();
    this.#tiles.invalidate(rect(0, 0, doc.width, doc.height));
    this.render();
  }

  /**
   * Drops the display tiles that cover edited areas and presents again. Tiles are rebuilt from the
   * CPU store on demand, so an edit only costs the tiles it touched.
   */
  render(): void {
    for (const layer of this.#document.layers) {
      for (const { tx, ty } of layer.store.takeDirtyTiles()) {
        this.#lastEdit = this.host.now();
        this.#tiles.invalidate(layer.store.tileBounds(tx, ty));
      }
    }
    this.#frame();
  }

  /**
   * Trims the presenter's cached resources while the page is hidden (ARC-03-10). Returning to view
   * presents again, which also resumes any tile builds that were waiting for animation frames.
   */
  setVisible(visible: boolean): void {
    if (visible) this.#frame();
    else this.#presenter?.trim();
  }

  /** Applies a new canvas size in device pixels and the device pixel ratio it was sized for. */
  resize(size: EngineSize): void {
    this.#size = size;
    this.#applySize();
  }

  /** Runs a navigation command and returns the view it leaves (UI-VIEW-01). */
  view(command: ViewCommand): ViewStatus {
    const { doc, viewport } = this.#geometry();
    this.#view = applyCommand(this.#view, doc, viewport, command);
    this.#frame();
    return viewStatus(this.#view, doc, viewport);
  }

  /** Applies a wheel event: Ctrl+wheel zooms around the pointer, other wheel input scrolls. */
  wheel(input: WheelInput): ViewStatus {
    const { doc, viewport } = this.#geometry();
    this.#view = applyWheel(this.#view, doc, viewport, this.#size.scale, input);
    this.#frame();
    return viewStatus(this.#view, doc, viewport);
  }

  #geometry() {
    const doc = { width: this.#document.width, height: this.#document.height };
    const viewport = { width: this.#size.width, height: this.#size.height };
    return { doc, viewport };
  }

  #applySize(): void {
    this.#presenter?.resize(this.#size.width, this.#size.height);
    this.#frame();
  }

  /**
   * Plans and presents a frame. Missing and stale tiles are requested first, and some are built
   * right away (`buildBudgetMs`), so edits show up without a frame where their tiles are absent.
   * `startedAt` is when the frame's work began, for `host.presented` (a tick's slice counts too).
   */
  #frame(buildBudgetMs = PRESENT_BUILD_MS, startedAt?: number): void {
    const start = startedAt ?? (this.host.presented ? this.host.now() : 0);
    const { doc, viewport } = this.#geometry();
    this.#reportLayout(doc, viewport);
    const presenter = this.#presenter;
    if (!presenter) return;
    let plan = this.#plan(doc, viewport);
    this.#request(plan);
    if (buildBudgetMs > 0 && this.#builder.pending) {
      const deadline = this.host.now() + buildBudgetMs;
      if (this.#builder.pump(deadline, () => this.host.now()) > 0) {
        plan = this.#plan(doc, viewport);
        this.#request(plan);
      }
    }
    this.#retryPresent = false;
    try {
      const checked = presenter.present(plan, this.#floatTiles(plan, doc));
      if (checked) {
        checked.then(
          () => this.#presented(presenter),
          (error: unknown) => this.#presentFailed(presenter, error),
        );
      } else {
        this.#presented(presenter);
      }
    } catch (error) {
      this.#presentFailed(presenter, error);
    }
    const floatShown = (this.#shownTiles?.tiles.size ?? 0) > 0;
    this.host.presented?.(start, this.host.now(), floatShown);
    if (floatShown && perfStages.record) {
      const record = perfStages.record;
      void this.gpuDevice?.queue
        .onSubmittedWorkDone()
        .then(() => record({ name: "float gpu", start, end: this.host.now() }));
    }
    if (this.#builder.pending || this.#refinePending()) this.#schedule();
  }

  /**
   * Shows floating content over its layer (TL-MOVE-PIX-01), drawn on the GPU (`FloatDisplay`); the
   * layer's display tiles stay as they are. Undefined takes it down once the display tiles under it
   * are up to date again, so a commit's pixels replace it without a flash of the old ones (L4).
   */
  setFloat(float: FloatLayer | undefined): void {
    if (float === this.#float) return;
    if (float === undefined && this.#float !== undefined) this.#retiring = this.#shownTiles;
    if (float !== undefined) this.#retiring = undefined;
    this.#float = float;
    this.#frame();
  }

  /**
   * The display tiles this frame draws from the float (`FloatDisplay`), or the last ones after the
   * float went, until the cached tiles under it are up to date again.
   */
  #floatTiles(plan: FramePlan, doc: Size): TileOverrides | undefined {
    const device = this.gpuDevice;
    const float = this.#float;
    if (device === undefined || (float === undefined && this.#retiring === undefined)) {
      this.#shownTiles = undefined;
      return undefined;
    }
    const level = mipLevel(plan.zoom, displayLevels(doc.width, doc.height));
    let shown: FloatTiles | undefined;
    if (float !== undefined) {
      if (this.#floatDisplay?.device !== device) {
        this.#floatDisplay?.display.destroy();
        this.#floatDisplay = {
          device,
          display: timedStage("float pipelines", () => new FloatDisplay(device)),
        };
      }
      const { display } = this.#floatDisplay;
      if (display.supports(this.#document, float)) {
        const visible = plan.tiles.map((draw) => draw.tile);
        const tiles = display.tiles(this.#document, float, level, visible, (ref) =>
          this.#builder.final(ref),
        );
        shown = { tiles, region: float.base.region };
      }
    } else {
      shown = this.#retiring;
      const region = shown?.region;
      const edge = tileEdge(level);
      const waiting =
        region !== undefined &&
        plan.wanted.some(
          ({ tx, ty }) =>
            tx * edge < region.x + region.width &&
            region.x < (tx + 1) * edge &&
            ty * edge < region.y + region.height &&
            region.y < (ty + 1) * edge,
        );
      if (!waiting) {
        this.#retiring = undefined;
        this.#floatDisplay?.display.release();
        shown = undefined;
      }
    }
    this.#shownTiles = shown;
    return shown?.tiles;
  }
  #presented(presenter: Presenter): void {
    if (presenter === this.#presenter) this.#presentFailures.succeeded();
  }

  /**
   * A present threw or the GPU reported an error for it. The frame is tried again; after
   * `MAX_PRESENT_FAILURES` failures in a row on the GPU, the engine moves to the CPU backend, as
   * after repeated device loss, and reports the status (WEB-GPU-05).
   */
  #presentFailed(presenter: Presenter, error: unknown): void {
    if (presenter !== this.#presenter || this.#fallingBack) return;
    // The first failure of a streak is logged; the rest are most likely the same error.
    if (!this.#presentFailures.failing) this.host.reportError?.(error);
    if (!this.#presentFailures.failed()) {
      this.#retryPresent = true;
      this.#schedule();
      return;
    }
    // The CPU presenter has nothing to fall back to, and stops retrying.
    if (!this.gpuDevice) return;
    this.#fallingBack = true;
    this.#errorFlags |= GraphicsErrorFlags.CpuFallbackAfterDeviceLoss;
    void this.#serialize(async () => {
      try {
        return await this.#activate();
      } finally {
        this.#fallingBack = false;
      }
    }).then((status) => this.host.emitStatus(status));
  }

  /** Asks for the plan's missing tiles, or once edits have paused, for its drafts' final builds. */
  #request(plan: FramePlan): void {
    this.#drawn = plan.tiles.map(({ tile }) => tile);
    const settled = this.host.now() - this.#lastEdit >= REFINE_DELAY_MS;
    this.#builder.request(plan.wanted, settled ? this.#drawn : []);
  }

  /** Whether draft tiles on screen still wait for their final build. */
  #refinePending(): boolean {
    return this.#drawn.some((tile) => this.#tiles.isDraft(tile));
  }

  #plan(doc: Size, viewport: Size): FramePlan {
    return planFrame({
      view: this.#view,
      doc,
      viewport,
      scale: this.#size.scale,
      theme: this.#theme,
      lookup: (level, tx, ty) => this.#tiles.get(level, tx, ty),
      stale: (level, tx, ty) => this.#tiles.isStale(level, tx, ty),
    });
  }

  #reportLayout(doc: Size, viewport: Size): void {
    const layout = viewLayout(this.#view, doc, viewport);
    if (JSON.stringify(layout) === JSON.stringify(this.#layout)) return;
    this.#layout = layout;
    this.host.emitView(layout);
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.host.requestFrame(() => this.#tick());
  }

  #tick(): void {
    this.#scheduled = false;
    const started = this.host.now();
    const built = this.#builder.pump(started + TILE_SLICE_MS, () => this.host.now());
    if (built > 0 || this.#retryPresent) this.#frame(0, started);
    else if (this.#builder.pending) this.#schedule();
    else if (this.#refinePending()) {
      // Waits for the edits to pause, then plans a frame, which queues the final builds.
      if (started - this.#lastEdit >= REFINE_DELAY_MS) this.#frame(0, started);
      else this.#schedule();
    }
  }

  #serialize(task: () => Promise<EngineStatus>): Promise<EngineStatus> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #activate(): Promise<EngineStatus> {
    const resolved = await resolveBackend({
      setting: this.#setting,
      errorFlags: this.#errorFlags,
      gpu: this.host.gpu,
      performanceCache: this.#cache,
      benchmark: (device) => this.host.benchmark(device),
    });
    const previous = this.#resolved?.device;
    this.#resolved = resolved;
    previous?.destroy();

    const { device, adapter } = resolved;
    if (device && adapter && !adapter.isFallbackAdapter) {
      this.#cache = { ...this.#cache, [adapterKey(adapter)]: resolved.performanceClass };
    }
    this.#presentFailures.reset();
    try {
      this.#presenter = this.host.createPresenter(device);
    } catch (error) {
      // A GPU presenter that cannot be built (no WebGPU canvas context, a failed configure) leaves
      // the canvas blank, so the CPU backend takes over as after repeated device loss.
      if (!device) throw error;
      this.host.reportError?.(error);
      this.#errorFlags |= GraphicsErrorFlags.CpuFallbackAfterDeviceLoss;
      return this.#activate();
    }
    this.#applySize();
    if (device) {
      watchUncapturedErrors(device, (error) => this.host.reportError?.(error));
      void device.lost.then(() => {
        if (this.#resolved?.device === device) void this.#recover();
      });
    }
    return this.status;
  }

  async #recover(): Promise<void> {
    const status = await this.#serialize(() => {
      if (this.#losses.record(this.host.now())) {
        this.#errorFlags |= GraphicsErrorFlags.CpuFallbackAfterDeviceLoss;
      }
      return this.#activate();
    });
    this.host.emitStatus(status);
  }
}
