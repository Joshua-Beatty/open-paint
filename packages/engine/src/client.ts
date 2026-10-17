import type { BackendSetting } from "./backend";
import type { RenderCanvas } from "./canvas";
import type { DocumentSync } from "./document-sync";
import { serveEngine } from "./engine-host";
import type { CanvasStyle } from "./frame";
import type { GpuEffectJob, GpuEffectOutput } from "./gpu-effect-protocol";
import type { EnginePerfReport } from "./perf";
import type {
  EngineError,
  EngineInit,
  EngineProtocol,
  EngineSettings,
  EngineSize,
  EngineStatus,
  EngineVersion,
} from "./protocol";
import { createLocalChannel, createRpcClient, type RpcEndpoint, transfer } from "./rpc";
import type { StrokeCommit } from "./v2/engine-v2";
import type { StrokeBegin } from "./v2/stroke";
import type { ViewCommand, ViewLayout, ViewStatus, WheelInput } from "./view";

/** Factory defaults of the `graphics.*` settings (SET-STO-03). */
export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  backend: "Automatic",
  errorFlags: 0,
  performanceCache: {},
};

/** Main-thread handle to the engine worker. */
export interface EngineHandle {
  readonly status: EngineStatus;
  /** The engine running in the worker: v2 only when asked for and on WebGPU. */
  readonly version: EngineVersion;
  /** Called with every status change, whether requested or caused by device loss. */
  onStatus(listener: (status: EngineStatus) => void): () => void;
  /**
   * Called with each error the worker caught or recovered from (a failed present, an unhandled
   * rejection, an uncaptured GPU error). Errors from before the first listener are kept for it.
   */
  onError(listener: (error: EngineError) => void): () => void;
  /**
   * Called with the view layout after each change. A listener added later gets the latest layout
   * at once, so it never misses the first one.
   */
  onLayout(listener: (layout: ViewLayout) => void): () => void;
  setBackend(setting: BackendSetting): Promise<EngineStatus>;
  setCanvasStyle(style: CanvasStyle): Promise<void>;
  resize(size: EngineSize): Promise<void>;
  loadTestDocument(width: number, height: number): Promise<void>;
  /** Shows the document. Pass the mirror's description after every change (see `DocumentMirror`). */
  syncDocument(doc: DocumentSync): Promise<void>;
  /** Engine v2: called when the worker lost its GPU document and needs a full sync. */
  onResync(listener: () => void): () => void;
  view(command: ViewCommand): Promise<ViewStatus>;
  wheel(input: WheelInput): Promise<ViewStatus>;
  setVisible(visible: boolean): Promise<void>;
  /** Engine v2: starts a Paintbrush or Eraser stroke painted in the worker. */
  strokeBegin(begin: StrokeBegin): Promise<void>;
  /** Engine v2: sends samples (flat `x, y, pressure` in image pixels). The buffer moves. */
  strokeSamples(samples: Float32Array): Promise<void>;
  /** Engine v2: ends the stroke; resolves with its painted tiles, or undefined without one. */
  strokeEnd(): Promise<StrokeCommit | undefined>;
  strokeCancel(): Promise<void>;
  /** Runs an effect's WGSL twin on the engine's device. The job's pixels and coverage move. */
  effectRun(job: GpuEffectJob): Promise<GpuEffectOutput>;
  effectCancel(id: number): Promise<void>;
  effectRelease(source: number): Promise<void>;
  /** Drains the engine's recorded presents and reports whether it is idle (`?perf=1` harness). */
  perf(): Promise<EnginePerfReport>;
  /** Called with each batch of presents the engine sends on its own (`?perf=1` harness). */
  onPerf(listener: (report: EnginePerfReport) => void): () => void;
  terminate(): void;
}

/** Only an `OffscreenCanvas` can move to a worker. A page canvas stays on the main thread. */
function transferablesOf(canvas: RenderCanvas): Transferable[] {
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) return [];
  return [canvas as OffscreenCanvas];
}

/** Spawns the dedicated engine worker. */
export function createEngineWorker(): Worker {
  return new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "OpenPaint engine",
  });
}

/** Initializes the engine behind `endpoint`, transferring the canvas in `init` to it. */
export async function connectEngine(
  endpoint: RpcEndpoint & { terminate?(): void },
  init: EngineInit,
): Promise<EngineHandle> {
  const rpc = createRpcClient<EngineProtocol>(endpoint);
  const listeners = new Set<(status: EngineStatus) => void>();
  const layoutListeners = new Set<(layout: ViewLayout) => void>();
  const perfListeners = new Set<(report: EnginePerfReport) => void>();
  const resyncListeners = new Set<() => void>();
  const errorListeners = new Set<(error: EngineError) => void>();
  const earlyErrors: EngineError[] = [];
  let status: EngineStatus;
  let layout: ViewLayout | undefined;
  const update = (next: EngineStatus) => {
    status = next;
    for (const listener of listeners) listener(next);
    return next;
  };
  rpc.on("status", update);
  rpc.on("error", (error) => {
    if (errorListeners.size === 0) earlyErrors.push(error);
    for (const listener of errorListeners) listener(error);
  });
  rpc.on("view", (next) => {
    layout = next;
    for (const listener of layoutListeners) listener(next);
  });
  rpc.on("perf", (report) => {
    for (const listener of perfListeners) listener(report);
  });
  rpc.on("resync", () => {
    for (const listener of resyncListeners) listener();
  });
  rpc.on("frame", () => {
    requestAnimationFrame(() => void rpc.call("tick", undefined).catch(() => undefined));
  });
  try {
    status = await rpc.call("init", transfer(init, transferablesOf(init.canvas)));
  } catch (error) {
    rpc.close();
    endpoint.terminate?.();
    throw error;
  }
  const version: EngineVersion = status.engine ?? "v1";
  return {
    get status() {
      return status;
    },
    version,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      for (const error of earlyErrors.splice(0)) listener(error);
      return () => errorListeners.delete(listener);
    },
    onLayout(listener) {
      layoutListeners.add(listener);
      if (layout) listener(layout);
      return () => layoutListeners.delete(listener);
    },
    setBackend: async (setting) => update(await rpc.call("setBackend", setting)),
    setCanvasStyle: (style) => rpc.call("setCanvasStyle", style),
    resize: (size) => rpc.call("resize", size),
    loadTestDocument: (width, height) => rpc.call("loadTestDocument", { width, height }),
    syncDocument: (doc) => rpc.call("syncDocument", doc),
    onResync(listener) {
      resyncListeners.add(listener);
      return () => resyncListeners.delete(listener);
    },
    view: (command) => rpc.call("view", command),
    wheel: (input) => rpc.call("wheel", input),
    setVisible: (visible) => rpc.call("setVisible", visible),
    strokeBegin: (begin) => {
      const buffers = begin.mask ? [begin.mask.data.buffer as ArrayBuffer] : [];
      return rpc.call("strokeBegin", transfer(begin, buffers));
    },
    strokeSamples: (samples) =>
      rpc.call("strokeSamples", transfer(samples, [samples.buffer as ArrayBuffer])),
    strokeEnd: () => rpc.call("strokeEnd", undefined),
    strokeCancel: () => rpc.call("strokeCancel", undefined),
    effectRun: (job) => {
      const buffers: ArrayBuffer[] = [];
      if (job.pixels) buffers.push(job.pixels.buffer);
      if (job.coverage) buffers.push(job.coverage.buffer);
      return rpc.call("effectRun", transfer(job, buffers));
    },
    effectCancel: (id) => rpc.call("effectCancel", id),
    effectRelease: (source) => rpc.call("effectRelease", source),
    perf: () => rpc.call("perf", undefined),
    onPerf(listener) {
      perfListeners.add(listener);
      return () => perfListeners.delete(listener);
    },
    terminate() {
      rpc.close();
      endpoint.terminate?.();
    },
  };
}

export interface StartEngineOptions {
  /** Called when the worker reports an uncaught error, so the app can log it (SET-ERR-01). */
  readonly onWorkerError?: (event: ErrorEvent) => void;
  /** Records present timings for the benchmark harness (`?perf=1`). */
  readonly perf?: boolean;
  /** The engine to run (`?engine=v2`). v1 by default. */
  readonly engine?: EngineVersion;
  /** Test hook (`?gpu-fault=present`): every GPU present fails. */
  readonly fault?: "present";
}

/** Moves `canvas` rendering into a new engine worker (D5, ARC-07-02). */
export function startEngine(
  canvas: HTMLCanvasElement,
  size: EngineSize,
  settings: EngineSettings = DEFAULT_ENGINE_SETTINGS,
  options: StartEngineOptions = {},
): Promise<EngineHandle> {
  const extra = {
    ...(options.perf === true && { perf: true }),
    ...(options.engine === "v2" && { engine: "v2" as const }),
    ...(options.fault && { fault: options.fault }),
  };
  if (typeof canvas.transferControlToOffscreen !== "function") {
    const [client, server] = createLocalChannel();
    serveEngine(server);
    return connectEngine(client, { ...settings, ...size, ...extra, canvas });
  }
  const worker = createEngineWorker();
  if (options.onWorkerError) worker.addEventListener("error", options.onWorkerError);
  return connectEngine(worker, {
    ...settings,
    ...size,
    ...extra,
    canvas: canvas.transferControlToOffscreen(),
  });
}
