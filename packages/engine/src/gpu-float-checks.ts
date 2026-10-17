import {
  type AffineMatrix,
  composeAffine,
  ellipsePolygon,
  FloatingSource,
  type FloatPlacement,
  intersectRects,
  rect,
  rectPolygon,
  remainingAfterLift,
  rotationAboutAffine,
  Selection,
  type SelectionPolygon,
  type SelectionQuality,
  Surface,
  scalingAboutAffine,
  type TransformOptions,
  type TransformSampling,
  transformPolygon,
  translationAffine,
} from "@openpaint/document";
import { type FloatLayer, syncPlacement } from "./document-sync";
import { FloatGpu } from "./gpu-float";
import type { CheckResult } from "./v2/gpu-checks";

/** The image of every case: wider than one 256 px region column, so the region runs past it. */
const DOC = { width: 300, height: 200 };
/** The float's region: the image grown to 256 px multiples. */
const REGION = rect(0, 0, 512, 256);

type ShapeKind = "all" | "ellipse" | "lasso";
type MoveKind = "rotate" | "shrink" | "grow" | "shift" | "nudge" | "stamp";

interface FloatCase {
  readonly id: string;
  readonly shape: ShapeKind;
  readonly move: MoveKind;
  readonly sampling: TransformSampling;
  readonly linearLight: boolean;
}

const SAMPLINGS: readonly TransformSampling[] = [
  "nearest",
  "linear",
  "multisample",
  "anisotropic",
  "cubic",
];

/** Floating preview cases: every sampling on a rotated Select All, and each shape and move. */
export const FLOAT_CASES: readonly FloatCase[] = [
  ...SAMPLINGS.flatMap((sampling) =>
    [true, false].map((linearLight) => ({
      id: `all-rotate-${sampling}-${linearLight ? "linear" : "companded"}`,
      shape: "all" as const,
      move: "rotate" as const,
      sampling,
      linearLight,
    })),
  ),
  ...(["ellipse", "lasso"] as const).flatMap((shape) =>
    (["rotate", "shrink", "grow", "shift", "nudge", "stamp"] as const).map((move) => ({
      id: `${shape}-${move}`,
      shape,
      move,
      sampling: "cubic" as const,
      linearLight: true,
    })),
  ),
  { id: "all-grow-cubic", shape: "all", move: "grow", sampling: "cubic", linearLight: true },
  { id: "all-stamp-linear", shape: "all", move: "stamp", sampling: "linear", linearLight: false },
];

function pattern(width: number, height: number): Surface {
  const surface = new Surface(width, height);
  const data = surface.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7 + y * 3) % 256;
      data[i + 1] = (x * 13 + 40) % 256;
      data[i + 2] = (y * 11 + x) % 256;
      data[i + 3] = (x + y) % 5 === 0 ? 0 : 128 + ((x * y) % 128);
    }
  }
  return surface;
}

function selectionOf(kind: ShapeKind): { polygons: SelectionPolygon[]; quality: SelectionQuality } {
  if (kind === "ellipse") {
    return { polygons: [ellipsePolygon(rect(60.5, 40.25, 150, 110))], quality: "antialiased" };
  }
  if (kind === "lasso") {
    // A concave ring: more crossings than a convex one on some rows.
    const ring = [50, 30, 230, 45.5, 140, 90, 220, 160, 60.25, 150, 100, 95];
    return { polygons: [ring], quality: "aliased" };
  }
  return { polygons: [rectPolygon(rect(0, 0, DOC.width, DOC.height))], quality: "antialiased" };
}

/** The transforms of a case, content to canvas: the stamps first, then the placement. */
function movesOf(kind: MoveKind, origin: { x: number; y: number }): AffineMatrix[] {
  const at = translationAffine(origin.x, origin.y);
  const about = (m: AffineMatrix) => composeAffine(m, at);
  // Off the pixel grid, so no Nearest Neighbor sample lands on a pixel edge, where f32 and f64
  // can pick different neighbors (the documented limit of the WGSL twin).
  const center = { x: 150.37, y: 100.21 };
  switch (kind) {
    case "rotate":
      return [about(rotationAboutAffine(center.x, center.y, 0.3))];
    case "shrink":
      return [
        about(
          composeAffine(
            rotationAboutAffine(center.x, center.y, -0.4),
            scalingAboutAffine(center.x, center.y, 0.6, 0.55),
          ),
        ),
      ];
    case "grow":
      return [about(scalingAboutAffine(center.x, center.y, 1.7, 1.45))];
    case "shift":
      return [about(translationAffine(13, -7))];
    case "nudge":
      return [about(translationAffine(13.37, 6.5))];
    case "stamp":
      return [
        about(rotationAboutAffine(center.x, center.y, 0.3)),
        about(
          composeAffine(translationAffine(40, 20), rotationAboutAffine(center.x, center.y, 0.3)),
        ),
      ];
  }
}

/**
 * Checks the floating preview's GPU draw (`FloatGpu`) against the reference the session records
 * with (`FloatingSource.compose`), over the whole image, for one case of `FLOAT_CASES`.
 */
export async function checkFloat(device: GPUDevice, id: string): Promise<CheckResult> {
  const kase = FLOAT_CASES.find((candidate) => candidate.id === id);
  if (kase === undefined) throw new Error(`Unknown float case ${id}.`);
  const layer = pattern(DOC.width, DOC.height);
  const docRect = rect(0, 0, DOC.width, DOC.height);
  const { polygons, quality } = selectionOf(kase.shape);
  const selection = new Selection(polygons, quality);
  const area = intersectRects(selection.bounds(), docRect);
  const content = new Surface(area.width, area.height);
  content.copyFrom(layer, area, 0, 0);
  const coverage = kase.shape === "all" ? undefined : selection.mask(area);
  const outline = polygons.map((ring) =>
    transformPolygon(ring, translationAffine(-area.x, -area.y)),
  );
  const source = new FloatingSource(content, coverage, outline, quality);
  const base = layer.clone();
  base.copyFrom(remainingAfterLift(content, coverage), content.bounds, area.x, area.y);
  const options: TransformOptions = { sampling: kase.sampling, linearLight: kase.linearLight };
  const moves = movesOf(kase.move, area);

  let expected = base;
  for (const m of moves) expected = source.compose(expected, docRect, docRect, m, options);

  const placements: FloatPlacement[] = moves.map((m) => ({
    transform: m,
    options,
    shape: source.shape.transform(m).commit().effectivePolygons(),
    quality,
  }));
  const regionBase = new Surface(REGION.width, REGION.height);
  regionBase.copyFrom(base, base.bounds, 0, 0);
  const placement = placements.at(-1) as FloatPlacement;
  const float: FloatLayer = {
    layerId: 1,
    index: 0,
    contentKey: 1,
    content: {
      width: content.width,
      height: content.height,
      pixels: new Uint8Array(content.data.buffer.slice(0)),
      coverage,
    },
    baseKey: 1,
    base: { region: REGION, pixels: new Uint8Array(regionBase.data.buffer.slice(0)) },
    placement: syncPlacement(placement),
    stamps: placements.slice(0, -1).map(syncPlacement),
  };
  const gpu = new FloatGpu(device);
  try {
    const encoder = device.createCommandEncoder();
    gpu.encode(encoder, float, DOC);
    const texture = gpu.texture as GPUTexture;
    const bytesPerRow = REGION.width * 4;
    const buffer = device.createBuffer({ size: bytesPerRow * REGION.height, usage: 0x1 | 0x8 });
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [
      REGION.width,
      REGION.height,
    ]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(0x1);
    const got = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.destroy();
    let maxDifference = 0;
    let differingChannels = 0;
    for (let y = 0; y < REGION.height; y++) {
      for (let x = 0; x < REGION.width; x++) {
        for (let k = 0; k < 4; k++) {
          const inside = x < DOC.width && y < DOC.height;
          const want = inside ? (expected.data[(y * DOC.width + x) * 4 + k] ?? 0) : 0;
          const difference = Math.abs((got[(y * REGION.width + x) * 4 + k] ?? 0) - want);
          if (difference > 0) differingChannels++;
          maxDifference = Math.max(maxDifference, difference);
        }
      }
    }
    return { maxDifference, differingChannels };
  } finally {
    gpu.destroy();
  }
}
