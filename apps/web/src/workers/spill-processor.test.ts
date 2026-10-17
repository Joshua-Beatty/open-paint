/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { decodeSpill, encodeSpill } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type SpillReply,
  type SpillWorkerJob,
  type SpillWorkerLike,
  WorkerSpillProcessor,
} from "./spill-processor";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** A worker that runs each job with the real codec after a turn, as a worker thread would. */
class FakeSpillWorker implements SpillWorkerLike {
  onmessage: ((event: MessageEvent<SpillReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly jobs: SpillWorkerJob[] = [];
  readonly #answers: number;

  /** `answers` is how many jobs the worker answers before it goes silent. */
  constructor(answers: number) {
    this.#answers = answers;
  }

  postMessage(message: SpillWorkerJob): void {
    this.jobs.push(message);
    if (this.jobs.length > this.#answers) return;
    queueMicrotask(() => {
      const data =
        message.op === "encode"
          ? encodeSpill(message.raw, message.codec)
          : decodeSpill(message.encoded);
      this.onmessage?.({
        data: { id: message.id, ok: true, data: data as Uint8Array<ArrayBuffer> },
      } as MessageEvent<SpillReply>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

function sample(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 7) % 251);
}

describe("WorkerSpillProcessor (PRD-NF-02)", () => {
  it("hands the first real encode over without a copy once warmed up (L9)", async () => {
    const worker = new FakeSpillWorker(Number.POSITIVE_INFINITY);
    const processor = new WorkerSpillProcessor(() => worker);
    await processor.warmUp();
    const raw = sample(1_000);
    const encoded = processor.encode(raw, "lz4");
    const job = worker.jobs.at(-1);
    expect(job?.op === "encode" ? job.raw : undefined).toBe(raw);
    await encoded;
  });

  it("encodes and decodes in the worker, and keeps the caller's bytes", async () => {
    const worker = new FakeSpillWorker(Number.POSITIVE_INFINITY);
    const processor = new WorkerSpillProcessor(() => worker);
    const raw = sample(200_000);
    const encoded = await processor.encode(raw, "lz4");

    expect(decodeSpill(encoded)).toEqual(raw);
    expect(await processor.decode(encoded)).toEqual(raw);
    expect(worker.jobs.map((job) => job.op)).toEqual(["encode", "decode"]);
    expect(raw.length).toBe(200_000);
    expect(raw[1]).toBe(7);
  });

  it("runs on this thread when no worker can be created", async () => {
    const processor = new WorkerSpillProcessor(() => {
      throw new Error("no workers");
    });
    const raw = sample(5_000);
    const encoded = await processor.encode(raw, "none");
    expect(await processor.decode(encoded)).toEqual(raw);
  });

  it("runs on this thread when a job cannot be posted", async () => {
    const worker = new FakeSpillWorker(Number.POSITIVE_INFINITY);
    worker.postMessage = () => {
      throw new Error("cannot clone");
    };
    const processor = new WorkerSpillProcessor(() => worker);
    const raw = sample(3_000);
    expect(decodeSpill(await processor.encode(raw, "lz4"))).toEqual(raw);
  });

  it("finishes a job on this thread when a worker that has not answered yet fails", async () => {
    const worker = new FakeSpillWorker(0);
    const processor = new WorkerSpillProcessor(() => worker);
    const raw = sample(4_000);
    const encoding = processor.encode(raw, "lz4");
    worker.onerror?.({ message: "worker crashed" } as ErrorEvent);

    expect(decodeSpill(await encoding)).toEqual(raw);
    expect(worker.terminated).toBe(true);
  });

  it("fails a job whose bytes were handed to a worker that then stops", async () => {
    const worker = new FakeSpillWorker(1);
    const processor = new WorkerSpillProcessor(() => worker);
    const first = processor.encode(sample(1_000), "lz4");
    await first;
    const encoding = processor.encode(sample(2_000), "lz4");
    worker.onerror?.({ message: "worker crashed" } as ErrorEvent);

    await expect(encoding).rejects.toThrow("The history worker stopped.");
    expect(worker.terminated).toBe(true);
  });
});
