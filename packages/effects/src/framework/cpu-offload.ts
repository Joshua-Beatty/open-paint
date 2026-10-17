import {
  composeFloating,
  composeFloatingRows,
  type FloatingComposeJob,
  type FloatingComposeResult,
  type ResampleOptions,
  rect,
  resampleSurface,
  Surface,
} from "@openpaint/document";
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

/** Pixels as they cross to or from a worker. */
export interface CpuPixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * A Move Selected Pixels commit (`composeFloating`), with copies of the content and the base that
 * the worker owns. Its reply is the area as recorded, then the base with the stamps drawn into it.
 */
export interface FloatCpuJob extends Omit<FloatingComposeJob, "pixels" | "base"> {
  readonly kind: "float";
  readonly id: number;
  readonly content: CpuPixels;
  /** The base, or only the rows of `rows` when it is given. */
  readonly baseIn: CpuPixels;
  /** A band of the result to compute (`composeFloatingRows`), or the whole of it. */
  readonly rows?: { readonly first: number; readonly count: number };
}

export type CpuJob = EffectCpuJob | ResampleCpuJob | FloatCpuJob;

/**
 * The worker's answer to one job: the output pixels (and, for jobs with several outputs, the
 * others in `more`), or the message of the error it threw.
 */
export type CpuReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly width: number;
      readonly height: number;
      readonly pixels: Uint8ClampedArray<ArrayBuffer>;
      readonly more?: readonly CpuPixels[];
    }
  | { readonly id: number; readonly ok: false; readonly message: string };

/** Runs a job in this realm. The worker calls it with the built-in bindings it has loaded. */
export function runCpuJob(job: CpuJob, bindings: readonly EffectBinding<unknown>[]): Surface {
  return runCpuJobOutputs(job, bindings)[0] as Surface;
}

/** Every output of a job, the main one first. */
export function runCpuJobOutputs(
  job: CpuJob,
  bindings: readonly EffectBinding<unknown>[],
): Surface[] {
  if (job.kind === "resample") {
    const source = new Surface(job.width, job.height, job.pixels);
    return [resampleSurface(source, job.targetWidth, job.targetHeight, job.options)];
  }
  if (job.kind === "float") {
    const { content, baseIn, rows, kind: _kind, id: _id, ...rest } = job;
    const compose: FloatingComposeJob = {
      ...rest,
      pixels: new Surface(content.width, content.height, content.pixels),
      base: new Surface(baseIn.width, baseIn.height, baseIn.pixels),
    };
    const result =
      rows === undefined
        ? composeFloating(compose)
        : composeFloatingRows(compose, rows.first, rows.count);
    return job.stamps.length > 0 ? [result.drawn, result.base] : [result.drawn];
  }
  const binding = bindings.find((item) => item.descriptor.id === job.effectId);
  if (binding === undefined) throw new Error(`No CPU implementation for "${job.effectId}".`);
  const input = new Surface(job.width, job.height, job.pixels);
  return [binding.cpu(input, job.params, job.coverage)];
}

/** `surface`'s pixels as one transferable buffer of their own. */
export function ownedPixels(surface: Surface): Uint8ClampedArray<ArrayBuffer> {
  const data = surface.data as Uint8ClampedArray<ArrayBuffer>;
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
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
  /** Workers a Move Selected Pixels commit is split across (`composeFloating`). Default 1. */
  readonly floatBands?: number;
}

interface PendingJob {
  readonly resolve: (surfaces: Surface[]) => void;
  readonly reject: (error: Error) => void;
}

function first(surfaces: Surface[]): Surface {
  return surfaces[0] as Surface;
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
  /** Extra workers that compute row bands of a Move Selected Pixels commit. */
  readonly #helpers: CpuWorkerLike[] = [];
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
    return this.#dispatch(job, transfer, signal, () => [binding.cpu(input, params, coverage)]).then(
      first,
    );
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
    return this.#dispatch(job, [pixels.buffer], undefined, () => [
      resampleSurface(source, width, height, options),
    ]).then(first);
  }

  /**
   * Computes a Move Selected Pixels commit in workers (`composeFloating`), with the same reference,
   * so the result is byte-identical to computing it here. A tall area is split into row bands
   * (`composeFloatingRows`) that `floatBands` workers compute side by side; the extra workers stop
   * afterwards, so their memory goes with them. The content and the base are copied, so they are
   * unchanged.
   */
  async composeFloating(job: FloatingComposeJob): Promise<FloatingComposeResult> {
    const { pixels, base, ...rest } = job;
    const { width, height } = job.area;
    const bands = Math.max(1, Math.min(this.#options.floatBands ?? 1, Math.floor(height / 64)));
    const band = (first: number, count: number, worker: () => CpuWorkerLike) => {
      const content = { width: pixels.width, height: pixels.height, pixels: pixels.data.slice() };
      const rows = new Surface(width, count);
      rows.copyFrom(base, rect(0, first, width, count), 0, 0);
      const baseIn = { width, height: count, pixels: rows.data as Uint8ClampedArray<ArrayBuffer> };
      const message: FloatCpuJob = {
        ...rest,
        kind: "float",
        id: this.#takeId(),
        content,
        baseIn,
        ...(bands > 1 && { rows: { first, count } }),
      };
      const inline = () => {
        const result =
          bands > 1
            ? composeFloatingRows({ ...job, base: rows }, first, count)
            : composeFloating(job);
        return [result.drawn, result.base];
      };
      return this.#dispatch(
        message,
        [content.pixels.buffer, baseIn.pixels.buffer],
        undefined,
        inline,
        worker,
      );
    };
    if (bands === 1) {
      const [drawn, stamped] = await band(0, height, () => this.#ownWorker());
      return {
        drawn: drawn as Surface,
        base: job.stamps.length > 0 && stamped !== undefined ? stamped : base,
      };
    }
    const size = Math.ceil(height / bands);
    const parts: Promise<Surface[]>[] = [];
    for (let index = 0; index * size < height; index++) {
      const first = index * size;
      const worker = index === 0 ? () => this.#ownWorker() : () => this.#helper(index - 1);
      parts.push(band(first, Math.min(size, height - first), worker));
    }
    try {
      const results = await Promise.all(parts);
      const drawn = new Surface(width, height);
      const stamped = job.stamps.length > 0 ? new Surface(width, height) : base;
      results.forEach(([part, partBase], index) => {
        if (part !== undefined) drawn.copyFrom(part, part.bounds, 0, index * size);
        if (stamped !== base && partBase !== undefined) {
          stamped.copyFrom(partBase, partBase.bounds, 0, index * size);
        }
      });
      return { drawn, base: stamped };
    } finally {
      this.#stopHelpers();
    }
  }

  #takeId(): number {
    const id = this.#nextId;
    this.#nextId += 1;
    return id;
  }

  /**
   * Posts `job` to `worker` (the main one by default) and resolves with its reply. The post throws
   * synchronously when the job cannot be sent, and then `inline` runs it on this thread instead.
   */
  #dispatch(
    job: CpuJob,
    transfer: Transferable[],
    signal: AbortSignal | undefined,
    inline: () => Surface[],
    worker: () => CpuWorkerLike = () => this.#ownWorker(),
  ): Promise<Surface[]> {
    try {
      worker().postMessage({ job }, transfer);
    } catch {
      return new Promise<Surface[]>((resolve) => resolve(inline()));
    }
    return new Promise<Surface[]>((resolve, reject) => {
      const onAbort = () => this.#cancelAll();
      const settle = () => signal?.removeEventListener("abort", onAbort);
      this.#pending.set(job.id, {
        resolve: (surfaces) => {
          settle();
          resolve(surfaces);
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
    this.#worker ??= this.#startWorker();
    return this.#worker;
  }

  /** The `index`th extra worker for row bands, started on first use. */
  #helper(index: number): CpuWorkerLike {
    let worker = this.#helpers[index];
    if (worker === undefined) {
      worker = this.#startWorker();
      this.#helpers[index] = worker;
    }
    return worker;
  }

  #stopHelpers(): void {
    for (const worker of this.#helpers.splice(0)) worker.terminate();
  }

  #startWorker(): CpuWorkerLike {
    const worker = this.#options.createWorker();
    worker.onmessage = (event: MessageEvent<CpuReply>) => {
      const reply = event.data;
      const pending = this.#pending.get(reply.id);
      if (pending === undefined) return;
      this.#pending.delete(reply.id);
      if (reply.ok) {
        pending.resolve([
          new Surface(reply.width, reply.height, reply.pixels),
          ...(reply.more ?? []).map((more) => new Surface(more.width, more.height, more.pixels)),
        ]);
      } else {
        pending.reject(new Error(reply.message));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      this.#drop(new Error(event.message || "The CPU worker stopped."));
    };
    return worker;
  }

  #cancelAll(): void {
    this.#drop(abortError());
  }

  /** Stops the workers and fails every job they still owe. The next job starts a new worker. */
  #drop(error: Error): void {
    const worker = this.#worker;
    this.#worker = undefined;
    worker?.terminate();
    this.#stopHelpers();
    const jobs = [...this.#pending.values()];
    this.#pending.clear();
    for (const job of jobs) job.reject(error);
  }
}
