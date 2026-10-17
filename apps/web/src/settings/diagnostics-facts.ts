import type { EngineStatus } from "@openpaint/engine";
import type {
  DiagnosticsFacts,
  FileCodecFact,
  GraphicsFacts,
  PlatformApis,
  UpdateFacts,
} from "./diagnostics";

/** Bytes of a tiny module that uses WASM SIMD, to test support (SET-ERR-05 "WASM SIMD support"). */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

/** The worker pool size for a `performance.workerPolicy` value (SET-STO-03, SET-NFR-05). */
export function workerPoolSize(policy: string, cores: number): number {
  switch (policy) {
    case "AllButOne":
      return Math.max(1, cores - 1);
    case "All":
      return Math.max(1, cores);
    case "Single":
      return 1;
    default:
      return Math.max(1, Math.floor(0.75 * cores));
  }
}

function mediaMatches(query: string): boolean {
  return globalThis.matchMedia?.(query).matches ?? false;
}

function graphicsFacts(status: EngineStatus | undefined): GraphicsFacts | undefined {
  if (status === undefined) return undefined;
  return {
    setting: status.setting,
    backend: status.backend,
    reason: status.reason,
    ...(status.adapter === undefined ? {} : { adapter: status.adapter }),
    performanceClass: status.performanceClass,
    deviceLosses: status.deviceLossCount,
  };
}

function platformApis(): PlatformApis {
  const scope = globalThis as unknown as Record<string, unknown>;
  const keyboard = (navigator as { keyboard?: { lock?: unknown } }).keyboard;
  return {
    fileSystemAccess: "showOpenFilePicker" in globalThis,
    launchQueue: "launchQueue" in globalThis,
    clipboard: typeof navigator.clipboard?.read === "function",
    localFonts: "queryLocalFonts" in globalThis,
    keyboardLock: typeof keyboard?.lock === "function",
    fullscreen: document.fullscreenEnabled,
    offscreenCanvas: typeof scope.OffscreenCanvas !== "undefined",
    imageDecoder: typeof scope.ImageDecoder !== "undefined",
  };
}

async function storageFacts(): Promise<DiagnosticsFacts["storage"]> {
  const storage = navigator.storage;
  if (storage === undefined) return undefined;
  const estimate = await storage.estimate?.().catch(() => undefined);
  if (estimate === undefined || estimate.quota === undefined) return undefined;
  const persisted = await storage.persisted?.().catch(() => undefined);
  return {
    usage: estimate.usage ?? 0,
    quota: estimate.quota,
    ...(persisted === undefined ? {} : { persisted }),
  };
}

/** Input the browser does not expose on its own: the engine state and the settings the app holds. */
export interface FactsInput {
  readonly version: string;
  readonly buildDate?: string | undefined;
  readonly update?: UpdateFacts | undefined;
  readonly sessionStart: Date;
  readonly status: EngineStatus | undefined;
  readonly penDetected: boolean;
  readonly animations: boolean;
  readonly workerPolicy: string;
  readonly fileCodecs?: readonly FileCodecFact[] | undefined;
}

/** Gathers the diagnostics report from the browser, the engine and the settings (SET-ERR-05). */
export async function gatherDiagnosticsFacts(input: FactsInput): Promise<DiagnosticsFacts> {
  const cores = navigator.hardwareConcurrency || 1;
  const brands = (
    navigator as { userAgentData?: { brands?: { brand: string; version: string }[] } }
  ).userAgentData?.brands;
  const memory = (performance as { memory?: { usedJSHeapSize?: number } }).memory;
  const deviceMemory = (navigator as { deviceMemory?: number }).deviceMemory;
  const storage = await storageFacts();
  const graphics = graphicsFacts(input.status);
  const gamut = mediaMatches("(color-gamut: rec2020)")
    ? "rec2020"
    : mediaMatches("(color-gamut: p3)")
      ? "p3"
      : mediaMatches("(color-gamut: srgb)")
        ? "srgb"
        : undefined;
  return {
    version: input.version,
    ...(input.buildDate === undefined ? {} : { buildDate: input.buildDate }),
    ...(input.update === undefined ? {} : { update: input.update }),
    now: new Date(),
    sessionStart: input.sessionStart,
    installed: mediaMatches("(display-mode: standalone)"),
    serviceWorkerActive: navigator.serviceWorker?.controller != null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    devicePixelRatio: globalThis.devicePixelRatio,
    language: navigator.language,
    darkScheme: document.documentElement.dataset.colorScheme === "dark",
    animations: input.animations,
    reducedMotion: mediaMatches("(prefers-reduced-motion: reduce)"),
    penDetected: input.penDetected,
    browserBrands: (brands ?? []).map((entry) => ({ brand: entry.brand, version: entry.version })),
    online: navigator.onLine,
    ...(deviceMemory === undefined ? {} : { deviceMemoryGb: deviceMemory }),
    ...(memory?.usedJSHeapSize === undefined ? {} : { heapUsedBytes: memory.usedJSHeapSize }),
    ...(storage === undefined ? {} : { storage }),
    logicalCores: cores,
    workerPoolSize: workerPoolSize(input.workerPolicy, cores),
    wasmSimd: WebAssembly.validate(SIMD_PROBE),
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    ...(graphics === undefined ? {} : { graphics }),
    screen: { width: screen.width, height: screen.height },
    ...(gamut === undefined ? {} : { gamut }),
    highDynamicRange: mediaMatches("(dynamic-range: high)"),
    pointer: {
      fine: mediaMatches("(pointer: fine)"),
      hover: mediaMatches("(hover: hover)"),
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
    },
    platform: platformApis(),
    ...(input.fileCodecs === undefined ? {} : { fileCodecs: input.fileCodecs }),
  };
}
