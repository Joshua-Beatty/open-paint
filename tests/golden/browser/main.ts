import { decodePng, type Inflate, type RgbaImage } from "@openpaint/codecs";
import {
  composeAffine,
  rect,
  renderTransformed,
  renderTransformedWith,
  rotationAboutAffine,
  Surface,
  TILE_SIZE,
  TiledPixelStore,
  type TransformOptions,
  type TransformSampling,
} from "@openpaint/document";
import {
  AFFINE_SAMPLE_MAP_WGSL,
  addNoiseCpu,
  BULGE_SAMPLE_MAP_WGSL,
  builtinEffectBindings,
  cloudsCpu,
  crystalizeSampleMapWgsl,
  dentsSampleMapWgsl,
  flipObjectCpu,
  juliaCpu,
  mandelbrotCpu,
  medianBlurCpu,
  POLAR_SAMPLE_MAP_WGSL,
  reduceNoiseCpu,
  sketchBlurCpu,
  surfaceBlurCpu,
  TILE_SAMPLE_MAP_WGSL,
  TWIST_SAMPLE_MAP_WGSL,
  turbulenceCpu,
} from "@openpaint/effects";
import {
  benchmarkPerformanceClass,
  type ComposedTile,
  type CompositeDocument,
  checkCompositeV2,
  checkFloat,
  checkPartialSyncV2,
  checkPresentedEdges,
  checkStrokeV2,
  GpuAddNoise,
  GpuAdjustment,
  GpuAlignObject,
  GpuBokehBlur,
  GpuClouds,
  GpuCompositor,
  GpuDistortion,
  GpuDropShadow,
  GpuEdgeDetect,
  GpuEffectQueue,
  GpuEmboss,
  GpuFlipObject,
  GpuFragmentBlur,
  GpuFrostedGlass,
  GpuGaussianBlur,
  GpuGlow,
  GpuInkSketch,
  GpuJulia,
  GpuMandelbrot,
  GpuMedianBlur,
  GpuMorphology,
  GpuMotionBlur,
  GpuOilPainting,
  GpuOutline,
  GpuPencilSketch,
  GpuPixelate,
  GpuPixelNoise,
  GpuRadialBlur,
  GpuReduceNoise,
  GpuRelief,
  GpuRotateZoom,
  GpuSharpen,
  GpuSketchBlur,
  GpuSoftenPortrait,
  GpuSquareBlur,
  GpuStraighten,
  GpuSurfaceBlur,
  GpuTileCache,
  GpuTransform,
  GpuTurbulence,
  GpuVignette,
  GpuZoomBlur,
  initCpu,
  requestDevice as requestEngineDevice,
  V2_COMPOSITE_CASES,
  V2_STROKE_CASES,
} from "@openpaint/engine";
import { adjustmentPlanFor } from "../src/adjust-reference";
import type { WarpCase } from "../src/cases";
import {
  ADD_NOISE_CASES,
  ADJUSTMENT_CASES,
  ADJUSTMENT_INPUT,
  ALIGN_OBJECT_CASES,
  alignObjectCoverage,
  alignObjectInput,
  BLEND_CASES,
  BLEND_INPUTS,
  BLUR_CASES,
  BLUR_INPUT,
  type BlendCase,
  BOKEH_CASES,
  DISTORT_CASES,
  DROP_SHADOW_CASES,
  EDGE_DETECT_CASES,
  EMBOSS_CASES,
  FLIP_OBJECT_CASES,
  FRAGMENT_CASES,
  FROST_CASES,
  flipObjectCoverage,
  flipObjectInput,
  GLOW_CASES,
  INK_CASES,
  MEDIAN_CASES,
  MORPHOLOGY_CASES,
  MOTION_CASES,
  NOISE_CASES,
  OIL_CASES,
  OUTLINE_CASES,
  PENCIL_CASES,
  PIXELATE_CASES,
  RADIAL_CASES,
  REDUCE_NOISE_CASES,
  RELIEF_CASES,
  ROTATE_ZOOM_CASES,
  SHARPEN_CASES,
  SKETCH_CASES,
  SOFTEN_CASES,
  SQUARE_CASES,
  STRAIGHTEN_CASES,
  SURFACE_CASES,
  TILED_CASES,
  VIGNETTE_CASES,
  WARP_CASES,
  ZOOM_CASES,
} from "../src/cases";
import { diffImages } from "../src/compare";
import { makeTiledInput } from "../src/inputs";
import { CLOUDS_CASES, JULIA_CASES, MANDELBROT_CASES, TURBULENCE_CASES } from "../src/render-cases";
import { warpEdgeOf, warpPlanOf } from "../src/warp-reference";

/** Result of one GPU case; `null` from `runGoldenCase` means no WebGPU adapter. */
export interface GoldenResult {
  readonly id: string;
  readonly maxDifference: number;
  readonly differingChannels: number;
}

declare global {
  interface Window {
    runGoldenCase: (id: string) => Promise<GoldenResult | null>;
    runBlurCase: (id: string) => Promise<GoldenResult | null>;
    runAdjustmentCase: (id: string) => Promise<GoldenResult | null>;
    runDistortCase: (id: string) => Promise<GoldenResult | null>;
    runWarpCase: (id: string) => Promise<GoldenResult | null>;
    runNoiseCase: (id: string) => Promise<GoldenResult | null>;
    runAddNoiseCase: (id: string) => Promise<GoldenResult | null>;
    runReduceNoiseCase: (id: string) => Promise<GoldenResult | null>;
    runFrostCase: (id: string) => Promise<GoldenResult | null>;
    runPixelateCase: (id: string) => Promise<GoldenResult | null>;
    runMorphologyCase: (id: string) => Promise<GoldenResult | null>;
    runFragmentCase: (id: string) => Promise<GoldenResult | null>;
    runMotionCase: (id: string) => Promise<GoldenResult | null>;
    runRadialCase: (id: string) => Promise<GoldenResult | null>;
    runZoomCase: (id: string) => Promise<GoldenResult | null>;
    runMedianCase: (id: string) => Promise<GoldenResult | null>;
    runSurfaceCase: (id: string) => Promise<GoldenResult | null>;
    runSquareCase: (id: string) => Promise<GoldenResult | null>;
    runSketchCase: (id: string) => Promise<GoldenResult | null>;
    runBokehCase: (id: string) => Promise<GoldenResult | null>;
    runInkCase: (id: string) => Promise<GoldenResult | null>;
    runOilCase: (id: string) => Promise<GoldenResult | null>;
    runPencilCase: (id: string) => Promise<GoldenResult | null>;
    runGlowCase: (id: string) => Promise<GoldenResult | null>;
    runSoftenCase: (id: string) => Promise<GoldenResult | null>;
    runSharpenCase: (id: string) => Promise<GoldenResult | null>;
    runEdgeDetectCase: (id: string) => Promise<GoldenResult | null>;
    runEmbossCase: (id: string) => Promise<GoldenResult | null>;
    runReliefCase: (id: string) => Promise<GoldenResult | null>;
    runOutlineCase: (id: string) => Promise<GoldenResult | null>;
    runDropShadowCase: (id: string) => Promise<GoldenResult | null>;
    runAlignObjectCase: (id: string) => Promise<GoldenResult | null>;
    runFlipObjectCase: (id: string) => Promise<GoldenResult | null>;
    runStraightenCase: (id: string) => Promise<GoldenResult | null>;
    runRotateZoomCase: (id: string) => Promise<GoldenResult | null>;
    runVignetteCase: (id: string) => Promise<GoldenResult | null>;
    runCloudsCase: (id: string) => Promise<GoldenResult | null>;
    runTurbulenceCase: (id: string) => Promise<GoldenResult | null>;
    runJuliaCase: (id: string) => Promise<GoldenResult | null>;
    runMandelbrotCase: (id: string) => Promise<GoldenResult | null>;
    runTiledCase: (id: string) => Promise<GoldenResult | null>;
    runAppEffectCase: (id: string) => Promise<GoldenResult | null>;
    runTransformCase: (id: string) => Promise<GoldenResult | null>;
    runV2CompositeCase: (id: string) => Promise<GoldenResult | null>;
    runV2StrokeCase: (id: string) => Promise<GoldenResult | null>;
    runV2SyncCase: (id: string) => Promise<GoldenResult | null>;
    runPresentEdgeCase: (id: string) => Promise<GoldenResult | null>;
    runFloatCase: (id: string) => Promise<GoldenResult | null>;
    runPerformanceClass: () => Promise<{
      readonly performanceClass: string;
      readonly errors: string[];
    } | null>;
  }
}

/** Bytes per row of a tile-sized RGBA8 readback; WebGPU needs a multiple of 256. */
const ROW_BYTES = TILE_SIZE * 4;
/** `GPUBufferUsage` flags, as in the engine tests (the DOM lib omits the globals). */
const MAP_READ = 0x1;
const COPY_DST = 0x8;

let devicePromise: Promise<GPUDevice | null> | undefined;

function getDevice(): Promise<GPUDevice | null> {
  devicePromise ??= requestDevice();
  return devicePromise;
}

async function requestDevice(): Promise<GPUDevice | null> {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    const device = (await adapter?.requestDevice()) ?? null;
    // Validation errors are otherwise silent; the specs fail on page errors and console errors.
    device?.addEventListener("uncapturederror", (event) => {
      console.error((event as GPUUncapturedErrorEvent).error.message);
    });
    return device;
  } catch {
    return null;
  }
}

const inflate: Inflate = async (data) => {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

async function loadReference(path: string): Promise<RgbaImage> {
  const response = await fetch(`/${path}`);
  if (!response.ok) throw new Error(`Failed to load ${path}: HTTP ${response.status}.`);
  return decodePng(new Uint8Array(await response.arrayBuffer()), inflate);
}

function storeOf(image: RgbaImage): TiledPixelStore {
  const store = new TiledPixelStore(image.width, image.height);
  const surface = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  store.writeRegion(surface, 0, 0);
  return store;
}

/** Copies a GPU texture's tile-sized contents back to the CPU. */
async function readTexture(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const buffer = device.createBuffer({ size: ROW_BYTES * TILE_SIZE, usage: MAP_READ | COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: ROW_BYTES }, [
    TILE_SIZE,
    TILE_SIZE,
  ]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.destroy();
  return bytes;
}

/** Assembles composited tiles into one straight-alpha image of the given size. */
async function readComposite(
  device: GPUDevice,
  tiles: readonly ComposedTile[],
  width: number,
  height: number,
): Promise<RgbaImage> {
  const data = new Uint8Array(width * height * 4);
  for (const tile of tiles) {
    const bytes = await readTexture(device, tile.texture);
    const rows = Math.min(TILE_SIZE, height - tile.y);
    const columns = Math.min(TILE_SIZE, width - tile.x);
    for (let y = 0; y < rows; y++) {
      const from = y * ROW_BYTES;
      const to = ((tile.y + y) * width + tile.x) * 4;
      data.set(bytes.subarray(from, from + columns * 4), to);
    }
  }
  return { width, height, data };
}

/** Composites the two reference inputs on the GPU exactly as the layer compositor does. */
async function composeOnGpu(device: GPUDevice, kase: BlendCase): Promise<RgbaImage> {
  const dstImage = await loadReference(BLEND_INPUTS.dst);
  const srcImage = await loadReference(BLEND_INPUTS.src);
  const { width, height } = dstImage;
  const dst = storeOf(dstImage);
  const src = storeOf(srcImage);

  const tiles = new GpuTileCache();
  tiles.setDevice(device);
  tiles.track(dst);
  tiles.track(src);
  // The destination is the bottom layer, composited Normal over transparency, which is identity.
  const doc: CompositeDocument = {
    width,
    height,
    layers: [
      { store: dst, mode: 0, opacity: 255, visible: true },
      { store: src, mode: kase.mode, opacity: kase.opacity, visible: true },
    ],
  };
  const compositor = new GpuCompositor(device, tiles, "rgba8unorm");
  const composed = compositor.compose(doc, rect(0, 0, width, height));
  return readComposite(device, composed, width, height);
}

async function runGoldenCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = BLEND_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  const actual = await composeOnGpu(device, kase);
  const expected = await loadReference(kase.expected);
  const diff = diffImages(actual, expected);
  return { id, ...diff };
}

window.runGoldenCase = runGoldenCase;

let cpuReady: Promise<unknown> | undefined;

/** The blur kernel weights come from the Rust/WASM module, so it must be initialized first. */
function ensureCpu(): Promise<unknown> {
  cpuReady ??= initCpu();
  return cpuReady;
}

async function runBlurCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = BLUR_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const blur = new GpuGaussianBlur(device);
  const out = await blur.run(input, {
    radius: kase.radius,
    gammaBoost: kase.gammaBoost,
    quality: kase.quality,
  });
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runBlurCase = runBlurCase;

async function runAdjustmentCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = ADJUSTMENT_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(ADJUSTMENT_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const adjustments = new GpuAdjustment(device);
  const out = await adjustments.run(input, adjustmentPlanFor(kase, input));
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runAdjustmentCase = runAdjustmentCase;

async function runDistortCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = DISTORT_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const distortion = new GpuDistortion(device, AFFINE_SAMPLE_MAP_WGSL);
  const out = await distortion.run(input, {
    quality: kase.quality,
    edge: kase.edge,
    mapParams: kase.matrix,
  });
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runDistortCase = runDistortCase;

/** The WGSL sample map of a warp case. Crystalize and Dents build theirs from the WASM tables. */
function warpSampleMapOf(kase: WarpCase): string {
  switch (kase.kind) {
    case "bulge":
      return BULGE_SAMPLE_MAP_WGSL;
    case "twist":
      return TWIST_SAMPLE_MAP_WGSL;
    case "polar":
      return POLAR_SAMPLE_MAP_WGSL;
    case "tile":
      return TILE_SAMPLE_MAP_WGSL;
    case "crystalize":
      return crystalizeSampleMapWgsl();
    case "dents":
      return dentsSampleMapWgsl();
  }
}

async function runWarpCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = WARP_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const distortion = new GpuDistortion(device, warpSampleMapOf(kase));
  const out = await distortion.run(input, {
    quality: kase.quality,
    edge: warpEdgeOf(kase),
    mapParams: Array.from(warpPlanOf(kase, input.width, input.height)),
  });
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runWarpCase = runWarpCase;

async function runNoiseCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = NOISE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  const expected = await loadReference(kase.expected);
  const noise = new GpuPixelNoise(device);
  const out = await noise.run(expected.width, expected.height, kase.seed);
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  return { id, ...diffImages(actual, expected) };
}

window.runNoiseCase = runNoiseCase;

async function runAddNoiseCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = ADD_NOISE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuAddNoise(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runAddNoiseCase = runAddNoiseCase;

async function runReduceNoiseCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = REDUCE_NOISE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuReduceNoise(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runReduceNoiseCase = runReduceNoiseCase;

async function runFrostCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = FROST_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const frost = new GpuFrostedGlass(device);
  const out = await frost.run(input, kase.params);
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runFrostCase = runFrostCase;

async function runPixelateCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = PIXELATE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const pixelate = new GpuPixelate(device);
  const out = await pixelate.run(input, kase.params);
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runPixelateCase = runPixelateCase;

async function runMorphologyCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = MORPHOLOGY_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const morphology = new GpuMorphology(device);
  const out = await morphology.run(input, kase.params);
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runMorphologyCase = runMorphologyCase;

async function runInkCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = INK_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuInkSketch(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runInkCase = runInkCase;

async function runOilCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = OIL_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuOilPainting(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runOilCase = runOilCase;

async function runPencilCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = PENCIL_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuPencilSketch(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runPencilCase = runPencilCase;

async function runGlowCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = GLOW_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuGlow(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runGlowCase = runGlowCase;

async function runSoftenCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = SOFTEN_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuSoftenPortrait(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runSoftenCase = runSoftenCase;

async function runSharpenCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = SHARPEN_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuSharpen(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runSharpenCase = runSharpenCase;

async function runEdgeDetectCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = EDGE_DETECT_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuEdgeDetect(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runEdgeDetectCase = runEdgeDetectCase;

async function runEmbossCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = EMBOSS_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuEmboss(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runEmbossCase = runEmbossCase;

async function runReliefCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = RELIEF_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuRelief(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runReliefCase = runReliefCase;

async function runOutlineCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = OUTLINE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuOutline(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runOutlineCase = runOutlineCase;

async function runDropShadowCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = DROP_SHADOW_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuDropShadow(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runDropShadowCase = runDropShadowCase;

async function runAlignObjectCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = ALIGN_OBJECT_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const source = alignObjectInput();
  const input = new Surface(source.width, source.height, new Uint8ClampedArray(source.data));
  const coverage = alignObjectCoverage(kase, source.width, source.height);
  const out = await new GpuAlignObject(device).run(input, kase.params, coverage);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runAlignObjectCase = runAlignObjectCase;

/** Flip on WebGPU against the Rust reference, both run in the page (no stored fixture). */
async function runFlipObjectCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = FLIP_OBJECT_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const { data } = flipObjectInput(kase);
  const input = new Surface(kase.width, kase.height, new Uint8ClampedArray(data));
  const coverage = flipObjectCoverage(kase);
  const params = { vertical: kase.vertical };
  const out = await new GpuFlipObject(device).run(input, params, coverage);
  const expected = flipObjectCpu(input, params, coverage);
  return { id, ...diffImages(surfaceImage(out), surfaceImage(expected)) };
}

window.runFlipObjectCase = runFlipObjectCase;

async function runStraightenCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = STRAIGHTEN_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuStraighten(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runStraightenCase = runStraightenCase;

async function runRotateZoomCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = ROTATE_ZOOM_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuRotateZoom(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runRotateZoomCase = runRotateZoomCase;

async function runVignetteCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = VIGNETTE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuVignette(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runVignetteCase = runVignetteCase;

async function runFragmentCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = FRAGMENT_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const fragment = new GpuFragmentBlur(device);
  const out = await fragment.run(input, kase.params);
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runFragmentCase = runFragmentCase;

async function runMotionCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = MOTION_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const motion = new GpuMotionBlur(device);
  const out = await motion.run(input, kase.params);
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runMotionCase = runMotionCase;

async function runRadialCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = RADIAL_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const radial = new GpuRadialBlur(device);
  const out = await radial.run(input, kase.params);
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runRadialCase = runRadialCase;

async function runZoomCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = ZOOM_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const zoom = new GpuZoomBlur(device);
  const out = await zoom.run(input, kase.params);
  const actual: RgbaImage = {
    width: out.width,
    height: out.height,
    data: new Uint8Array(out.data),
  };
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(actual, expected) };
}

window.runZoomCase = runZoomCase;

async function runMedianCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = MEDIAN_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const median = new GpuMedianBlur(device);
  const out = await median.run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runMedianCase = runMedianCase;

async function runSurfaceCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = SURFACE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const surface = new GpuSurfaceBlur(device);
  const out = await surface.run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runSurfaceCase = runSurfaceCase;

async function runSquareCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = SQUARE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuSquareBlur(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runSquareCase = runSquareCase;

async function runSketchCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = SKETCH_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuSketchBlur(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runSketchCase = runSketchCase;

async function runBokehCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = BOKEH_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = await loadReference(BLUR_INPUT);
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  const out = await new GpuBokehBlur(device).run(input, kase.params);
  const expected = await loadReference(kase.expected);
  return { id, ...diffImages(surfaceImage(out), expected) };
}

window.runBokehCase = runBokehCase;

/**
 * A tiled neighborhood blur on the generated tiled input: the GPU runs one dispatch per tile, and the
 * Rust reference runs in this page on the same pixels.
 */
async function runTiledCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = TILED_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const image = makeTiledInput();
  const input = new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
  if (kase.kind === "median") {
    const out = await new GpuMedianBlur(device).run(input, kase.params);
    const expected = medianBlurCpu(input, kase.params);
    return { id, ...diffImages(surfaceImage(out), surfaceImage(expected)) };
  }
  if (kase.kind === "sketch") {
    const out = await new GpuSketchBlur(device).run(input, kase.params);
    const expected = sketchBlurCpu(input, kase.params);
    return { id, ...diffImages(surfaceImage(out), surfaceImage(expected)) };
  }
  if (kase.kind === "addNoise") {
    const out = await new GpuAddNoise(device).run(input, kase.params);
    const expected = addNoiseCpu(input, kase.params);
    return { id, ...diffImages(surfaceImage(out), surfaceImage(expected)) };
  }
  if (kase.kind === "reduceNoise") {
    const out = await new GpuReduceNoise(device).run(input, kase.params);
    const expected = reduceNoiseCpu(input, kase.params);
    return { id, ...diffImages(surfaceImage(out), surfaceImage(expected)) };
  }
  const out = await new GpuSurfaceBlur(device).run(input, kase.params);
  const expected = surfaceBlurCpu(input, kase.params);
  return { id, ...diffImages(surfaceImage(out), surfaceImage(expected)) };
}

async function renderInput(): Promise<Surface> {
  const image = await loadReference(BLUR_INPUT);
  return new Surface(image.width, image.height, new Uint8ClampedArray(image.data));
}

/** Clouds on WebGPU against the Rust reference, both run in the page (no stored fixture). */
async function runCloudsCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = CLOUDS_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const input = await renderInput();
  const out = await new GpuClouds(device).run(input, kase.params);
  const expected = cloudsCpu(input, kase.params);
  return { id, ...diffImages(surfaceImage(out), surfaceImage(expected)) };
}

window.runCloudsCase = runCloudsCase;

/** Turbulence on WebGPU against the Rust reference, both run in the page (no stored fixture). */
async function runTurbulenceCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = TURBULENCE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const input = await renderInput();
  const out = await new GpuTurbulence(device).run(input, kase.params);
  const expected = turbulenceCpu(input, kase.params);
  return { id, ...diffImages(surfaceImage(out), surfaceImage(expected)) };
}

window.runTurbulenceCase = runTurbulenceCase;

/** Julia on WebGPU against the Rust reference, both run in the page (no stored fixture). */
async function runJuliaCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = JULIA_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const input = await renderInput();
  const out = await new GpuJulia(device).run(input, kase.params);
  const expected = juliaCpu(input, kase.params);
  return { id, ...diffImages(surfaceImage(out), surfaceImage(expected)) };
}

window.runJuliaCase = runJuliaCase;

/** Mandelbrot on WebGPU against the Rust reference, both run in the page (no stored fixture). */
async function runMandelbrotCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = MANDELBROT_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown golden case ${id}.`);
  await ensureCpu();
  const input = await renderInput();
  const out = await new GpuMandelbrot(device).run(input, kase.params);
  const expected = mandelbrotCpu(input, kase.params);
  return { id, ...diffImages(surfaceImage(out), surfaceImage(expected)) };
}

window.runMandelbrotCase = runMandelbrotCase;

window.runTiledCase = runTiledCase;

/**
 * A built-in effect as the app runs it on the GPU: its binding's default parameters, through the
 * engine worker's effect queue, against the binding's Rust reference on the same pixels. `id` is
 * the effect id, with `@selection` for a run with a selection over the left two thirds.
 */
async function runAppEffectCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  await ensureCpu();
  const [effectId = "", variant] = id.split("@");
  const binding = builtinEffectBindings(2).find((item) => item.descriptor.id === effectId);
  if (!binding) throw new Error(`Unknown effect ${effectId}.`);
  const input = variant?.startsWith("reds") ? redsInput() : await renderInput();
  const { width, height } = input;
  let coverage: Uint8Array<ArrayBuffer> | undefined;
  if (variant?.endsWith("selection")) {
    coverage = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      coverage.fill(255, y * width, y * width + Math.floor((width * 2) / 3));
    // Antialiased edges: partial coverage over the last third of each row.
    if (variant === "reds-selection" || variant === "partial-selection") {
      for (let i = 0; i < coverage.length; i++) {
        if (coverage[i] === 0) coverage[i] = (i * 37) & 255;
      }
    }
  }
  const analysis = binding.analyze?.(input, coverage);
  const params = binding.params({}, { width, height }, 12345, { x: 0, y: 0 }, analysis);
  const queue = new GpuEffectQueue(() => device);
  const job = { effectId, params: structuredClone(params), source: 1, width, height };
  const first = await queue.run({
    ...job,
    id: 1,
    pixels: input.data.slice(),
    ...(coverage && { coverage: coverage.slice() }),
  });
  // A second preview reuses the source kept on the GPU instead of uploading it.
  const second = await queue.run({ ...job, id: 2 });
  const expected = surfaceImage(binding.cpu(input, params, coverage));
  const diffs = [first, second].map((out) =>
    diffImages(surfaceImage(new Surface(out.width, out.height, out.pixels)), expected),
  );
  const worst = diffs.reduce((a, b) => (b.maxDifference > a.maxDifference ? b : a));
  return { id, ...worst };
}

window.runAppEffectCase = runAppEffectCase;

/**
 * Every red against a ramp of green and blue, so Red Eye Removal's thresholds (red above 0.25 and
 * above the ratio times the larger of green and blue) are crossed at every level.
 */
function redsInput(): Surface {
  const width = 64;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 4 + y) & 255;
      data[i + 1] = (y * 3) & 255;
      data[i + 2] = (x * 7 + y * 5) % 160;
      data[i + 3] = 255 - ((x + y) % 4) * 60;
    }
  }
  return new Surface(width, height, data);
}

/**
 * Move Selected Pixels' resampling on the GPU against `transform_rgba8`. `id` is
 * `<sampling>-<linear|companded>-<rotate|shrink|grow>`.
 */
async function runTransformCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  await ensureCpu();
  const [sampling = "", light = "", kind = ""] = id.split("-");
  const options: TransformOptions = {
    sampling: sampling as TransformSampling,
    linearLight: light === "linear",
  };
  const input = await renderInput();
  const center = { x: input.width / 2, y: input.height / 2 };
  const turn = rotationAboutAffine(center.x, center.y, kind === "rotate" ? 0.3 : 1.1);
  const scale = kind === "shrink" ? 0.45 : kind === "grow" ? 1.7 : 1;
  const m = composeAffine(turn, {
    a: scale,
    b: 0,
    c: 0,
    d: scale,
    e: center.x * (1 - scale) + 0.37,
    f: center.y * (1 - scale) - 0.21,
  });
  const clip = rect(-200, -200, input.width + 400, input.height + 400);
  const expected = renderTransformed(input, m, options, clip);
  const runner = new GpuTransform(device);
  const actual = await renderTransformedWith(
    (source, spec) => runner.run(source, spec),
    input,
    m,
    options,
    clip,
    new AbortController().signal,
  );
  if (!expected || !actual) throw new Error(`${id}: nothing landed.`);
  return { id, ...diffImages(surfaceImage(actual.pixels), surfaceImage(expected.pixels)) };
}

window.runTransformCase = runTransformCase;

function surfaceImage(surface: Surface): RgbaImage {
  return { width: surface.width, height: surface.height, data: new Uint8Array(surface.data) };
}

async function runV2CompositeCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = V2_COMPOSITE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown v2 composite case ${id}.`);
  await ensureCpu();
  const result = await checkCompositeV2(
    device,
    kase.width,
    kase.height,
    kase.layers,
    kase.pageSlices,
  );
  return { id, ...result };
}

window.runV2CompositeCase = runV2CompositeCase;

async function runV2StrokeCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  const kase = V2_STROKE_CASES.find((candidate) => candidate.id === id);
  if (!kase) throw new Error(`Unknown v2 stroke case ${id}.`);
  await ensureCpu();
  return { id, ...(await checkStrokeV2(device, kase)) };
}

window.runV2StrokeCase = runV2StrokeCase;

async function runV2SyncCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  await ensureCpu();
  return { id, ...(await checkPartialSyncV2(device)) };
}

window.runV2SyncCase = runV2SyncCase;

/**
 * The canvas edge check (UI-VIEW-02): `gpu` presents with WebGPU into the canvas's own context and
 * `gpu-bitmap` through a bitmap copy, both null without an adapter; `cpu` presents with Canvas 2D.
 */
async function runPresentEdgeCase(id: string): Promise<GoldenResult | null> {
  await ensureCpu();
  if (id === "cpu") return { id, ...(await checkPresentedEdges()) };
  const device = await getDevice();
  if (!device) return null;
  return {
    id,
    ...(await checkPresentedEdges(device, id === "gpu-bitmap" ? "bitmap" : "direct")),
  };
}

window.runPresentEdgeCase = runPresentEdgeCase;

/** The floating preview of Move Selected Pixels on the GPU against the reference (TL-MOVE-PIX-01). */
async function runFloatCase(id: string): Promise<GoldenResult | null> {
  const device = await getDevice();
  if (!device) return null;
  await ensureCpu();
  return { id, ...(await checkFloat(device, id)) };
}

window.runFloatCase = runFloatCase;

/**
 * The startup GPU benchmark on a device as the engine requests it (timestamps when the adapter has
 * them), with the GPU errors it caused.
 */
async function runPerformanceClass() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return null;
  const device = await requestEngineDevice(adapter);
  const errors: string[] = [];
  device.addEventListener("uncapturederror", (event) => {
    errors.push((event as GPUUncapturedErrorEvent).error.message);
  });
  const performanceClass = await benchmarkPerformanceClass(device);
  await device.queue.onSubmittedWorkDone();
  device.destroy();
  return { performanceClass, errors };
}

window.runPerformanceClass = runPerformanceClass;
