import type { ResampleRunner, Surface } from "@openpaint/document";
import type { EffectSource } from "@openpaint/effects";
import { surfaceToDataUrl } from "../tabs/thumbnail-url";
import { cpuOffloader } from "../workers/cpu-offloader";

/** The longer side of the source thumbnail under a pan control, in pixels (FX-A-00-02e). */
export const SOURCE_THUMBNAIL_SIZE = 256;

/** The size of a thumbnail whose longer side is at most `longest`, keeping the aspect ratio. */
export function sourceThumbnailSize(
  width: number,
  height: number,
  longest: number = SOURCE_THUMBNAIL_SIZE,
): { readonly width: number; readonly height: number } {
  const scale = Math.min(1, longest / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The default resample runs in the CPU worker, so a large layer does not stall the dialog (PRD-NF-02). */
const resampleInWorker: ResampleRunner = (source, width, height, options) =>
  cpuOffloader().resample(source, width, height, options);

/**
 * The source pixels of an effect, scaled to a thumbnail, as a PNG data URL. The source is the
 * selection bounds (or the whole layer), so the thumbnail is clipped to them (FX-A-00-02e).
 */
export async function sourceThumbnailUrl(
  source: EffectSource | undefined,
  resample: ResampleRunner = resampleInWorker,
): Promise<string | undefined> {
  if (source === undefined) return undefined;
  return surfaceThumbnailUrl(source.pixels, resample);
}

/**
 * The whole layer, scaled to a thumbnail, as a PNG data URL. It is the pan underlay of the effects
 * that center on the document (FX-A-00-02e). Undefined when the effect did not capture the layer.
 */
export async function layerThumbnailUrl(
  source: EffectSource | undefined,
  resample: ResampleRunner = resampleInWorker,
): Promise<string | undefined> {
  if (source?.layer === undefined) return undefined;
  return surfaceThumbnailUrl(source.layer, resample);
}

async function surfaceThumbnailUrl(
  pixels: Surface,
  resample: ResampleRunner,
): Promise<string | undefined> {
  const { width, height } = sourceThumbnailSize(pixels.width, pixels.height);
  const thumbnail = await resample(pixels, width, height, {
    filter: "bilinear",
    linearLight: false,
  });
  return surfaceToDataUrl(thumbnail);
}
