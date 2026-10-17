import { bitmapContext, type RenderCanvas } from "./canvas";
import { initCpu } from "./cpu";
import { DocumentReplica } from "./document-sync";
import { Engine } from "./engine";
import { GpuEffectQueue } from "./gpu-effects";
import { type EnginePerfReport, type PresentBatch, PresentRecorder } from "./perf";
import { benchmarkPerformanceClass } from "./performance-class";
import { presentFault as presentFaultError } from "./present-failures";
import { CpuPresenter, GpuPresenter } from "./presenter";
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
  /** The layout the engine reported last, which is the one its next present shows. */
  let layout: ViewLayout | undefined;
  const emitView = (next: ViewLayout) => {
    layout = next;
    server.emit("view", next);
  };
  const presented = (start: number, end: number) => recorder?.record(start, end, layout);
  const perfReport = ({ presents, views }: PresentBatch): EnginePerfReport => ({
    timeOrigin: performance.timeOrigin,
    presents,
    views,
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
    const output = bitmapContext(canvas);
    if (!output) throw new Error("The canvas cannot present bitmaps.");
    engine = new Engine(
      {
        gpu,
        now: () => performance.now(),
        benchmark: benchmarkPerformanceClass,
        createPresenter: (device) => {
          if (!device || !gpu) return new CpuPresenter(output);
          const presenter = new GpuPresenter(output, device, gpu.getPreferredCanvasFormat());
          if (presentFault) {
            presenter.present = () => {
              throw presentFaultError();
            };
          }
          return presenter;
        },
        emitStatus: (status) => server.emit("status", status),
        reportError,
        emitView,
        requestFrame,
        ...(recorder && { presented }),
      },
      settings,
    );
    return engine.start();
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
    setBackend: (setting) => started().setBackend(setting),
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
  });
  return server;
}
