import { rgba8, type Size, TiledPixelStore } from "@openpaint/document";
import { createRenderCanvas } from "./canvas";
import type { CompositeDocument } from "./composite";
import { DisplayTileBuilder, DisplayTileCache } from "./display-tiles";
import { DEFAULT_CANVAS_THEME, type FramePlan, planFrame } from "./frame";
import { CpuPresenter, GpuPresenter, type Presenter } from "./presenter";
import type { CheckResult } from "./v2/gpu-checks";
import { FIT_VIEW } from "./view";

/** The image of the check: an odd size, so every mip level ends in a partly covered pixel. */
const IMAGE: Size = { width: 301, height: 203 };
const COLOR = [200, 30, 60] as const;

/** Viewports that fit the image at several zooms below 100 %, where tiles are filtered. */
const VIEWPORTS: readonly Size[] = [
  { width: 157, height: 113 },
  { width: 233, height: 171 },
  { width: 97, height: 61 },
];

/** Builds every tile a frame wants, drafts and then finals, and plans the frame again. */
function settledPlan(
  cache: DisplayTileCache,
  builder: DisplayTileBuilder,
  viewport: Size,
): FramePlan {
  const plan = () =>
    planFrame({
      view: FIT_VIEW,
      doc: IMAGE,
      viewport,
      scale: 1,
      theme: { ...DEFAULT_CANVAS_THEME, shadow: { color: [0, 0, 0], alpha: 0 } },
      lookup: (level, tx, ty) => cache.get(level, tx, ty),
    });
  const first = plan();
  builder.request(first.wanted);
  builder.pump(Number.POSITIVE_INFINITY, () => 0);
  const drafted = plan();
  builder.request(
    [],
    drafted.tiles.map(({ tile }) => tile),
  );
  builder.pump(Number.POSITIVE_INFINITY, () => 0);
  return plan();
}

/** Presents `plan` and reads back the pixels the visible canvas received. */
async function presented(
  make: (output: ImageBitmapRenderingContext) => Presenter,
  plan: FramePlan,
) {
  let shown: ImageBitmap | undefined;
  const output = {
    canvas: createRenderCanvas(1, 1),
    transferFromImageBitmap: (bitmap: ImageBitmap | null) => {
      shown = bitmap ?? undefined;
    },
  } as unknown as ImageBitmapRenderingContext;
  const presenter = make(output);
  presenter.resize(plan.width, plan.height);
  await presenter.present(plan);
  // The HTML canvas fallback hands the bitmap over a task later.
  for (let i = 0; i < 10 && shown === undefined; i++) await new Promise((r) => setTimeout(r, 0));
  if (shown === undefined) throw new Error("The presenter showed nothing.");
  const canvas = createRenderCanvas(plan.width, plan.height);
  const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
  if (!context) throw new Error("Canvas 2D is unavailable.");
  context.drawImage(shown, 0, 0);
  return context.getImageData(0, 0, plan.width, plan.height).data;
}

/**
 * Presents an opaque, odd-sized image fitted at several zooms below 100 % and compares every
 * device pixel of its canvas rectangle with the image's color (UI-VIEW-02). A seam of
 * checkerboard at the image's edge, from rounding or from filtering transparency in, shows as a
 * large difference. `device` selects the WebGPU presenter, and undefined the Canvas 2D one.
 */
export async function checkPresentedEdges(device?: GPUDevice): Promise<CheckResult> {
  const store = new TiledPixelStore(IMAGE.width, IMAGE.height);
  store.fill(rgba8(COLOR[0], COLOR[1], COLOR[2], 255));
  const doc: CompositeDocument = {
    width: IMAGE.width,
    height: IMAGE.height,
    layers: [{ store, mode: 0, opacity: 255, visible: true }],
  };
  const format = device ? navigator.gpu.getPreferredCanvasFormat() : undefined;
  const make = (output: ImageBitmapRenderingContext): Presenter =>
    device && format ? new GpuPresenter(output, device, format) : new CpuPresenter(output);
  let maxDifference = 0;
  let differingChannels = 0;
  try {
    for (const viewport of VIEWPORTS) {
      const cache = new DisplayTileCache();
      const plan = settledPlan(cache, new DisplayTileBuilder(cache, () => doc), viewport);
      const pixels = await presented(make, plan);
      const { canvas } = plan;
      for (let y = canvas.y; y < canvas.y + canvas.height; y++) {
        for (let x = canvas.x; x < canvas.x + canvas.width; x++) {
          const i = (y * plan.width + x) * 4;
          for (let c = 0; c < 3; c++) {
            const difference = Math.abs((pixels[i + c] ?? 0) - (COLOR[c] ?? 0));
            if (difference > 0) differingChannels += 1;
            maxDifference = Math.max(maxDifference, difference);
          }
        }
      }
    }
  } finally {
    store.dispose();
  }
  return { maxDifference, differingChannels };
}
