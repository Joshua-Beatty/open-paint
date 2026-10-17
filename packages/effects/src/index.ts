import type { EffectRegistry } from "@openpaint/extension-api";
import { addNoiseBinding } from "./add-noise";
import {
  blackAndWhiteBinding,
  invertAlphaBinding,
  invertColorsBinding,
  sepiaBinding,
} from "./adjustments";
import { alignObjectBinding } from "./align-object";
import { autoLevelBinding } from "./auto-level";
import { bokehBlurBinding } from "./bokeh-blur";
import { brightnessContrastBinding } from "./brightness-contrast";
import { bulgeBinding } from "./bulge";
import { cloudsBinding } from "./clouds";
import { crystalizeBinding } from "./crystalize";
import { curvesBinding } from "./curves";
import { dentsBinding } from "./dents";
import { dropShadowBinding } from "./drop-shadow";
import { edgeDetectBinding } from "./edge-detect";
import { embossBinding } from "./emboss";
import { exposureBinding } from "./exposure";
import { flipHorizontalBinding, flipVerticalBinding } from "./flip-object";
import { fragmentBlurBinding } from "./fragment-blur";
import type { EffectBinding } from "./framework/binding";
import { frostedGlassBinding } from "./frosted-glass";
import { gaussianBlurBinding } from "./gaussian-blur";
import { glowBinding } from "./glow";
import { highlightsShadowsBinding } from "./highlights-shadows";
import { hueSaturationBinding } from "./hue-saturation";
import { inkSketchBinding } from "./ink-sketch";
import { juliaBinding } from "./julia";
import { levelsBinding } from "./levels";
import { mandelbrotBinding } from "./mandelbrot";
import { medianBlurBinding } from "./median-blur";
import { morphologyBinding } from "./morphology";
import { motionBlurBinding } from "./motion-blur";
import { oilPaintingBinding } from "./oil-painting";
import { outlineBinding } from "./outline";
import { pencilSketchBinding } from "./pencil-sketch";
import { pixelateBinding } from "./pixelate";
import { polarInversionBinding } from "./polar";
import { posterizeBinding } from "./posterize";
import { quantizeBinding } from "./quantize";
import { radialBlurBinding } from "./radial-blur";
import { redEyeBinding } from "./red-eye";
import { reduceNoiseBinding } from "./reduce-noise";
import { reliefBinding } from "./relief";
import { rotateZoomBinding } from "./rotate-zoom";
import { sharpenBinding } from "./sharpen";
import { sketchBlurBinding } from "./sketch-blur";
import { softenPortraitBinding } from "./soften-portrait";
import { squareBlurBinding } from "./square-blur";
import { straightenBinding } from "./straighten";
import { surfaceBlurBinding } from "./surface-blur";
import { temperatureTintBinding } from "./temperature-tint";
import { tileReflectionBinding } from "./tile";
import { turbulenceBinding } from "./turbulence";
import { twistBinding } from "./twist";
import { vignetteBinding } from "./vignette";
import { zoomBlurBinding } from "./zoom-blur";

export {
  ADD_NOISE_ID,
  type AddNoiseParams,
  addNoiseBinding,
  addNoiseCpu,
  addNoiseDescriptor,
  addNoiseParams,
  addNoiseSchema,
  addNoiseTable,
} from "./add-noise";
export { ADD_NOISE_PARAMS_BYTES, ADD_NOISE_WGSL } from "./add-noise-wgsl";
export {
  ADJUSTMENT_IDS,
  ADJUSTMENT_OPS,
  type AdjustmentId,
  type AdjustmentPlan,
  adjustmentCpu,
  BLUR_WEIGHTS,
  blackAndWhiteBinding,
  blackAndWhiteCpu,
  blackAndWhiteDescriptor,
  CURVE_LUT_SIZE,
  CURVE_TABLES,
  identityPlan,
  invertAlphaBinding,
  invertAlphaCpu,
  invertAlphaDescriptor,
  invertColorsBinding,
  invertColorsCpu,
  invertColorsDescriptor,
  type NoParams,
  planAdjustment,
  SEPIA_DEFAULT_INTENSITY,
  type SepiaParams,
  sepiaBinding,
  sepiaCpu,
  sepiaDescriptor,
  sepiaParams,
  sepiaSchema,
} from "./adjustments";
export { ADJUST_PIXEL_WGSL, ADJUSTMENTS_WGSL } from "./adjustments-wgsl";
export {
  ALIGN_OBJECT_ID,
  ALIGN_POSITION_ORDER,
  ALIGN_POSITIONS,
  type AlignObjectAnalysis,
  type AlignObjectParams,
  type AlignObjectPlan,
  type AlignPosition,
  alignObjectBinding,
  alignObjectCpu,
  alignObjectDescriptor,
  alignObjectIsNoop,
  alignObjectNotice,
  alignObjectParams,
  alignObjectSchema,
  alignPositionCode,
  analyzeAlignObject,
  type ObjectBox,
  planAlignObject,
} from "./align-object";
export { ALIGN_OBJECT_PARAMS_BYTES, ALIGN_OBJECT_WGSL } from "./align-object-wgsl";
export {
  type ApplyToRegionOptions,
  applyToRegion,
  clipToCoverage,
  clipToCoverageArea,
} from "./apply";
export { ARTISTIC_PARAMS_BYTES } from "./artistic-wgsl-common";
export {
  AUTO_LEVEL_ID,
  AUTO_LEVEL_OP,
  autoLevelBinding,
  autoLevelCpu,
  autoLevelDescriptor,
  autoLevelPlan,
} from "./auto-level";
export {
  BOKEH_BLUR_ID,
  BOKEH_MIN_RADIUS,
  type BokehBlurParams,
  type BokehBlurPlan,
  bokehBlurBinding,
  bokehBlurCpu,
  bokehBlurDescriptor,
  bokehBlurParams,
  bokehBlurSchema,
  planBokehBlur,
} from "./bokeh-blur";
export { BOKEH_BLUR_PARAMS_BYTES, BOKEH_BLUR_WGSL } from "./bokeh-blur-wgsl";
export {
  BRIGHTNESS_CONTRAST_ID,
  BRIGHTNESS_CONTRAST_OP,
  type BrightnessContrastParams,
  brightnessContrastBinding,
  brightnessContrastCpu,
  brightnessContrastDescriptor,
  brightnessContrastParams,
  brightnessContrastPlan,
  brightnessContrastSchema,
} from "./brightness-contrast";
export {
  BULGE_DEFAULT_STRENGTH,
  BULGE_ID,
  type BulgeParams,
  bulgeBinding,
  bulgeCpu,
  bulgeDescriptor,
  bulgeParams,
  bulgePlan,
  bulgeSchema,
} from "./bulge";
export {
  CLOUDS_ID,
  type CloudsParams,
  cloudsBinding,
  cloudsCpu,
  cloudsDescriptor,
  cloudsFrame,
  cloudsParams,
  cloudsPermutation,
  cloudsPlan,
  cloudsSchema,
} from "./clouds";
export { CLOUDS_PARAMS_BYTES, CLOUDS_WGSL } from "./clouds-wgsl";
export {
  CRYSTALIZE_ID,
  CRYSTALIZE_MAX_QUALITY,
  type CrystalizeParams,
  crystalizeBinding,
  crystalizeCpu,
  crystalizeDescriptor,
  crystalizeParams,
  crystalizePlan,
  crystalizeSchema,
} from "./crystalize";
export {
  CURVE_IDENTITY,
  CURVES_DIALOG_ID,
  CURVES_ID,
  CURVES_LUMINOSITY_OP,
  CURVES_RGB_OP,
  type CurveList,
  type CurveMode,
  type CurvePoint,
  type CurvesParams,
  curveLut,
  curvesBinding,
  curvesCpu,
  curvesDescriptor,
  curvesParams,
  curvesPlan,
  curvesSchema,
  curvesTables,
  curvesValues,
  curveValueAt,
  decodeCurve,
  encodeCurve,
} from "./curves";
export {
  DENTS_ID,
  type DentsParams,
  dentsBinding,
  dentsCpu,
  dentsDescriptor,
  dentsParams,
  dentsPlan,
  dentsSchema,
} from "./dents";
export {
  DISTORTION_MAX_QUALITY,
  distortAffineCpu,
  distortedSurface,
  distortionQualityProperty,
  documentCenter,
  EDGE_BEHAVIORS,
  type EdgeBehavior,
  edgeBehaviorCode,
  edgeBehaviorOf,
  edgeBehaviorProperty,
  planDistortionOffsets,
  SOURCE_UNDERLAY_KEY,
  surfaceBytes,
  vector2Value,
} from "./distortion";
export {
  AFFINE_SAMPLE_MAP_WGSL,
  BULGE_SAMPLE_MAP_WGSL,
  crystalizeSampleMapWgsl,
  DISTORTION_MAP_FLOATS,
  DISTORTION_PARAMS_BYTES,
  dentsSampleMapWgsl,
  distortionWgsl,
  POLAR_SAMPLE_MAP_WGSL,
  permutationTablesWgsl,
  TILE_SAMPLE_MAP_WGSL,
  TWIST_SAMPLE_MAP_WGSL,
} from "./distortion-wgsl";
export {
  DROP_SHADOW_ID,
  type DropShadowParams,
  type DropShadowPlan,
  dropShadowBinding,
  dropShadowCpu,
  dropShadowDescriptor,
  dropShadowParams,
  dropShadowSchema,
  planDropShadow,
} from "./drop-shadow";
export { DROP_SHADOW_PARAMS_BYTES, DROP_SHADOW_WGSL } from "./drop-shadow-wgsl";
export {
  EDGE_DETECT_ALGORITHMS,
  EDGE_DETECT_ID,
  type EdgeDetectAlgorithm,
  type EdgeDetectParams,
  type EdgeDetectPlan,
  edgeDetectBinding,
  edgeDetectCpu,
  edgeDetectDescriptor,
  edgeDetectParams,
  edgeDetectSchema,
  planEdgeDetect,
} from "./edge-detect";
export { EDGE_DETECT_WGSL } from "./edge-detect-wgsl";
export {
  EMBOSS_ID,
  type EmbossParams,
  type EmbossPlan,
  embossBinding,
  embossCpu,
  embossDescriptor,
  embossParams,
  embossSchema,
  planEmboss,
} from "./emboss";
export { EMBOSS_PARAMS_BYTES, EMBOSS_WGSL } from "./emboss-wgsl";
export {
  EXPOSURE_ID,
  EXPOSURE_OP,
  type ExposureParams,
  exposureBinding,
  exposureCpu,
  exposureDescriptor,
  exposureParams,
  exposurePlan,
  exposureSchema,
} from "./exposure";
export {
  FLIP_HORIZONTAL_ID,
  FLIP_VERTICAL_ID,
  type FlipObjectParams,
  flipHorizontalBinding,
  flipHorizontalDescriptor,
  flipMatrix,
  flipObjectCpu,
  flipSelection,
  flipVerticalBinding,
  flipVerticalDescriptor,
} from "./flip-object";
export { FLIP_OBJECT_PARAMS_BYTES, FLIP_OBJECT_WGSL } from "./flip-object-wgsl";
export {
  FRACTAL_MIN_ZOOM,
  type FractalParams,
  fractalFrame,
  fractalPlan,
} from "./fractal";
export { FRACTAL_PARAMS_BYTES, FRACTAL_WGSL } from "./fractal-wgsl";
export {
  FRAGMENT_BLUR_ID,
  type FragmentBlurParams,
  fragmentBlurBinding,
  fragmentBlurCpu,
  fragmentBlurDescriptor,
  fragmentBlurOffsets,
  fragmentBlurParams,
  fragmentBlurSchema,
} from "./fragment-blur";
export { FRAGMENT_BLUR_PARAMS_BYTES, FRAGMENT_BLUR_WGSL } from "./fragment-blur-wgsl";
export {
  type EffectBinding,
  type EffectColors,
  type EffectDocumentSize,
  type EffectRegionOrigin,
  LAYER_UNDERLAY_KEY,
} from "./framework/binding";
export {
  type CpuJob,
  type CpuOffloader,
  type CpuPixels,
  type CpuReply,
  type CpuWorkerLike,
  type FloatCpuJob,
  ownedPixels,
  runCpuJob,
  runCpuJobOutputs,
  WorkerCpuOffloader,
  type WorkerCpuOffloaderOptions,
} from "./framework/cpu-offload";
export { EffectError, type EffectFailure } from "./framework/errors";
export type { GpuOffloader } from "./framework/gpu-offload";
export {
  EffectMemory,
  type EffectValueStore,
  type LastEffect,
} from "./framework/memory";
export type { RenderBackend } from "./framework/render";
export {
  EffectSession,
  type EffectSessionOptions,
  type EffectSource,
  type SessionPhase,
} from "./framework/session";
export {
  FROST_SAMPLE_COUNTS,
  FROSTED_GLASS_ID,
  type FrostedGlassParams,
  frostedGlassBinding,
  frostedGlassCpu,
  frostedGlassDescriptor,
  frostedGlassParams,
  frostedGlassPlan,
  frostedGlassSchema,
  frostedGlassSeeds,
} from "./frosted-glass";
export { FROSTED_GLASS_PARAMS_BYTES, FROSTED_GLASS_WGSL } from "./frosted-glass-wgsl";
export {
  GAUSSIAN_BLUR_ID,
  type GaussianBlurParams,
  type GaussianBlurPlan,
  type GaussianBorder,
  gaussianBlurBinding,
  gaussianBlurCpu,
  gaussianBlurDescriptor,
  gaussianBlurParams,
  gaussianBlurSchema,
  planGaussianBlur,
} from "./gaussian-blur";
export { GAUSSIAN_BLUR_WGSL } from "./gaussian-blur-wgsl";
export {
  GLOW_ID,
  GLOW_QUALITY,
  GLOW_RADIUS_FACTOR,
  type GlowParams,
  type GlowPlan,
  glowBinding,
  glowCpu,
  glowDescriptor,
  glowParams,
  glowSchema,
  planGlow,
} from "./glow";
export { GLOW_WGSL } from "./glow-wgsl";
export {
  HIGHLIGHTS_SHADOWS_DEFAULT_RADIUS,
  HIGHLIGHTS_SHADOWS_ID,
  HIGHLIGHTS_SHADOWS_OP,
  type HighlightsShadowsParams,
  highlightsShadowsBinding,
  highlightsShadowsCpu,
  highlightsShadowsDescriptor,
  highlightsShadowsParams,
  highlightsShadowsPlan,
  highlightsShadowsSchema,
} from "./highlights-shadows";
export {
  HUE_SATURATION_ID,
  HUE_SATURATION_OP,
  type HueSaturationParams,
  hueSaturationBinding,
  hueSaturationCpu,
  hueSaturationDescriptor,
  hueSaturationParams,
  hueSaturationPlan,
  hueSaturationSchema,
} from "./hue-saturation";
export {
  INK_SKETCH_ID,
  type InkSketchParams,
  type InkSketchPlan,
  inkSketchBinding,
  inkSketchCpu,
  inkSketchDescriptor,
  inkSketchParams,
  inkSketchSchema,
  planInkSketch,
} from "./ink-sketch";
export { INK_SKETCH_WGSL } from "./ink-sketch-wgsl";
export {
  JULIA_ID,
  type JuliaParams,
  juliaBinding,
  juliaCpu,
  juliaDescriptor,
  juliaParams,
  juliaSchema,
} from "./julia";
export {
  autoLevelParams,
  type ChannelTriple,
  LEVELS_DIALOG_ID,
  LEVELS_GAMMA_MAX,
  LEVELS_GAMMA_MIN,
  LEVELS_ID,
  LEVELS_IDENTITY,
  LEVELS_OP,
  type LevelsParams,
  levelsBinding,
  levelsCpu,
  levelsDescriptor,
  levelsGroups,
  levelsHistogram,
  levelsLut,
  levelsParams,
  levelsPlan,
  levelsPlanValues,
  levelsSchema,
  levelsValues,
  toVector,
} from "./levels";
export {
  MANDELBROT_ID,
  type MandelbrotParams,
  mandelbrotBinding,
  mandelbrotCpu,
  mandelbrotDescriptor,
  mandelbrotParams,
  mandelbrotPlan,
  mandelbrotSchema,
} from "./mandelbrot";
export {
  MEDIAN_BLUR_ID,
  type MedianBlurParams,
  medianBlurBinding,
  medianBlurCpu,
  medianBlurDescriptor,
  medianBlurParams,
  medianBlurSchema,
} from "./median-blur";
export { MEDIAN_BLUR_PARAMS_BYTES, MEDIAN_BLUR_WGSL } from "./median-blur-wgsl";
export {
  MIX_MODE_COUNT,
  MIX_MODE_KEYS,
  MIX_MODE_OVER,
  MIX_MODE_OVERWRITE,
  type MixModeKey,
  mixModeOptions,
  mixModeProperty,
} from "./mix-modes";
export { MIX_WGSL } from "./mix-wgsl";
export {
  MORPHOLOGY_ID,
  MORPHOLOGY_MODES,
  type MorphologyMode,
  type MorphologyParams,
  morphologyBinding,
  morphologyCode,
  morphologyCpu,
  morphologyDescriptor,
  morphologyParams,
  morphologySchema,
} from "./morphology";
export { MORPHOLOGY_PARAMS_BYTES, MORPHOLOGY_WGSL } from "./morphology-wgsl";
export {
  MOTION_BLUR_ID,
  type MotionBlurParams,
  motionBlurBinding,
  motionBlurCpu,
  motionBlurDescriptor,
  motionBlurParams,
  motionBlurPlan,
  motionBlurSchema,
} from "./motion-blur";
export { MOTION_BLUR_PARAMS_BYTES, MOTION_BLUR_WGSL } from "./motion-blur-wgsl";
export {
  OIL_KERNEL_SHAPES,
  OIL_PAINTING_ID,
  type OilKernelShape,
  type OilPaintingParams,
  type OilPaintingPlan,
  oilPaintingBinding,
  oilPaintingCpu,
  oilPaintingDescriptor,
  oilPaintingParams,
  oilPaintingSchema,
  planOilPainting,
} from "./oil-painting";
export { OIL_PAINTING_WGSL } from "./oil-painting-wgsl";
export {
  OUTLINE_ID,
  type OutlineParams,
  type OutlinePlan,
  outlineBinding,
  outlineCpu,
  outlineDescriptor,
  outlineParams,
  outlineSchema,
  planOutline,
} from "./outline";
export { OUTLINE_PARAMS_BYTES, OUTLINE_WGSL } from "./outline-wgsl";
export {
  PENCIL_SKETCH_ID,
  type PencilSketchParams,
  type PencilSketchPlan,
  pencilSketchBinding,
  pencilSketchCpu,
  pencilSketchDescriptor,
  pencilSketchParams,
  pencilSketchSchema,
  planPencilSketch,
} from "./pencil-sketch";
export { PENCIL_SKETCH_WGSL } from "./pencil-sketch-wgsl";
export { type PixelAdjustment, pixelAdjustment } from "./pixel-adjustments";
export {
  PIXELATE_ID,
  type PixelateParams,
  pixelateBinding,
  pixelateCodes,
  pixelateCpu,
  pixelateDescriptor,
  pixelateGrid,
  pixelateParams,
  pixelatePlan,
  pixelateSchema,
  SCALE_DOWN_MODES,
  SCALE_UP_MODES,
  type ScaleDownMode,
  type ScaleUpMode,
} from "./pixelate";
export { PIXELATE_PARAMS_BYTES, PIXELATE_WGSL } from "./pixelate-wgsl";
export {
  POLAR_INVERSION_ID,
  type PolarInversionParams,
  polarInversionBinding,
  polarInversionCpu,
  polarInversionDescriptor,
  polarInversionParams,
  polarInversionPlan,
  polarInversionSchema,
} from "./polar";
export {
  POSTERIZE_DEFAULT_LEVELS,
  POSTERIZE_ID,
  POSTERIZE_OP,
  type PosterizeParams,
  posterizeBinding,
  posterizeCpu,
  posterizeDescriptor,
  posterizeParams,
  posterizePlan,
  posterizeSchema,
} from "./posterize";
export {
  QUANTIZE_ID,
  type QuantizeParams,
  quantizeBinding,
  quantizeCpu,
  quantizeDescriptor,
  quantizeParams,
  quantizeSchema,
} from "./quantize";
export {
  RADIAL_BLUR_ID,
  type RadialBlurParams,
  radialBlurBinding,
  radialBlurCpu,
  radialBlurDescriptor,
  radialBlurParams,
  radialBlurPlan,
  radialBlurSchema,
} from "./radial-blur";
export { RADIAL_BLUR_PARAMS_BYTES, RADIAL_BLUR_WGSL } from "./radial-blur-wgsl";
export {
  RED_EYE_ID,
  type RedEyeParams,
  redEyeBinding,
  redEyeCpu,
  redEyeDescriptor,
  redEyeParams,
  redEyeSchema,
} from "./red-eye";
export { RED_EYE_PARAMS_BYTES, RED_EYE_WGSL } from "./red-eye-wgsl";
export {
  REDUCE_NOISE_ID,
  type ReduceNoiseParams,
  reduceNoiseBinding,
  reduceNoiseCpu,
  reduceNoiseDescriptor,
  reduceNoiseParams,
  reduceNoiseSchema,
} from "./reduce-noise";
export { REDUCE_NOISE_PARAMS_BYTES, REDUCE_NOISE_WGSL } from "./reduce-noise-wgsl";
export {
  planRelief,
  RELIEF_ID,
  type ReliefParams,
  type ReliefPlan,
  reliefBinding,
  reliefCpu,
  reliefDescriptor,
  reliefParams,
  reliefSchema,
} from "./relief";
export { RELIEF_PARAMS_BYTES, RELIEF_WGSL } from "./relief-wgsl";
export {
  addNoiseSeed,
  createInstanceSeed,
  crystalizeSeed,
  dentsSeed,
  frostMapRandoms,
  frostSeed,
  noiseCpu,
  renderSeed,
  SEED_MAX,
  seedProperty,
} from "./rng";
export { PIXEL_NOISE_WGSL, PIXEL_RNG_WGSL } from "./rng-wgsl";
export {
  planRotateZoom,
  ROTATE_ZOOM_ID,
  ROTATE_ZOOM_SAMPLING,
  ROTATE_ZOOM_TILING,
  type RotateZoomParams,
  type RotateZoomSampling,
  type RotateZoomTiling,
  rotateZoomBinding,
  rotateZoomCpu,
  rotateZoomDescriptor,
  rotateZoomParams,
  rotateZoomSamplingCode,
  rotateZoomSchema,
  rotateZoomTilingCode,
} from "./rotate-zoom";
export {
  ROTATE_ZOOM_PARAMS_BYTES,
  ROTATE_ZOOM_PLAN_OFFSET,
  ROTATE_ZOOM_WGSL,
} from "./rotate-zoom-wgsl";
export {
  SHARPEN_ID,
  type SharpenParams,
  sharpenBinding,
  sharpenCpu,
  sharpenDescriptor,
  sharpenParams,
  sharpenSchema,
} from "./sharpen";
export { SHARPEN_WGSL } from "./sharpen-wgsl";
export {
  SKETCH_BLUR_ID,
  type SketchBlurParams,
  type SketchBlurPlan,
  sketchBlurBinding,
  sketchBlurCpu,
  sketchBlurDescriptor,
  sketchBlurParams,
  sketchBlurPlan,
  sketchBlurSchema,
} from "./sketch-blur";
export { SKETCH_BLUR_PARAMS_BYTES, SKETCH_BLUR_WGSL } from "./sketch-blur-wgsl";
export {
  planSoftenPortrait,
  SOFTEN_PORTRAIT_ID,
  type SoftenPortraitParams,
  type SoftenPortraitPlan,
  softenPortraitBinding,
  softenPortraitCpu,
  softenPortraitDescriptor,
  softenPortraitParams,
  softenPortraitSchema,
} from "./soften-portrait";
export { SOFTEN_PORTRAIT_WGSL } from "./soften-portrait-wgsl";
export {
  planSquareBlur,
  SQUARE_BLUR_ID,
  type SquareBlurParams,
  squareBlurBinding,
  squareBlurCpu,
  squareBlurDescriptor,
  squareBlurParams,
  squareBlurSchema,
} from "./square-blur";
export {
  planStraighten,
  STRAIGHTEN_ID,
  STRAIGHTEN_SAMPLING,
  type StraightenParams,
  type StraightenPlan,
  type StraightenSampling,
  straightenBinding,
  straightenCpu,
  straightenDescriptor,
  straightenParams,
  straightenSamplingCode,
  straightenSchema,
} from "./straighten";
export {
  STRAIGHTEN_PARAMS_BYTES,
  STRAIGHTEN_WGSL,
} from "./straighten-wgsl";
export {
  SURFACE_BLUR_ID,
  type SurfaceBlurParams,
  surfaceBlurBinding,
  surfaceBlurCpu,
  surfaceBlurDescriptor,
  surfaceBlurParams,
  surfaceBlurSchema,
  surfaceBlurSlope,
} from "./surface-blur";
export { SURFACE_BLUR_PARAMS_BYTES, SURFACE_BLUR_WGSL } from "./surface-blur-wgsl";
export {
  TEMPERATURE_TINT_ID,
  TEMPERATURE_TINT_OP,
  type TemperatureTintParams,
  temperatureTintBinding,
  temperatureTintCpu,
  temperatureTintDescriptor,
  temperatureTintParams,
  temperatureTintPlan,
  temperatureTintSchema,
} from "./temperature-tint";
export {
  TILE_REFLECTION_ID,
  type TileReflectionParams,
  tileReflectionBinding,
  tileReflectionCpu,
  tileReflectionDescriptor,
  tileReflectionParams,
  tileReflectionPlan,
  tileReflectionSchema,
} from "./tile";
export {
  TURBULENCE_ID,
  TURBULENCE_NOISE,
  type TurbulenceNoise,
  type TurbulenceParams,
  turbulenceBinding,
  turbulenceCpu,
  turbulenceDescriptor,
  turbulenceParams,
  turbulencePlan,
  turbulenceSchema,
  turbulenceStitch,
  turbulenceTables,
} from "./turbulence";
export { TURBULENCE_PARAMS_BYTES, TURBULENCE_WGSL } from "./turbulence-wgsl";
export {
  TWIST_ID,
  type TwistParams,
  twistBinding,
  twistCpu,
  twistDescriptor,
  twistParams,
  twistPlan,
  twistSchema,
} from "./twist";
export {
  planVignette,
  VIGNETTE_ID,
  type VignetteParams,
  vignetteBinding,
  vignetteCpu,
  vignetteDescriptor,
  vignetteParams,
  vignetteSchema,
} from "./vignette";
export { VIGNETTE_PARAMS_BYTES, VIGNETTE_WGSL } from "./vignette-wgsl";
export {
  ZOOM_BLUR_ID,
  type ZoomBlurParams,
  zoomBlurBinding,
  zoomBlurCpu,
  zoomBlurDescriptor,
  zoomBlurParams,
  zoomBlurPlan,
  zoomBlurSchema,
} from "./zoom-blur";
export { ZOOM_BLUR_PARAMS_BYTES, ZOOM_BLUR_WGSL } from "./zoom-blur-wgsl";

/**
 * Every built-in effect's binding (EXT-V1). `factoryQualityLevel` is 2 when the GPU class is "Good", otherwise 1.
 * `defaultQuality` is the Default Quality Level setting, which the distortion effects use as their
 * Quality default (FX-A-00-03). It defaults to the factory level.
 * The adjustments come last, so the effects keep their order.
 */
export function builtinEffectBindings(
  factoryQualityLevel: 1 | 2,
  defaultQuality: number = factoryQualityLevel,
): EffectBinding[] {
  return [
    gaussianBlurBinding(factoryQualityLevel),
    invertColorsBinding(),
    invertAlphaBinding(),
    blackAndWhiteBinding(),
    sepiaBinding(),
    autoLevelBinding(),
    brightnessContrastBinding(),
    hueSaturationBinding(),
    posterizeBinding(),
    levelsBinding(),
    curvesBinding(),
    exposureBinding(),
    highlightsShadowsBinding(),
    temperatureTintBinding(),
    bulgeBinding(defaultQuality),
    twistBinding(defaultQuality),
    crystalizeBinding(defaultQuality),
    dentsBinding(defaultQuality),
    frostedGlassBinding(),
    pixelateBinding(),
    polarInversionBinding(defaultQuality),
    tileReflectionBinding(defaultQuality),
    morphologyBinding(),
    fragmentBlurBinding(),
    motionBlurBinding(),
    radialBlurBinding(factoryQualityLevel),
    zoomBlurBinding(factoryQualityLevel),
    medianBlurBinding(),
    surfaceBlurBinding(),
    squareBlurBinding(),
    sketchBlurBinding(),
    bokehBlurBinding(),
    addNoiseBinding(),
    reduceNoiseBinding(),
    inkSketchBinding(),
    oilPaintingBinding(),
    pencilSketchBinding(),
    glowBinding(),
    softenPortraitBinding(),
    sharpenBinding(),
    redEyeBinding(),
    straightenBinding(),
    vignetteBinding(),
    cloudsBinding(),
    turbulenceBinding(),
    juliaBinding(defaultQuality),
    mandelbrotBinding(defaultQuality),
    edgeDetectBinding(),
    embossBinding(),
    reliefBinding(),
    outlineBinding(),
    dropShadowBinding(),
    alignObjectBinding(),
    flipHorizontalBinding(),
    flipVerticalBinding(),
    quantizeBinding(),
    rotateZoomBinding(defaultQuality),
  ];
}

/**
 * Registers every built-in effect's descriptor (EXT-V1). `factoryQualityLevel` is the Default Quality
 * Level factory value for this GPU performance class: 2 when "Good", otherwise 1 (FX-A-00-03).
 */
export function registerBuiltinEffects(
  registry: EffectRegistry,
  factoryQualityLevel: 1 | 2,
  defaultQuality: number = factoryQualityLevel,
): void {
  for (const binding of builtinEffectBindings(factoryQualityLevel, defaultQuality)) {
    registry.register(binding.descriptor);
  }
}
