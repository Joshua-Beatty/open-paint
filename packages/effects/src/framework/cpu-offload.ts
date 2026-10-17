import { type ResampleOptions, resampleSurface, Surface } from "@openpaint/document";
import type { EffectBinding } from "./binding";

/**
 * One effect run as it crosses to a worker. The pixels and coverage are copies that the worker
 * owns, so they are transferred rather than cloned. The params are plain data (the schema's
 * resolved values), so they are cloned.
 */
export interface EffectCpuJob {
  readonly kind: "effect";
  readonly id: number;
  readonly effectId: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly params: unknown;
  readonly coverage: Uint8Array | undefined;
}

/** One whole-layer resample (DOC-IMG-02), with the source pixels transferred to the worker. */
export interface ResampleCpuJob {
  readonly kind: "resample";
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly options: ResampleOptions;
}

export type CpuJob = EffectCpuJob | ResampleCpuJob;

/** The worker's answer to one job: the output pixels, or the message of the error it threw. */
export type CpuReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly width: number;
      readonly height: number;
      readonly pixels: Uint8ClampedArray<ArrayBuffer>;
    }
  | { readonly id: number; readonly ok: false; readonly message: string };

/** Runs a job in this realm. The worker calls it with the built-in bindings it has loaded. */
export function runCpuJob(job: CpuJob, bindings: readonly EffectBinding<unknown>[]): Surface {
  if (job.kind === "resample") {
    const source = new Surface(job.width, job.height, job.pixels);
    return resampleSurface(source, job.targetWidth, job.targetHeight, job.options);
  }
  const binding = bindings.find((item) => item.descriptor.id === job.effectId);
  if (binding === undefined) throw new Error(`No CPU implementation for "${job.effectId}".`);
  const input = new Surface(job.width, job.height, job.pixels);
  return binding.cpu(input, job.params, job.coverage);
}

/** Runs CPU effects off the main thread (WEB-GPU-06, PRD-NF-02). */
export interface CpuOffloader {
  /** Whether the worker has this binding's CPU implementation. */
  canRun(binding: EffectBinding<unknown>): boolean;
  run<P>(
    binding: EffectBinding<P>,
    input: Surface,
    params: P,
    coverage: ArrayLike<number> | undefined,
    signal: AbortSignal,
  ): Promise<Surface>;
}

/** The part of a `Worker` that the offloader uses, so a test can stand in for one. */
export interface CpuWorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<CpuReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

export interface WorkerCpuOffloaderOptions {
  readonly createWorker: () => CpuWorkerLike;
  /** The ids of the built-in bindings the worker loads. Other bindings run on this thread. */
  readonly builtinIds: ReadonlySet<string>;
}

interface PendingJob {
  readonly resolve: (surface: Surface) => void;
  readonly reject: (error: Error) => void;
}

function abortError(): Error {
  const error = new Error("The CPU render was canceled.");
  error.name = "AbortError";
  return error;
}

/**
 * Runs built-in CPU effects and layer resamples in one worker. A cancel terminates the worker, so
 * a render still computing stops at once, and the next job starts a new worker. A binding the
 * worker cannot load, or a job it cannot post (params that cannot be cloned, or no Worker at all),
 * runs on this thread instead.
 */
export class WorkerCpuOffloader implements CpuOffloader {
  readonly #options: WorkerCpuOffloaderOptions;
  readonly #pending = new Map<number, PendingJob>();
  #worker: CpuWorkerLike | undefined;
  #nextId = 0;

  constructor(options: WorkerCpuOffloaderOptions) {
    this.#options = options;
  }

  canRun(binding: EffectBinding<unknown>): boolean {
    return this.#options.builtinIds.has(binding.descriptor.id);
  }

  run<P>(
    binding: EffectBinding<P>,
    input: Surface,
    params: P,
    coverage: ArrayLike<number> | undefined,
    signal: AbortSignal,
  ): Promise<Surface> {
    if (signal.aborted) return Promise.reject(abortError());
    const pixels = input.data.slice();
    const mask = coverage === undefined ? undefined : Uint8Array.from(coverage);
    const job: EffectCpuJob = {
      kind: "effect",
      id: this.#takeId(),
      effectId: binding.descriptor.id,
      width: input.width,
      height: input.height,
      pixels,
      params,
      coverage: mask,
    };
    const transfer: Transferable[] = [pixels.buffer];
    if (mask !== undefined) transfer.push(mask.buffer);
    return this.#dispatch(job, transfer, signal, () => binding.cpu(input, params, coverage));
  }

  /** Resamples `source` in the worker (DOC-IMG-02). The source is copied, so it is unchanged. */
  resample(
    source: Surface,
    width: number,
    height: number,
    options: ResampleOptions,
  ): Promise<Surface> {
    const pixels = source.data.slice();
    const job: ResampleCpuJob = {
      kind: "resample",
      id: this.#takeId(),
      width: source.width,
      height: source.height,
      pixels,
      targetWidth: width,
      targetHeight: height,
      options,
    };
    return this.#dispatch(job, [pixels.buffer], undefined, () =>
      resampleSurface(source, width, height, options),
    );
  }

  #takeId(): number {
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }

  /**
   * Posts `job` and resolves with its reply. The post throws synchronously when the job cannot be
   * sent, and then `inline` runs it on this thread instead.
   */
  #dispatch(
    job: CpuJob,
    transfer: Transferable[],
    signal: AbortSignal | undefined,
    inline: () => Surface,
  ): Promise<Surface> {
    try {
      this.#ownWorker().postMessage({ job }, transfer);
    } catch {
      return new Promise<Surface>((resolve) => resolve(inline()));
    }
    return new Promise<Surface>((resolve, reject) => {
      const onAbort = () => this.#cancelAll();
      const settle = () => signal?.removeEventListener("abort", onAbort);
      this.#pending.set(job.id, {
        resolve: (surface) => {
          settle();
          resolve(surface);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #ownWorker(): CpuWorkerLike {
    if (this.#worker !== undefined) return this.#worker;
    const worker = this.#options.createWorker();
    worker.onmessage = (event: MessageEvent<CpuReply>) => {
      const reply = event.data;
      const pending = this.#pending.get(reply.id);
      if (pending === undefined) return;
      this.#pending.delete(reply.id);
      if (reply.ok) {
        pending.resolve(new Surface(reply.width, reply.height, reply.pixels));
      } else {
        pending.reject(new Error(reply.message));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      this.#drop(new Error(event.message || "The CPU worker stopped."));
    };
    this.#worker = worker;
    return worker;
  }

  #cancelAll(): void {
    this.#drop(abortError());
  }

  /** Stops the worker and fails every job it still owes. The next job starts a new worker. */
  #drop(error: Error): void {
    const worker = this.#worker;
    this.#worker = undefined;
    worker?.terminate();
    const jobs = [...this.#pending.values()];
    this.#pending.clear();
    for (const job of jobs) job.reject(error);
  }
}
