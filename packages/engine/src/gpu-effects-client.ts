import { Surface } from "@openpaint/document";
import type { EffectBinding, GpuOffloader } from "@openpaint/effects";
import {
  GPU_EFFECT_IDS,
  GPU_SOURCE_MISSING,
  type GpuEffectJob,
  type GpuEffectOutput,
  TRANSFORM_JOB,
} from "./gpu-effect-protocol";
import type { GpuTransformSpec } from "./gpu-transform";

/** The part of the engine handle that runs effects on its device. */
export interface GpuEffectPort {
  effectRun(job: GpuEffectJob): Promise<GpuEffectOutput>;
  effectCancel(id: number): Promise<void>;
  effectRelease(source: number): Promise<void>;
}

interface SentSource {
  readonly id: number;
  readonly coverage: ArrayLike<number> | undefined;
  sent: boolean;
}

function abortError(): Error {
  const error = new Error("The GPU render was canceled.");
  error.name = "AbortError";
  return error;
}

/**
 * Runs built-in effects on the engine worker's GPU device (WEB-GPU-01), so the app keeps one
 * device. A session's source goes to the worker once, with its first run; later previews send only
 * their parameters. A canceled run rejects at once and tells the worker to drop it. An effect whose
 * GPU run failed is not tried on the GPU again, so the CPU fallback (WEB-GPU-04) does not retry
 * and log on every preview.
 */
export class EngineGpuOffloader implements GpuOffloader {
  readonly #port: GpuEffectPort;
  readonly #available: () => boolean;
  readonly #sources = new WeakMap<Surface, SentSource>();
  readonly #failed = new Set<string>();
  #nextSource = 1;
  #nextJob = 1;

  /** `available` tells whether the engine runs on WebGPU now. */
  constructor(port: GpuEffectPort, available: () => boolean) {
    this.#port = port;
    this.#available = available;
  }

  canRun(binding: EffectBinding<unknown>): boolean {
    const id = binding.descriptor.id;
    return this.#available() && GPU_EFFECT_IDS.has(id) && !this.#failed.has(id);
  }

  async run<P>(
    binding: EffectBinding<P>,
    input: Surface,
    params: P,
    coverage: ArrayLike<number> | undefined,
    signal: AbortSignal,
  ): Promise<Surface> {
    return this.#runJob(binding.descriptor.id, input, params, coverage, signal);
  }

  /** Whether `transform` can run now: the engine is on WebGPU and the resampler has not failed. */
  get canTransform(): boolean {
    return this.#available() && !this.#failed.has(TRANSFORM_JOB);
  }

  /**
   * Resamples `input` for Move Selected Pixels on the engine's device (`GpuTransformSpec`). The
   * same `input` on later calls stays on the GPU, so a drag sends only the transform each frame.
   */
  transform(input: Surface, spec: GpuTransformSpec, signal: AbortSignal): Promise<Surface> {
    return this.#runJob(TRANSFORM_JOB, input, spec, undefined, signal);
  }

  async #runJob(
    effectId: string,
    input: Surface,
    params: unknown,
    coverage: ArrayLike<number> | undefined,
    signal: AbortSignal,
  ): Promise<Surface> {
    const known = this.#sources.get(input);
    let source: SentSource;
    if (known !== undefined && known.coverage === coverage) {
      source = known;
    } else {
      if (known?.sent === true) void this.#port.effectRelease(known.id).catch(() => undefined);
      source = { id: this.#nextSource++, coverage, sent: false };
      this.#sources.set(input, source);
    }
    const send = () => this.#send(effectId, input, params, source, signal);
    try {
      return await send();
    } catch (cause) {
      if (signal.aborted) throw cause;
      if (cause instanceof Error && cause.name === GPU_SOURCE_MISSING) {
        source.sent = false;
        return send();
      }
      this.#failed.add(effectId);
      throw cause;
    }
  }

  release(input: Surface): void {
    const source = this.#sources.get(input);
    if (source === undefined) return;
    this.#sources.delete(input);
    if (source.sent) void this.#port.effectRelease(source.id).catch(() => undefined);
  }

  #send(
    effectId: string,
    input: Surface,
    params: unknown,
    source: SentSource,
    signal: AbortSignal,
  ): Promise<Surface> {
    if (signal.aborted) return Promise.reject(abortError());
    const id = this.#nextJob++;
    const first = !source.sent;
    const coverage = source.coverage;
    const job: GpuEffectJob = {
      id,
      effectId,
      params,
      source: source.id,
      width: input.width,
      height: input.height,
      ...(first && { pixels: input.data.slice() }),
      ...(first && coverage !== undefined && { coverage: Uint8Array.from(coverage) }),
    };
    source.sent = true;
    return new Promise<Surface>((resolve, reject) => {
      const onAbort = () => {
        void this.#port.effectCancel(id).catch(() => undefined);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#port.effectRun(job).then(
        (output) => {
          signal.removeEventListener("abort", onAbort);
          resolve(new Surface(output.width, output.height, output.pixels));
        },
        (cause: unknown) => {
          signal.removeEventListener("abort", onAbort);
          if (first) source.sent = false;
          reject(cause);
        },
      );
    });
  }
}
