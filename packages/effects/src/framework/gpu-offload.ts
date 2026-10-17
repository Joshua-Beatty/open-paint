import type { Surface } from "@openpaint/document";
import type { EffectBinding } from "./binding";

/**
 * Runs built-in effects with their WGSL implementation on the engine's GPU device (WEB-GPU-01).
 * The host supplies one when the engine runs on WebGPU. A run that fails rejects, and the render
 * falls back to the CPU implementation (WEB-GPU-04). A canceled run rejects at once.
 */
export interface GpuOffloader {
  /** Whether this binding can run on the GPU now: it has a WGSL twin and a device exists. */
  canRun(binding: EffectBinding<unknown>): boolean;
  run<P>(
    binding: EffectBinding<P>,
    input: Surface,
    params: P,
    coverage: ArrayLike<number> | undefined,
    signal: AbortSignal,
  ): Promise<Surface>;
  /**
   * Forgets `input`. A session renders the same source for every preview, so the offloader may keep
   * a copy next to the device between runs; the session releases it when it ends.
   */
  release?(input: Surface): void;
  /**
   * Resolves once the GPU has reported on every run so far, with whether `binding`'s runs were
   * free of errors. A run resolves with its pixels before the GPU reports its errors, so a commit
   * confirms before it records: a failed run is then rendered again on the CPU (WEB-GPU-04).
   */
  confirm?(binding: EffectBinding<unknown>): Promise<boolean>;
}
