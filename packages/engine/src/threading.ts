export interface ThreadingScope {
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: unknown;
  navigator?: { hardwareConcurrency?: number };
}

/**
 * Number of threads the WASM CPU kernels may use. Threads need `SharedArrayBuffer`, which browsers
 * only expose to cross-origin isolated pages (COOP/COEP), so anything else stays single-threaded.
 */
export function wasmThreadCount(scope: ThreadingScope = globalThis): number {
  if (scope.crossOriginIsolated !== true || typeof scope.SharedArrayBuffer !== "function") {
    return 1;
  }
  return Math.max(1, scope.navigator?.hardwareConcurrency ?? 1);
}
