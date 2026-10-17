import type { RenderCanvas } from "./canvas";
import { bindPresenter } from "./canvas-binding";
import { initCpu } from "./cpu";
import { DocumentReplica } from "./document-sync";
import { Engine } from "./engine";
import { GpuEffectQueue } from "./gpu-effects";
import { type EnginePerfReport, type PresentBatch, PresentRecorder, perfStages } from "./perf";
import { benchmarkPerformanceClass } from "./performance-class";
import { presentFault as presentFaultError } from "./present-failures";
import type {
  EngineError,
  EngineProtocol,
  EngineSettings,
  EngineSize,
  EngineStatus,
} from "./protocol";
import { type RpcEndpoint, type RpcServer, serveRpc, transfer } from "./rpc";
import { createTestDocument } from "./test-document";
import { EngineV2 } from "./v2/engine-v2";
import type { ViewLayout } from "./view";

/** Distinct worker errors sent to the page per session, beyond which they are dropped. */
const MAX_REPORTED_ERRORS = 20;

/** `cause` as the page receives it; structured cloning would drop an Error's stack. */
export function engineError(cause: unknown): EngineError {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, ...(cause.stack && { stack: cause.stack }) };
  }
  return { name: "Error", message: String(cause) };
}

/**
 * Serves the engine protocol on `endpoint`. The engine worker calls this with its global scope.
 * Without workers (WebKit has no OffscreenCanvas), the main thread calls it with a local channel.
 * `init.engine` picks v1 or v2; v2 falls back to v1 without WebGPU.
 */
export function serveEngine(
  endpoint: RpcEndpoint,
  scope?: Pick<EventTarget, "addEventListener">,
): RpcServer<EngineProtocol> {
  let engine: Engine | undefined;
  let v2: EngineV2 | undefined;
  let frameCallback: (() => void) | undefined;
  let recorder: PresentRecorder | undefined;
  let presentFault = false;
  /** Adds engine v1's `restartCanvas` to a status it returns. */
  let canvasStatus = (status: EngineStatus): EngineStatus => status;
  const reported = new Set<string>();
  /** Sends a worker error to the page once per distinct message (no flood from a per-frame error). */
  const reportError = (cause: unknown) => {
    const error = engineError(cause);
    const key = `${error.name}: ${error.message}`;
    if (reported.has(key) || reported.size >= MAX_REPORTED_ERRORS) return;
    reported.add(key);
    server.emit("error", error);
  };
  // A rejection nobody handles in the worker would only reach the worker's console.
  scope?.addEventListener("unhandledrejection", (event) => {
    reportError((event as PromiseRejectionEvent).reason);
  });
  const replica = new DocumentReplica();
  /** Effects run on whichever device the running engine holds now (one device per app). */
  const effects = new GpuEffectQueue(() => (v2 ?? engine)?.gpuDevice);
  effects.onLateError = (_effectId, error) => reportError(error);
  /** The layout the engine reported last, which is the one its next present shows. */
  let layout: ViewLayout | undefined;
  const emitView = (next: ViewLayout) => {
    layout = next;
    server.emit("view", next);
  };
  const presented = (start: number, end: number, float?: boolean) =>
    recorder?.record(start, end, layout, float);
  const perfReport = ({ presents, views, floats, stages }: PresentBatch): EnginePerfReport => ({
    timeOrigin: performance.timeOrigin,
    presents,
    views,
    ...(floats && { floats }),
    ...(stages && { stages }),
    idle: (engine?.idle ?? true) && (v2?.idle ?? true) && !effects.busy,
  });

  /** Asks the page for a `tick` at its next animation frame, which runs `callback`. */
  const requestFrame = (callback: () => void) => {
    frameCallback = callback;
    server.emit("frame", undefined);
  };

  function started(): Engine | EngineV2 {
    const running = v2 ?? engine;
    if (!running) throw new Error("The engine has not been initialized.");
    return running;
  }

  function startV1(
    canvas: RenderCanvas,
    gpu: GPU | undefined,
    settings: EngineSettings & EngineSize,
  ): Promise<EngineStatus> {
    /** Whether the last presenter found the canvas bound to the other backend's context. */
    let restartCanvas = false;
    const withCanvas = (status: EngineStatus): EngineStatus =>
      restartCanvas ? { ...status, restartCanvas } : status;
    engine = new Engine(
      {
        gpu,
        now: () => performance.now(),
        benchmark: benchmarkPerformanceClass,
        createPresenter: (device) => {
          const bound = bindPresenter(
            canvas,
            gpu ? device : undefined,
            gpu?.getPreferredCanvasFormat() ?? "rgba8unorm",
          );
          restartCanvas = bound.restartCanvas;
          const { presenter } = bound;
          if (presentFault && device && gpu) {
            presenter.present = () => {
              throw presentFaultError();
            };
          }
          return presenter;
        },
        emitStatus: (status) => server.emit("status", withCanvas(status)),
        reportError,
        emitView,
        requestFrame,
        ...(recorder && { presented }),
      },
      settings,
    );
    canvasStatus = withCanvas;
    return engine.start().then(withCanvas);
  }

  const server = serveRpc<EngineProtocol>(endpoint, {
    async init({ canvas, perf, engine: version, fault, ...settings }) {
      if (engine || v2) throw new Error("The engine is already initialized.");
      presentFault = fault === "present";
      await initCpu();
      const gpu = navigator.gpu as GPU | undefined;
      recorder = perf
        ? new PresentRecorder((batch) => server.emit("perf", perfReport(batch)))
        : undefined;
      if (recorder) {
        const kept = recorder;
        perfStages.record = (stage) => kept.stage(stage);
      }
      if (version === "v2" && gpu) {
        const candidate = new EngineV2(
          {
            gpu,
            now: () => performance.now(),
            benchmark: benchmarkPerformanceClass,
            emitStatus: (status) => server.emit("status", status),
            reportError,
            requestFrame,
            presentFault,
            emitView,
            emitResync: () => server.emit("resync", undefined),
            ...(recorder && { presented }),
          },
          settings,
          canvas,
        );
        const status = await candidate.start();
        if (status) {
          v2 = candidate;
          return status;
        }
      }
      return startV1(canvas, gpu, settings);
    },
    setBackend: (setting) => started().setBackend(setting).then(canvasStatus),
    setCanvasStyle(style) {
      started().setCanvasStyle(style);
      return undefined;
    },
    resize(size) {
      started().resize(size);
      return undefined;
    },
    loadTestDocument({ width, height }) {
      const running = started();
      if (running instanceof EngineV2) running.load(createTestDocument(width, height));
      else running.setDocument(createTestDocument(width, height));
      return undefined;
    },
    syncDocument(sync) {
      const running = started();
      if (running instanceof EngineV2) {
        running.sync(sync);
        return undefined;
      }
      const { document, full, restacked } = replica.apply(sync);
      if (full) running.setDocument(document);
      else if (restacked) running.restack(document);
      else running.render();
      running.setFloat(replica.float);
      return undefined;
    },
    view: (command) => started().view(command),
    wheel: (input) => started().wheel(input),
    tick() {
      const callback = frameCallback;
      frameCallback = undefined;
      callback?.();
      return undefined;
    },
    setVisible(visible) {
      started().setVisible(visible);
      return undefined;
    },
    perf: () => perfReport(recorder?.take() ?? { presents: [], views: [] }),
    strokeBegin(begin) {
      v2?.strokeBegin(begin);
      return undefined;
    },
    strokeSamples(samples) {
      v2?.strokeSamples(samples);
      return undefined;
    },
    async strokeEnd() {
      const commit = await v2?.strokeEnd();
      if (!commit) return undefined;
      return transfer(
        commit,
        commit.tiles.map((tile) => tile.pixels.buffer as ArrayBuffer),
      );
    },
    strokeCancel() {
      v2?.strokeCancel();
      return undefined;
    },
    async effectRun(job) {
      const output = await effects.run(job);
      return transfer(output, [output.pixels.buffer]);
    },
    effectCancel(id) {
      effects.cancel(id);
      return undefined;
    },
    effectRelease(source) {
      effects.release(source);
      return undefined;
    },
    effectConfirm: (effectId) => effects.confirm(effectId),
  });
  return server;
}
