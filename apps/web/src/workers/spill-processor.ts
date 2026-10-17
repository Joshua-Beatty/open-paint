import {
  decodeSpill,
  encodeSpill,
  type SpillCodec,
  type SpillProcessor,
  setDefaultSpillProcessor,
} from "@openpaint/document";

/**
 * One LZ4 job as it crosses to the worker. The bytes are copies that the worker owns, so they are
 * transferred.
 */
export type SpillWorkerJob =
  | {
      readonly id: number;
      readonly op: "encode";
      readonly codec: SpillCodec;
      readonly raw: Uint8Array<ArrayBuffer>;
    }
  | { readonly id: number; readonly op: "decode"; readonly encoded: Uint8Array<ArrayBuffer> };

/** The worker's answer: the encoded or decoded bytes, or the message of the error it threw. */
export type SpillReply =
  | { readonly id: number; readonly ok: true; readonly data: Uint8Array<ArrayBuffer> }
  | { readonly id: number; readonly ok: false; readonly message: string };

/** The part of a `Worker` that the processor uses, so a test can stand in for one. */
export interface SpillWorkerLike {
  postMessage(message: SpillWorkerJob, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<SpillReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

interface PendingJob {
  readonly resolve: (data: Uint8Array) => void;
  readonly reject: (error: Error) => void;
  /** Runs the job on this thread when the worker fails. Only set when the worker got a copy. */
  readonly fallback: (() => Uint8Array) | undefined;
}

/**
 * Runs history LZ4 work in one worker, so a commit or a checkpoint does not compress or decompress
 * on the main thread (PRD-NF-02). The worker starts on the first job. If no worker can be made, the
 * job runs on this thread. Once a worker has answered, an encode hands its bytes over without a
 * copy. Until then the worker gets a copy, so a worker that fails can still be run inline.
 */
export class WorkerSpillProcessor implements SpillProcessor {
  readonly #createWorker: () => SpillWorkerLike;
  readonly #pending = new Map<number, PendingJob>();
  #worker: SpillWorkerLike | undefined;
  #answered = false;
  #nextId = 0;

  constructor(createWorker: () => SpillWorkerLike) {
    this.#createWorker = createWorker;
  }

  encode(raw: Uint8Array, codec: SpillCodec): Promise<Uint8Array> {
    return this.#dispatch(
      (id, bytes) => ({ id, op: "encode", codec, raw: bytes }),
      raw,
      () => encodeSpill(raw, codec),
      true,
    );
  }

  /**
   * Starts the worker with a tiny job, so it has answered before the first real one: an image's
   * first commit then hands its bytes over instead of copying them (L9).
   */
  warmUp(): Promise<void> {
    return this.encode(new Uint8Array(16), "lz4").then(
      () => undefined,
      () => undefined,
    );
  }

  decode(encoded: Uint8Array): Promise<Uint8Array> {
    return this.#dispatch(
      (id, bytes) => ({ id, op: "decode", encoded: bytes }),
      encoded,
      () => decodeSpill(encoded),
      false,
    );
  }

  /**
   * Posts one job. `takeable` says whether the caller gives up `bytes`, which is then transferred
   * when the worker is known to work. `inline` runs the job on this thread instead.
   */
  #dispatch(
    job: (id: number, bytes: Uint8Array<ArrayBuffer>) => SpillWorkerJob,
    bytes: Uint8Array,
    inline: () => Uint8Array,
    takeable: boolean,
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const id = this.#nextId;
      this.#nextId += 1;
      const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      const handOver = takeable && this.#answered && whole;
      const sent = handOver ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
      try {
        this.#ownWorker().postMessage(job(id, sent), [sent.buffer]);
      } catch {
        resolve(inline());
        return;
      }
      this.#pending.set(id, { resolve, reject, fallback: handOver ? undefined : inline });
    });
  }

  #ownWorker(): SpillWorkerLike {
    if (this.#worker !== undefined) return this.#worker;
    const worker = this.#createWorker();
    worker.onmessage = (event: MessageEvent<SpillReply>) => {
      const reply = event.data;
      this.#answered = true;
      const pending = this.#pending.get(reply.id);
      if (pending === undefined) return;
      this.#pending.delete(reply.id);
      if (reply.ok) {
        pending.resolve(reply.data);
      } else {
        pending.reject(new Error(reply.message));
      }
    };
    worker.onerror = () => {
      this.#drop();
    };
    this.#worker = worker;
    return worker;
  }

  /**
   * Stops the worker. Jobs that kept their bytes run on this thread. Jobs that handed them over
   * fail, since their bytes are no longer here. The next job starts a new, unproven worker.
   */
  #drop(): void {
    const worker = this.#worker;
    this.#worker = undefined;
    this.#answered = false;
    worker?.terminate();
    const jobs = [...this.#pending.values()];
    this.#pending.clear();
    for (const job of jobs) {
      if (job.fallback === undefined) {
        job.reject(new Error("The history worker stopped."));
      } else {
        job.resolve(job.fallback());
      }
    }
  }
}

/** Makes the worker processor the default for every history store the app creates. */
export function installSpillProcessor(): void {
  const processor = new WorkerSpillProcessor(
    () =>
      new Worker(new URL("./spill-worker.ts", import.meta.url), {
        type: "module",
      }) as unknown as SpillWorkerLike,
  );
  setDefaultSpillProcessor(processor);
  void processor.warmUp();
}
