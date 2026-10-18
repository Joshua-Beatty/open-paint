export {
  type Backend,
  type BackendReason,
  type BackendSetting,
  GraphicsErrorFlags,
  type PerformanceCache,
  type ResolvedBackend,
  resolveBackend,
} from "./backend";
export {
  type BrushOptions,
  type BucketOptions,
  bucketFillCpu,
  cloneStrokeCpu,
  pencilCells,
  type RecolorOptions,
  recolorCover,
  recolorStrokeCpu,
  strokeBrush,
  strokeBrushCpu,
  strokePencilCpu,
} from "./brush";
export {
  connectEngine,
  createEngineWorker,
  DEFAULT_ENGINE_SETTINGS,
  type EngineHandle,
  startEngine,
} from "./client";
export type { CompositeDocument, CompositeLayer } from "./composite";
export { EMPTY_DOCUMENT, LAYER_BLEND_MODE_COUNT } from "./composite";
export { compositeCpu } from "./composite-cpu";
export { type CpuInfo, compositeRgba8, initCpu, premultiplyRgba8 } from "./cpu";
export { DEVICE_LOSS_WINDOW_MS, DeviceLossTracker, MAX_DEVICE_LOSSES } from "./device-loss";
export {
  DISPLAY_TILE_CAPACITY,
  DISPLAY_TILE_SIZE,
  type DisplayTile,
  DisplayTileBuilder,
  DisplayTileCache,
  displayLevels,
  mipLevel,
  type Sampling,
  samplingFor,
} from "./display-tiles";
export {
  DocumentMirror,
  DocumentReplica,
  type DocumentSync,
  type FloatLayer,
  FloatReplica,
  type MirroredDocument,
  type MirroredLayer,
  type ReplicaChange,
  type SyncFloat,
  type SyncPlacement,
} from "./document-sync";
export { Engine, type EngineHost } from "./engine";
export { engineError } from "./engine-host";
export { engineShowsFloat, FloatDisplay, floatStackSupported } from "./float-display";
export {
  type CanvasStyle,
  type CanvasTheme,
  canvasTheme,
  DEFAULT_CANVAS_THEME,
  type FramePlan,
  type FrameStyle,
  planFrame,
  type Rgb,
  type TileDraw,
} from "./frame";
export { GpuAdjustment } from "./gpu-adjustment";
export { GpuInkSketch, GpuOilPainting, GpuPencilSketch } from "./gpu-artistic";
export { GpuBokehBlur } from "./gpu-bokeh-blur";
export { GpuBrush } from "./gpu-brush";
export { type ComposedTile, GpuCompositor } from "./gpu-compositor";
export {
  adapterKey,
  type GpuAdapterSummary,
  KEY_LIMITS,
  requestDevice,
  summarizeAdapter,
} from "./gpu-device";
export { GpuFragmentBlur, GpuMotionBlur } from "./gpu-directional-blur";
export { GpuDistortion, type GpuDistortionParams } from "./gpu-distortion";
export {
  GPU_EFFECT_IDS,
  GPU_SOURCE_MISSING,
  type GpuEffectJob,
  type GpuEffectOutput,
  TRANSFORM_JOB,
} from "./gpu-effect-protocol";
export { GPU_RUNNER_IDS, GpuEffectError, GpuEffectQueue, GpuEffects } from "./gpu-effects";
export { EngineGpuOffloader, type GpuEffectPort } from "./gpu-effects-client";
export { coveredRect, FloatGpu, floatFits } from "./gpu-float";
export { checkFloat, FLOAT_CASES } from "./gpu-float-checks";
export { GpuJulia, GpuMandelbrot } from "./gpu-fractal";
export { GpuFrostedGlass } from "./gpu-frosted-glass";
export { GpuGaussianBlur } from "./gpu-gaussian-blur";
export { GpuMorphology } from "./gpu-morphology";
export {
  GpuMedianBlur,
  GpuSketchBlur,
  GpuSurfaceBlur,
  NEIGHBORHOOD_TILE_PIXELS,
} from "./gpu-neighborhood-blur";
export { GpuAddNoise, GpuReduceNoise } from "./gpu-noise";
export { GpuAlignObject, GpuDropShadow, GpuFlipObject } from "./gpu-object";
export {
  GpuGlow,
  GpuRotateZoom,
  GpuSharpen,
  GpuSoftenPortrait,
  GpuStraighten,
  GpuVignette,
} from "./gpu-photo";
export { GpuPixelNoise } from "./gpu-pixel-noise";
export { GpuPixelate } from "./gpu-pixelate";
export { GpuRadialBlur, GpuZoomBlur } from "./gpu-radial-zoom-blur";
export { GpuClouds, GpuTurbulence } from "./gpu-render";
export { GpuSquareBlur } from "./gpu-square-blur";
export { GpuEdgeDetect, GpuEmboss, GpuOutline, GpuRelief } from "./gpu-stylize";
export { GpuTileCache } from "./gpu-tiles";
export { GpuTransform, type GpuTransformSpec, TRANSFORM_WGSL } from "./gpu-transform";
export {
  GRADIENT_REPEATS,
  GRADIENT_SHAPES,
  type GradientOptions,
  type GradientPoint,
  type GradientRepeat,
  type GradientShape,
  gradientCpu,
} from "./gradient";
export { dabBounds, LiveBrushStroke } from "./live-brush";
export { type EnginePerfReport, PERF_FLUSH_MS, PresentRecorder } from "./perf";
export {
  benchmarkPerformanceClass,
  classifyBenchmark,
  type PerformanceClass,
} from "./performance-class";
export { checkPresentedEdges } from "./present-checks";
export { MAX_PRESENT_FAILURES, PresentFailureTracker } from "./present-failures";
export { CpuPresenter, GpuPresenter, type Presenter } from "./presenter";
export type {
  EngineError,
  EngineInit,
  EngineProtocol,
  EngineSettings,
  EngineSize,
  EngineStatus,
  EngineVersion,
} from "./protocol";
export {
  createRpcClient,
  type RpcClient,
  type RpcEndpoint,
  type RpcHandlers,
  type RpcProtocol,
  type RpcServer,
  serveRpc,
  transfer,
} from "./rpc";
export { createTestDocument } from "./test-document";
export {
  CanvasTextEngine,
  canvasFontOf,
  type TextEngine,
  type TextFace,
  type TextFontMetrics,
  type TextMask,
  type TextRasterLine,
  type TextRasterRequest,
  type TextRenderingMode,
} from "./text-engine";
export { type ThreadingScope, wasmThreadCount } from "./threading";
export {
  COMPOSITE_TILE_SIZE,
  type CompositeDraw,
  type CompositePlan,
  compositeLevel,
  planComposite,
} from "./v2/composite-plan";
export { GpuCompositorV2 } from "./v2/compositor";
export { EngineV2, type EngineV2Host, type StrokeCommit } from "./v2/engine-v2";
export { V1_BRUSH_CASES, V2_COMPOSITE_CASES, V2_STROKE_CASES } from "./v2/gpu-cases";
export {
  type CheckResult,
  checkBrushV1,
  checkCompositeV2,
  checkPartialSyncV2,
  checkStrokeV2,
} from "./v2/gpu-checks";
export { type DocumentChanges, GpuDocument } from "./v2/gpu-document";
export { SlotBuffer } from "./v2/slot-buffer";
export {
  GpuStroke,
  type StrokeBegin,
  type StrokeMask,
  StrokePipelines,
  type StrokeTile,
} from "./v2/stroke";
export { TILE_MIPS } from "./v2/tile-pool";
export {
  applyCommand,
  applyWheel,
  canScroll,
  FIT_VIEW,
  layoutState,
  MAX_ZOOM,
  MIN_ZOOM,
  resolveView,
  type ViewCommand,
  type ViewLayout,
  type ViewState,
  type ViewStatus,
  viewLayout,
  viewStatus,
  WHEEL_ZOOM_FACTOR,
  type WheelInput,
  ZOOM_PRESETS,
} from "./view";
