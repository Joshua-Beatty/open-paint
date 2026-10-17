import type { Backend, BackendReason, BackendSetting, PerformanceCache } from "./backend";
import type { RenderCanvas } from "./canvas";
import type { DocumentSync } from "./document-sync";
import type { CanvasStyle } from "./frame";
import type { GpuAdapterSummary } from "./gpu-device";
import type { GpuEffectJob, GpuEffectOutput } from "./gpu-effect-protocol";
import type { EnginePerfReport } from "./perf";
import type { PerformanceClass } from "./performance-class";
import type { StrokeCommit } from "./v2/engine-v2";
import type { StrokeBegin } from "./v2/stroke";
import type { ViewCommand, ViewLayout, ViewStatus, WheelInput } from "./view";

/** Graphics settings the engine starts from (SET-STO-03 `graphics.*`). */
export interface EngineSettings {
  backend: BackendSetting;
  errorFlags: number;
  performanceCache: PerformanceCache;
}

/** The canvas size in device pixels (WEB-GPU-07) and the device pixel ratio it was sized for. */
export interface EngineSize {
  width: number;
  height: number;
  scale: number;
}

export interface EngineInit extends EngineSettings, EngineSize {
  /**
   * The on-screen canvas. A worker gets it transferred; without workers it is the page's own
   * canvas, drawn to on the main thread.
   */
  canvas: RenderCanvas;
  /** Records present timings for the benchmark harness (`?perf=1`). Off by default. */
  perf?: boolean;
  /**
   * The rendering engine to run (`?engine=v2`). v1 when absent. v2 needs the
   * WebGPU backend and falls back to v1 without it; `EngineStatus.engine` tells which runs.
   */
  engine?: EngineVersion;
  /**
   * Test hook (`?gpu-fault=present`): every GPU present fails, as on a canvas that cannot present,
   * so the CPU fallback can be exercised end to end.
   */
  fault?: "present";
}

export type EngineVersion = "v1" | "v2";

/** An error the engine worker caught or recovered from, sent so the page can log it. */
export interface EngineError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

/** What the Graphics settings page and diagnostics show about rendering (SET-DLG-07). */
export interface EngineStatus {
  setting: BackendSetting;
  backend: Backend;
  reason: BackendReason;
  webgpuAvailable: boolean;
  adapter?: GpuAdapterSummary;
  performanceClass: PerformanceClass;
  /** `graphics.errorFlags` to persist. */
  errorFlags: number;
  /** Performance classes to persist, including any measured this session. */
  performanceCache: PerformanceCache;
  /** GPU device losses this session. */
  deviceLossCount: number;
  /** The engine running: v2 only when it was asked for and WebGPU is in use. v1 when absent. */
  engine?: EngineVersion;
  /**
   * Engine v1: the canvas is bound to the other backend's context (WebGPU for the CPU backend, or a
   * bitmap renderer for the GPU one), so the page should start the engine again on a new canvas
   * with this status's backend setting and error flags. Until then it shows the last frame (CPU),
   * or presents through a slower bitmap copy (GPU).
   */
  restartCanvas?: boolean;
}

export type EngineProtocol = {
  requests: {
    init: { params: EngineInit; result: EngineStatus };
    setBackend: { params: BackendSetting; result: EngineStatus };
    /** Applies the canvas drop shadow, checkerboard and border settings and presents (SET-DLG-04). */
    setCanvasStyle: { params: CanvasStyle; result: undefined };
    resize: { params: EngineSize; result: undefined };
    /** Replaces the shown document with a generated test pattern (M0.09). */
    loadTestDocument: { params: { width: number; height: number }; result: undefined };
    /** Mirrors the shown document's layers and changed tiles into the engine (M2 binding). */
    syncDocument: { params: DocumentSync; result: undefined };
    view: { params: ViewCommand; result: ViewStatus };
    wheel: { params: WheelInput; result: ViewStatus };
    /** Runs the tile slice the worker asked for in its last `frame` event (ARC-03-08). */
    tick: { params: undefined; result: undefined };
    /** Trims GPU resources while the page is hidden and repaints when it returns (ARC-03-10). */
    setVisible: { params: boolean; result: undefined };
    /**
     * Drains the recorded presents and reports whether the engine is idle. It is answered after
     * every earlier message, so pending syncs count. Presents are empty unless `init.perf` was set.
     */
    perf: { params: undefined; result: EnginePerfReport };
    /** Engine v2: starts a Paintbrush or Eraser stroke painted in the worker. */
    strokeBegin: { params: StrokeBegin; result: undefined };
    /** Engine v2: a batch of samples, flat `x, y, pressure` in image pixels. */
    strokeSamples: { params: Float32Array; result: undefined };
    /** Engine v2: ends the stroke and answers with its painted tiles once they are read back. */
    strokeEnd: { params: undefined; result: StrokeCommit | undefined };
    /** Engine v2: drops the stroke in progress. */
    strokeCancel: { params: undefined; result: undefined };
    /**
     * Runs an effect's WGSL twin on the engine's GPU device (WEB-GPU-01). Rejects when the engine
     * has no device or the run fails, and the caller then uses the CPU (WEB-GPU-04).
     */
    effectRun: { params: GpuEffectJob; result: GpuEffectOutput };
    /** Drops an effect run that is waiting, or the output of one that is running. */
    effectCancel: { params: number; result: undefined };
    /** Forgets an effect source the worker keeps between previews. */
    effectRelease: { params: number; result: undefined };
    /**
     * After the runs queued so far, whether the GPU reported no error for an effect's runs since
     * its last confirmation: runs return their pixels before the GPU reports.
     */
    effectConfirm: { params: string; result: boolean };
  };
  events: {
    /** Engine v2 lost its GPU document (device loss) and needs a full `syncDocument`. */
    resync: undefined;
    /** Sent whenever the status changes without a request, e.g. after device loss. */
    status: EngineStatus;
    /**
     * An error in the worker that no request returns: a failed present, an unhandled rejection or
     * an uncaptured GPU error. Each distinct message is sent once.
     */
    error: EngineError;
    /** The worker has more tiles to build and asks for a `tick` at the next animation frame. */
    frame: undefined;
    /** The view layout changed: zoom, mode, image origin or size (UI-SB-01, UI-SB-03). */
    view: ViewLayout;
    /** Recorded presents, sent in batches a few times per second when `init.perf` was set. */
    perf: EnginePerfReport;
  };
};
