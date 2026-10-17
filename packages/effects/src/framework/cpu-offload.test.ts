/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import {
  composeFloating,
  type FloatingComposeJob,
  rect,
  resampleSurface,
  Surface,
  TiledPixelStore,
} from "@openpaint/document";
import type { EffectDescriptor } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import type { EffectBinding } from "./binding";
import {
  type CpuJob,
  type CpuReply,
  type CpuWorkerLike,
  runCpuJob,
  runCpuJobOutputs,
  WorkerCpuOffloader,
} from "./cpu-offload";
import { renderRegion } from "./render";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function descriptor(id: string): EffectDescriptor {
  return {
    id,
    apiVersion: 1,
    label: "effect.gaussianBlur",
    icon: "icon.gaussianBlur",
    category: "effect",
    configurable: false,
    kind: "cpuRegion",
    schema: { properties: [], rules: [], layout: undefined, version: 1, migrations: [] },
  } as unknown as EffectDescriptor;
}

interface Params {
  readonly amount: number;
}

/** Adds `amount` to each color channel, clamped. Alpha is kept. */
const brighten: EffectBinding<Params> = {
  descriptor: descriptor("test.brighten"),
  params: (values) => ({ amount: Number(values.amount ?? 0) }),
  cpu(input, params, coverage) {
    expect(coverage).toBeUndefined();
    const data = input.data.slice();
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) data[i + c] = (data[i + c] ?? 0) + params.amount;
    }
    return new Surface(input.width, input.height, data);
  },
};

/** A worker that runs jobs with `runCpuJob` on a microtask, or holds them while `holding` is set. */
class FakeWorker implements CpuWorkerLike {
  onmessage: ((event: MessageEvent<CpuReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  holding = false;
  readonly held: CpuJob[] = [];
  failPost = false;

  constructor(private readonly bindings: readonly EffectBinding<unknown>[]) {}

  postMessage(message: { job: CpuJob }): void {
    if (this.failPost) throw new DOMException("could not be cloned", "DataCloneError");
    if (this.holding) {
      this.held.push(message.job);
      return;
    }
    queueMicrotask(() => this.reply(message.job));
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(job: CpuJob): void {
    if (this.terminated) return;
    try {
      const [output, ...rest] = runCpuJobOutputs(job, this.bindings);
      if (output === undefined) throw new Error("no output");
      const pixels = output.data.slice();
      const more = rest.map((surface) => ({
        width: surface.width,
        height: surface.height,
        pixels: surface.data.slice(),
      }));
      this.onmessage?.({
        data: { id: job.id, ok: true, width: output.width, height: output.height, pixels, more },
      } as unknown as MessageEvent<CpuReply>);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.onmessage?.({ data: { id: job.id, ok: false, message } } as MessageEvent<CpuReply>);
    }
  }
}

function image(width: number, height: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
  return new Surface(width, height, data);
}

function offloaderWith(bindings: readonly EffectBinding<unknown>[] = [brighten], hold = false) {
  const workers: FakeWorker[] = [];
  const offloader = new WorkerCpuOffloader({
    builtinIds: new Set(bindings.map((binding) => binding.descriptor.id)),
    createWorker: () => {
      const worker = new FakeWorker(bindings);
      worker.holding = hold && workers.length === 0;
      workers.push(worker);
      return worker;
    },
  });
  return { offloader, workers };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("runCpuJob", () => {
  it("runs the named binding over the job's pixels", () => {
    const input = image(3, 2);
    const output = runCpuJob(
      {
        kind: "effect",
        id: 1,
        effectId: "test.brighten",
        width: 3,
        height: 2,
        pixels: input.data.slice(),
        params: { amount: 10 },
        coverage: undefined,
      },
      [brighten as EffectBinding<unknown>],
    );
    expect(output).toEqual(brighten.cpu(input, { amount: 10 }));
  });

  it("rejects a job for a binding the worker does not have", () => {
    expect(() =>
      runCpuJob(
        {
          kind: "effect",
          id: 1,
          effectId: "test.missing",
          width: 1,
          height: 1,
          pixels: new Uint8ClampedArray(4),
          params: {},
          coverage: undefined,
        },
        [],
      ),
    ).toThrow('No CPU implementation for "test.missing".');
  });
});

describe("renderRegion through the offloader", () => {
  it("runs the CPU pass in the worker and writes its output to the layer", async () => {
    const { offloader } = offloaderWith();
    const input = image(8, 8);
    const store = new TiledPixelStore(8, 8);
    store.writeRegion(input, 0, 0);
    const outcome = await renderRegion({
      binding: brighten,
      params: { amount: 30 },
      store,
      region: rect(0, 0, 8, 8),
      original: input,
      backend: "cpu",
      offload: offloader,
      signal: signal(),
    });
    expect(outcome).toBe("done");
    expect(store.readRegion(rect(0, 0, 8, 8))).toEqual(brighten.cpu(input, { amount: 30 }));
  });
});

describe("WorkerCpuOffloader", () => {
  it("resamples a layer in the worker with the same output as the resampler", async () => {
    const { offloader, workers } = offloaderWith();
    const source = image(6, 4);
    const options = { filter: "bicubic", linearLight: false } as const;
    const output = await offloader.resample(source, 9, 3, options);
    expect(output).toEqual(resampleSurface(source, 9, 3, options));
    expect(workers).toHaveLength(1);
  });

  it("computes a Move Selected Pixels commit in the worker exactly as here, stamps included", async () => {
    const { offloader, workers } = offloaderWith();
    const pixels = image(6, 4);
    const turn = (angle: number, e: number) => ({
      a: Math.cos(angle),
      b: Math.sin(angle),
      c: -Math.sin(angle),
      d: Math.cos(angle),
      e,
      f: 3.2,
    });
    const job: FloatingComposeJob = {
      pixels,
      coverage: undefined,
      outline: [[0, 0, 6, 0, 6, 4, 0, 4]],
      quality: "antialiased",
      area: rect(0, 0, 16, 12),
      base: image(16, 12),
      stamps: [{ transform: turn(0.3, 4.5), options: { sampling: "linear", linearLight: false } }],
      placement: { transform: turn(0.8, 7.25), options: { sampling: "cubic", linearLight: true } },
    };
    const before = [...job.base.data];
    const result = await offloader.composeFloating(job);
    const here = composeFloating(job);
    expect(result.drawn).toEqual(here.drawn);
    expect(result.base).toEqual(here.base);
    expect([...job.base.data]).toEqual(before);
    expect(workers).toHaveLength(1);
  });

  it("splits a tall commit into row bands across workers, byte-identical, and stops the extras", async () => {
    const workers: FakeWorker[] = [];
    const offloader = new WorkerCpuOffloader({
      builtinIds: new Set(),
      floatBands: 3,
      createWorker: () => {
        const worker = new FakeWorker([]);
        workers.push(worker);
        return worker;
      },
    });
    const job: FloatingComposeJob = {
      pixels: image(30, 150),
      coverage: undefined,
      outline: [[0, 0, 30, 0, 30, 150, 0, 150]],
      quality: "antialiased",
      area: rect(0, 0, 50, 200),
      base: image(50, 200),
      stamps: [
        {
          transform: { a: 0.9, b: 0.3, c: -0.3, d: 0.9, e: 12.5, f: 4 },
          options: { sampling: "linear", linearLight: false },
        },
      ],
      placement: {
        transform: { a: 0.8, b: -0.5, c: 0.5, d: 0.8, e: 3.25, f: 30 },
        options: { sampling: "cubic", linearLight: true },
      },
    };
    const result = await offloader.composeFloating(job);
    const here = composeFloating(job);
    expect(result.drawn).toEqual(here.drawn);
    expect(result.base).toEqual(here.base);
    expect(workers).toHaveLength(3);
    expect(workers.map((worker) => worker.terminated)).toEqual([false, true, true]);
  });

  it("resamples on this thread when no worker can be created", async () => {
    const offloader = new WorkerCpuOffloader({
      builtinIds: new Set(),
      createWorker: () => {
        throw new ReferenceError("Worker is not defined");
      },
    });
    const source = image(6, 4);
    const options = { filter: "nearest", linearLight: true } as const;
    expect(await offloader.resample(source, 3, 2, options)).toEqual(
      resampleSurface(source, 3, 2, options),
    );
  });

  it("runs a built-in binding in the worker with the same output as the CPU reference", async () => {
    const { offloader, workers } = offloaderWith();
    const input = image(16, 8);
    const output = await offloader.run(brighten, input, { amount: 40 }, undefined, signal());
    expect(output).toEqual(brighten.cpu(input, { amount: 40 }));
    expect(workers).toHaveLength(1);
  });

  it("reuses one worker for every run", async () => {
    const { offloader, workers } = offloaderWith();
    const input = image(4, 4);
    await offloader.run(brighten, input, { amount: 1 }, undefined, signal());
    await offloader.run(brighten, input, { amount: 2 }, undefined, signal());
    expect(workers).toHaveLength(1);
  });

  it("starts its worker ahead of the first job when warmed, and the job runs in it", async () => {
    const { offloader, workers } = offloaderWith();
    offloader.warm();
    offloader.warm();
    expect(workers).toHaveLength(1);
    await offloader.run(brighten, image(4, 4), { amount: 1 }, undefined, signal());
    expect(workers).toHaveLength(1);
  });

  it("only offers bindings the worker loads", () => {
    const { offloader } = offloaderWith();
    expect(offloader.canRun(brighten as EffectBinding<unknown>)).toBe(true);
    const other = { ...brighten, descriptor: descriptor("test.other") };
    expect(offloader.canRun(other as EffectBinding<unknown>)).toBe(false);
  });

  it("copies the input, so the caller's pixels are untouched", async () => {
    const { offloader } = offloaderWith();
    const input = image(4, 4);
    const before = input.data.slice();
    await offloader.run(brighten, input, { amount: 90 }, undefined, signal());
    expect(input.data).toEqual(before);
  });

  it("rejects with an AbortError when the signal is already aborted", async () => {
    const { offloader, workers } = offloaderWith();
    const controller = new AbortController();
    controller.abort();
    const run = offloader.run(brighten, image(2, 2), { amount: 1 }, undefined, controller.signal);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(0);
  });

  it("stops a render in flight by terminating the worker, and the next run starts a new one", async () => {
    const { offloader, workers } = offloaderWith([brighten], true);
    const controller = new AbortController();
    const first = offloader.run(brighten, image(4, 4), { amount: 1 }, undefined, controller.signal);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]?.terminated).toBe(true);

    const next = await offloader.run(brighten, image(4, 4), { amount: 1 }, undefined, signal());
    expect(next).toEqual(brighten.cpu(image(4, 4), { amount: 1 }));
    expect(workers).toHaveLength(2);
  });

  it("passes a worker error to every job it still owes", async () => {
    const { offloader, workers } = offloaderWith([brighten], true);
    const run = offloader.run(brighten, image(2, 2), { amount: 1 }, undefined, signal());
    const [worker] = workers;
    if (worker === undefined) throw new Error("expected a worker");
    worker.onerror?.({ message: "boom" } as ErrorEvent);
    await expect(run).rejects.toThrow("boom");
  });

  it("passes the message of an error that the worker threw", async () => {
    const failing = {
      ...brighten,
      descriptor: descriptor("test.fail"),
      cpu: () => {
        throw new Error("no pixels");
      },
    };
    const { offloader } = offloaderWith([failing as EffectBinding<unknown>]);
    await expect(
      offloader.run(failing, image(2, 2), { amount: 1 }, undefined, signal()),
    ).rejects.toThrow("no pixels");
  });

  it("runs on this thread when the job cannot be posted to the worker", async () => {
    const { offloader, workers } = offloaderWith();
    const input = image(4, 4);
    await offloader.run(brighten, input, { amount: 1 }, undefined, signal());
    const [worker] = workers;
    if (worker === undefined) throw new Error("expected a worker");
    worker.failPost = true;
    const output = await offloader.run(brighten, input, { amount: 5 }, undefined, signal());
    expect(output).toEqual(brighten.cpu(input, { amount: 5 }));
  });

  it("passes the coverage to the worker and clips nothing itself", async () => {
    const seen: (ArrayLike<number> | undefined)[] = [];
    const probe = {
      ...brighten,
      descriptor: descriptor("test.probe"),
      cpu(input: Surface, params: Params, coverage?: ArrayLike<number>) {
        seen.push(coverage);
        return brighten.cpu(input, params);
      },
    };
    const { offloader } = offloaderWith([probe as EffectBinding<unknown>]);
    const coverage = new Uint8Array(4).fill(255);
    await offloader.run(probe, image(2, 2), { amount: 1 }, coverage, signal());
    expect(seen).toEqual([coverage]);
  });
});
