import {
  type GradientLanes,
  type GradientWorkerLike,
  InlineGradientLanes,
  WorkerGradientLanes,
} from "../tools/gradient-tiles";

let lanes: GradientLanes | undefined;

/**
 * The gradient tile workers of the page (L7): a few, leaving cores for the main thread and the
 * engine. They start on the first gradient. Without workers, tiles render on this thread.
 */
export function gradientLanes(): GradientLanes {
  if (lanes !== undefined) return lanes;
  if (typeof Worker === "undefined") {
    lanes = new InlineGradientLanes();
    return lanes;
  }
  const cores = typeof navigator === "undefined" ? 4 : (navigator.hardwareConcurrency ?? 4);
  lanes = new WorkerGradientLanes(
    Math.max(1, Math.min(6, cores - 2)),
    () =>
      new Worker(new URL("./gradient-worker.ts", import.meta.url), {
        type: "module",
        name: "OpenPaint gradient",
      }) as unknown as GradientWorkerLike,
  );
  return lanes;
}
