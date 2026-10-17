import initWasm, { type InitInput } from "@openpaint/cpu";
import { wasmThreadCount } from "./threading";

export {
  BrushSettings,
  box_halve_rgba8 as boxHalveRgba8,
  brush_cover_dabs as brushCoverDabs,
  brush_dabs as brushDabs,
  brush_stamp_dabs_rgba8 as brushStampDabsRgba8,
  brush_stroke_rgba8 as brushStrokeRgba8,
  brush_tip_sprite as brushTipSprite,
  bucket_fill_rgba8 as bucketFillRgba8,
  clone_stamp_dabs_rgba8 as cloneStampDabsRgba8,
  clone_stroke_rgba8 as cloneStrokeRgba8,
  composite_rgba8 as compositeRgba8,
  DabPlanner,
  GradientSettings,
  gradient_rgba8 as gradientRgba8,
  lanczos3_axis_taps as lanczos3AxisTaps,
  pencil_cells_rgba8 as pencilCellsRgba8,
  pencil_stroke_rgba8 as pencilStrokeRgba8,
  premultiply_rgba8 as premultiplyRgba8,
  RecolorSettings,
  recolor_cover_rgba8 as recolorCoverRgba8,
  recolor_rgba8 as recolorRgba8,
  resample_lanczos3_rgba8 as resampleLanczos3Rgba8,
} from "@openpaint/cpu";

export interface CpuInfo {
  /** Threads the CPU kernels may use: 1 unless the page is cross-origin isolated. */
  threads: number;
}

/**
 * Instantiates the Rust/WASM CPU kernels. Without `source` the module is fetched next to the
 * bundled JS glue; Node callers pass the `.wasm` bytes instead.
 */
export async function initCpu(source?: InitInput): Promise<CpuInfo> {
  await initWasm(source === undefined ? undefined : { module_or_path: source });
  return { threads: wasmThreadCount() };
}
