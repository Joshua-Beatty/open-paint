import { builtinEffectBindings, type CpuWorkerLike, WorkerCpuOffloader } from "@openpaint/effects";

let offloader: WorkerCpuOffloader | undefined;

/**
 * The offloader for the built-in CPU effects and layer resamples, shared by the app (PRD-NF-02).
 * The worker starts on the first job, so the start-up path does not pay for it.
 */
export function cpuOffloader(): WorkerCpuOffloader {
  offloader ??= new WorkerCpuOffloader({
    createWorker: () =>
      new Worker(new URL("./cpu-worker.ts", import.meta.url), {
        type: "module",
      }) as unknown as CpuWorkerLike,
    builtinIds: new Set(builtinEffectBindings(1, 1).map((binding) => binding.descriptor.id)),
    // A Move Selected Pixels commit resamples the whole selection with the reference: split
    // across a few cores. Each worker holds a copy of the content while it runs.
    floatBands: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)),
  });
  return offloader;
}

/**
 * Starts the offloader's worker when the page is next idle, so the first Move Selected Pixels
 * commit does not wait for the worker to load. Returns the function that calls it off.
 */
export function warmCpuOffloader(): () => void {
  const warm = () => cpuOffloader().warm();
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(warm, { timeout: 2000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(warm, 500);
  return () => clearTimeout(id);
}
