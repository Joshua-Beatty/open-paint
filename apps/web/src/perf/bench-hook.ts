import {
  type ColorRgba8,
  Document,
  LayerBlendMode,
  type MemoryAccountant,
  rgba8,
  Surface,
} from "@openpaint/document";
import type { EngineStatus, ViewLayout } from "@openpaint/engine";
import { canvasScale } from "../canvas-scale";

/** What `__openpaintBench.createDocument` builds. */
export interface BenchDocumentOptions {
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  /** Fill every layer with its own semi-transparent color. Transparent layers otherwise. */
  readonly fill: boolean;
}

/** What `__openpaintBench.info` reports about the running app. */
export interface BenchInfo {
  readonly backend: string | undefined;
  readonly adapter: EngineStatus["adapter"];
  /** The GPU performance class the engine resolved (SET-DLG-07). */
  readonly performanceClass: EngineStatus["performanceClass"] | undefined;
  readonly devicePixelRatio: number;
  readonly layout: ViewLayout | undefined;
  /** The engine running (`v1` unless v2 was asked for and WebGPU is in use). */
  readonly engine: string | undefined;
  /** Whether the page is cross-origin isolated (SharedArrayBuffer, WASM threads). */
  readonly crossOriginIsolated: boolean;
  readonly hardwareConcurrency: number;
  readonly userAgent: string;
}

/** `window.__openpaintBench`, present only with `?bench=1`. */
export interface BenchApi {
  /** Opens a new image tab with the generated document and fits the view. */
  createDocument(options: BenchDocumentOptions): { readonly layers: number };
  /** Sets the brush width option of the paint tools, in pixels. */
  setBrushSize(size: number): void;
  info(): BenchInfo;
}

declare global {
  interface Window {
    __openpaintBench?: BenchApi;
  }
}

/** The blend modes the layers cycle through, bottom to top. */
export const BENCH_BLEND_MODES: readonly LayerBlendMode[] = [
  LayerBlendMode.normal,
  LayerBlendMode.multiply,
  LayerBlendMode.screen,
  LayerBlendMode.overlay,
  LayerBlendMode.additive,
  LayerBlendMode.darken,
  LayerBlendMode.lighten,
  LayerBlendMode.difference,
];

/** The alpha of every filled layer: about 50 %. */
export const BENCH_ALPHA = 128;

/** A distinct color for layer `index`: hues a golden angle apart, at about 50 % alpha. */
export function benchLayerColor(index: number): ColorRgba8 {
  const hue = (index * 137.508) % 360;
  const channel = (n: number) => {
    const k = (n + hue / 60) % 6;
    const value = 0.9 - 0.9 * 0.75 * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(value * 255);
  };
  return rgba8(channel(5), channel(3), channel(1), BENCH_ALPHA);
}

/**
 * A document of `layers` layers, each filled with `benchLayerColor` and blended with the next of
 * `BENCH_BLEND_MODES`. It is built through the document model: the bottom layer comes from
 * `Document.fromLayers`, and every other layer is a real Add Layer step followed by a Layer
 * Properties step. Only the fill is a fast path: it writes the layer's pixels without a history
 * item, the way a live preview does, so no undo data is kept for it.
 */
export function createBenchDocument(
  options: BenchDocumentOptions,
  accountant?: MemoryAccountant,
): Document {
  const { width, height, layers, fill } = options;
  if (!Number.isInteger(layers) || layers < 1) throw new RangeError("A document needs a layer.");
  const bottom = new Surface(width, height);
  if (fill) bottom.fill(benchLayerColor(0));
  const doc = Document.fromLayers(
    width,
    height,
    [
      {
        pixels: bottom,
        name: "Background",
        visible: true,
        opacity: 255,
        blendMode: BENCH_BLEND_MODES[0] ?? LayerBlendMode.normal,
        isBackground: true,
      },
    ],
    accountant === undefined ? {} : { accountant },
  );
  for (let index = 1; index < layers; index++) {
    const layer = doc.addLayer();
    if (fill) doc.previewLayerPixels(layer, (pixels) => pixels.fill(benchLayerColor(index)));
    const blendMode = BENCH_BLEND_MODES[index % BENCH_BLEND_MODES.length];
    if (blendMode !== undefined) doc.setActiveLayerProperties({ blendMode });
  }
  return doc;
}

/** What the bench hook needs from the app. */
export interface BenchHost {
  open(document: Document): void;
  accountant(): MemoryAccountant;
  setSetting(path: string, value: number): void;
  status(): EngineStatus | undefined;
  layout(): ViewLayout | undefined;
}

/** Exposes `__openpaintBench` on `target`. Returns the function that removes it. */
export function installBenchHook(target: Window, host: BenchHost): () => void {
  target.__openpaintBench = {
    createDocument(options) {
      const doc = createBenchDocument(options, host.accountant());
      host.open(doc);
      return { layers: doc.layerCount };
    },
    setBrushSize: (size) => host.setSetting("tools.brush.size", size),
    info: () => ({
      backend: host.status()?.backend,
      adapter: host.status()?.adapter,
      performanceClass: host.status()?.performanceClass,
      // The engine canvas's scale, which bench geometry must use; it can differ from the window's.
      devicePixelRatio: canvasScale.value,
      layout: host.layout(),
      engine: host.status() === undefined ? undefined : (host.status()?.engine ?? "v1"),
      crossOriginIsolated: target.crossOriginIsolated === true,
      hardwareConcurrency: target.navigator?.hardwareConcurrency ?? 0,
      userAgent: target.navigator?.userAgent ?? "",
    }),
  };
  return () => {
    delete target.__openpaintBench;
  };
}
