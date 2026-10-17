import type { EngineHandle, EnginePerfReport } from "@openpaint/engine";
import { PERF_FLAGS } from "./flags";
import type {
  PerfInput,
  PerfOverlay,
  PerfPresent,
  PerfPreview,
  PerfSnapshot,
  PerfTask,
} from "./stats";

/** What `idle()` resolves with: whether the app went idle in time, and when it was seen idle. */
export interface PerfIdle {
  readonly idle: boolean;
  readonly at: number;
  /** When it gave up: what was still busy the last time it looked ("engine", or a check's reason). */
  readonly busy?: readonly string[];
}

/** An idle check: true when idle, false or what is busy (e.g. "effect render") otherwise. */
export type IdleCheck = () => boolean | string;

/** `window.__openpaintPerf`, present only with `?perf=1`. */
export interface PerfApi {
  /** Forgets everything recorded so far. */
  reset(): void;
  /** Collects the engine's latest presents, then returns everything recorded since `reset`. */
  snapshot(): Promise<PerfSnapshot>;
  /** Like `snapshot`, then forgets what it returned, so a long session can be collected in parts. */
  take(): Promise<PerfSnapshot>;
  /**
   * Resolves once the engine has no tile builds pending or frames scheduled and the app's idle
   * checks pass (no history step or effect render in flight), on two frames in a row.
   */
  idle(timeoutMs?: number): Promise<PerfIdle>;
  /** Stores the current time under `name` and returns it. */
  mark(name: string): number;
  /**
   * Starts or stops recording when each frame's paint is done (`PerfSnapshot.paints`). It keeps
   * frames running while on, so turn it on for a measurement only.
   */
  trackFrames(on: boolean): void;
}

declare global {
  interface Window {
    __openpaintPerf?: PerfApi;
  }
}

/** How long `idle()` waits by default before it gives up. */
const IDLE_TIMEOUT_MS = 120_000;

const POINTER_KINDS = ["pointerdown", "pointermove", "pointerup"] as const;

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function supports(type: string): boolean {
  return (
    typeof PerformanceObserver !== "undefined" &&
    (PerformanceObserver.supportedEntryTypes?.includes(type) ?? false)
  );
}

function isEngineCanvas(target: EventTarget | null): boolean {
  return target instanceof HTMLCanvasElement && target.closest("[data-backend]") !== null;
}

/** The next animation frame, or a short timeout when frames are not running. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Main-thread side of the benchmark instrumentation. It records input
 * timestamps, long tasks and long animation frames, and the engine's presents, all on the main
 * thread's clock. It exists only with `?perf=1`, so a normal page load pays one flag check.
 */
export class PerfMonitor {
  #presents: PerfPresent[] = [];
  #inputs: PerfInput[] = [];
  #longTasks: PerfTask[] = [];
  #longFrames: PerfTask[] = [];
  #overlays: PerfOverlay[] = [];
  #paints: number[] = [];
  #previews: PerfPreview[] = [];
  #tracking: { frame: number; channel: MessageChannel } | undefined;
  #marks: Record<string, number> = {};
  #engine: EngineHandle | undefined;
  readonly #idleChecks = new Set<IdleCheck>();

  constructor(readonly engineName: string) {}

  /** Starts recording on `target` and exposes `__openpaintPerf` there. */
  install(target: Window): void {
    const record = (event: Event) => {
      const kind = event.type as PerfInput["kind"];
      // A shortcut's modifier is not an input of its own; its key press is.
      if (event instanceof KeyboardEvent && MODIFIER_KEYS.has(event.key)) return;
      const canvas = isEngineCanvas(event.target);
      const pointer = POINTER_KINDS.includes(kind as (typeof POINTER_KINDS)[number]);
      // `buttons` is already 0 on the pointerup that ends a drag.
      const drag = pointer
        ? { drag: kind === "pointerup" || (event as MouseEvent).buttons !== 0 }
        : {};
      const samples =
        kind === "pointermove" && "getCoalescedEvents" in event
          ? (event as PointerEvent).getCoalescedEvents()
          : [];
      if (samples.length === 0) {
        this.#inputs.push({ kind, time: event.timeStamp, canvas, ...drag });
      }
      for (const sample of samples) {
        this.#inputs.push({ kind, time: sample.timeStamp, canvas, ...drag });
      }
    };
    for (const kind of [...POINTER_KINDS, "keydown", "wheel"]) {
      target.addEventListener(kind, record, { capture: true, passive: true });
    }
    if (supports("longtask")) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.#longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: "longtask", buffered: true });
    }
    if (supports("long-animation-frame")) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const { blockingDuration } = entry as PerformanceEntry & { blockingDuration?: number };
          this.#longFrames.push({
            start: entry.startTime,
            duration: entry.duration,
            blockingDuration: blockingDuration ?? 0,
          });
        }
      }).observe({ type: "long-animation-frame", buffered: true });
    }
    target.__openpaintPerf = {
      reset: () => this.reset(),
      snapshot: () => this.snapshot(),
      take: () => this.take(),
      idle: (timeoutMs) => this.idle(timeoutMs),
      mark: (name) => this.mark(name),
      trackFrames: (on) => this.trackFrames(on),
    };
  }

  /** Receives the engine's presents. Returns the function that detaches it. */
  attachEngine(engine: EngineHandle): () => void {
    this.#engine = engine;
    const detach = engine.onPerf((report) => this.#absorb(report));
    return () => {
      detach();
      if (this.#engine === engine) this.#engine = undefined;
    };
  }

  /**
   * Records, for every frame, when its paint is done: a message posted from the frame's animation
   * frame callback runs in the first task after the paint.
   */
  trackFrames(on: boolean): void {
    if (!on) {
      if (this.#tracking !== undefined) cancelAnimationFrame(this.#tracking.frame);
      this.#tracking?.channel.port1.close();
      this.#tracking = undefined;
      return;
    }
    if (this.#tracking !== undefined) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => this.#paints.push(performance.now());
    const tick = () => {
      if (this.#tracking === undefined) return;
      channel.port2.postMessage(undefined);
      this.#tracking.frame = requestAnimationFrame(tick);
    };
    this.#tracking = { frame: requestAnimationFrame(tick), channel };
  }

  /** Adds a check that must pass for `idle()`, e.g. "no history step in flight". */
  addIdleCheck(check: IdleCheck): () => void {
    this.#idleChecks.add(check);
    return () => {
      this.#idleChecks.delete(check);
    };
  }

  reset(): void {
    this.#presents = [];
    this.#inputs = [];
    this.#longTasks = [];
    this.#longFrames = [];
    this.#overlays = [];
    this.#paints = [];
    this.#previews = [];
    this.#marks = {};
  }

  /**
   * Records that an effect preview asked for at `requested` reached the canvas at `shown`: its
   * first pixels were written, or its live filter was sent to the engine.
   */
  previewShown(requested: number, shown: number): void {
    this.#previews.push({ requested, shown });
  }

  mark(name: string): number {
    const time = performance.now();
    this.#marks[name] = time;
    return time;
  }

  async snapshot(): Promise<PerfSnapshot> {
    await this.#drain();
    return {
      engine: this.engineName,
      presents: [...this.#presents],
      inputs: [...this.#inputs],
      longTasks: [...this.#longTasks],
      longFrames: [...this.#longFrames],
      overlays: [...this.#overlays],
      paints: [...this.#paints],
      previews: [...this.#previews],
      marks: { ...this.#marks },
      observes: {
        longtask: supports("longtask"),
        longAnimationFrame: supports("long-animation-frame"),
      },
    };
  }

  async take(): Promise<PerfSnapshot> {
    const snapshot = await this.snapshot();
    this.reset();
    return snapshot;
  }

  async idle(timeoutMs = IDLE_TIMEOUT_MS): Promise<PerfIdle> {
    const deadline = performance.now() + timeoutMs;
    let since: number | undefined;
    let busy: string[] = [];
    while (performance.now() < deadline) {
      await nextFrame();
      const engineIdle = await this.#drain();
      const now = performance.now();
      busy = engineIdle ? [] : ["engine"];
      for (const check of this.#idleChecks) {
        const result = check();
        if (result !== true) busy.push(result === false ? "app" : result);
      }
      if (busy.length === 0) {
        if (since !== undefined) return { idle: true, at: since };
        since = now;
      } else {
        since = undefined;
      }
    }
    return { idle: false, at: performance.now(), busy };
  }

  /** Collects the engine's recorded presents and returns whether it is idle. */
  async #drain(): Promise<boolean> {
    const engine = this.#engine;
    if (engine === undefined) return true;
    const report = await engine.perf();
    this.#absorb(report);
    return report.idle;
  }

  /** Moves the engine's present times onto this thread's clock. */
  #absorb(report: EnginePerfReport): void {
    const offset = report.timeOrigin - performance.timeOrigin;
    const views = report.views ?? [];
    for (let i = 0; i + 1 < report.presents.length; i += 2) {
      const x = views[(i / 2) * 3];
      const y = views[(i / 2) * 3 + 1];
      const zoom = views[(i / 2) * 3 + 2];
      const view =
        x === undefined || y === undefined || zoom === undefined || Number.isNaN(zoom)
          ? {}
          : { view: { x, y, zoom } };
      this.#presents.push({
        start: (report.presents[i] as number) + offset,
        end: (report.presents[i + 1] as number) + offset,
        ...view,
      });
    }
  }

  /**
   * Records that an overlay drew the view at `layout` now. The bench compares these with the views
   * the engine presented, to see whether overlays and canvas move together.
   */
  overlayDrawn(layout: { originX: number; originY: number; zoom: number }): void {
    this.#overlays.push({
      time: performance.now(),
      view: { x: layout.originX, y: layout.originY, zoom: layout.zoom },
    });
  }
}

/** The monitor of this page load, or undefined without `?perf=1`. */
export const perfMonitor: PerfMonitor | undefined = PERF_FLAGS.perf
  ? new PerfMonitor(PERF_FLAGS.engine)
  : undefined;
