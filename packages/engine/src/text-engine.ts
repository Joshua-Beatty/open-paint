import { context2d, createRenderCanvas, type RenderCanvas } from "./canvas";

/** How the Text tool rasterizes glyphs (TL-OPT-TEXT "Rendering mode", WEB-FONT-03). */
export type TextRenderingMode = "Smooth" | "Sharp" | "Classic";

/** A font face in pixels: its family and its bold and italic styles. */
export interface TextFace {
  readonly family: string;
  readonly sizePx: number;
  readonly bold: boolean;
  readonly italic: boolean;
}

/** The vertical metrics of a face, in whole pixels: the ascent above the baseline and the descent below. */
export interface TextFontMetrics {
  readonly ascent: number;
  readonly descent: number;
}

/** One line to draw. The position is relative to the mask's top left corner. */
export interface TextRasterLine {
  readonly text: string;
  /** The pen position of the line's first glyph. */
  readonly x: number;
  /** The baseline of the line. */
  readonly baseline: number;
  /** The advance width of the line, which the underline and strikeout span. */
  readonly width: number;
}

export interface TextRasterRequest {
  readonly face: TextFace;
  readonly mode: TextRenderingMode;
  /** Bilevel glyphs, for "Aliased rendering" (TL-OPT-AA). */
  readonly aliased: boolean;
  readonly underline: boolean;
  readonly strikeout: boolean;
  readonly lines: readonly TextRasterLine[];
  readonly width: number;
  readonly height: number;
}

/** A coverage mask: one alpha byte per pixel, row by row. */
export interface TextMask {
  readonly width: number;
  readonly height: number;
  readonly alpha: Uint8ClampedArray;
}

/**
 * The text engine the Text tool lays out and rasterizes with (WEB-FONT-03). Its output is a
 * coverage mask, so the tool composites the glyphs with the same blend path as every other tool.
 */
export interface TextEngine {
  metrics(face: TextFace): TextFontMetrics;
  /** The advance width of one line, in the glyph positioning of the mode. */
  measure(text: string, face: TextFace, mode: TextRenderingMode): number;
  rasterize(request: TextRasterRequest): TextMask;
}

/** The CSS font shorthand of a face. The family is followed by a generic fallback. */
export function canvasFontOf(face: TextFace): string {
  const family = face.family.replaceAll('"', "");
  const style = face.italic ? "italic " : "";
  const weight = face.bold ? "bold " : "";
  return `${style}${weight}${face.sizePx}px "${family}", sans-serif`;
}

type TextRendering = "geometricPrecision" | "optimizeLegibility" | "optimizeSpeed";

const TEXT_RENDERING: Readonly<Record<TextRenderingMode, TextRendering>> = {
  Smooth: "geometricPrecision",
  Sharp: "optimizeLegibility",
  Classic: "optimizeSpeed",
};

type Context = OffscreenCanvasRenderingContext2D & { textRendering: TextRendering };

/**
 * The text engine on Canvas 2D (`OffscreenCanvas`), the v1 rasterizer.
 * - Smooth: fractional glyph positions, unhinted outlines.
 * - Sharp: baselines and pen origins snapped to whole pixels, with the browser's legibility hinting.
 * - Classic (Sharp, pixel-snapped): every glyph is drawn at a whole pixel, and each advance is
 *   rounded, so the caret and the glyphs use the same positions.
 * Canvas 2D does not expose the hinting of a font engine, so the three modes differ in positioning
 * and text rendering only.
 */
export class CanvasTextEngine implements TextEngine {
  readonly #create: (width: number, height: number) => RenderCanvas;
  #scratch: Context | undefined;

  constructor(create: (width: number, height: number) => RenderCanvas = defaultCanvas) {
    this.#create = create;
  }

  metrics(face: TextFace): TextFontMetrics {
    const ctx = this.#measuring(face);
    const sample = ctx.measureText("Mgjpqy");
    const ascent = sample.fontBoundingBoxAscent ?? face.sizePx * 0.8;
    const descent = sample.fontBoundingBoxDescent ?? face.sizePx * 0.2;
    return { ascent: Math.ceil(ascent), descent: Math.ceil(descent) };
  }

  measure(text: string, face: TextFace, mode: TextRenderingMode): number {
    const ctx = this.#measuring(face);
    if (mode !== "Classic") return ctx.measureText(text).width;
    let width = 0;
    for (const glyph of Array.from(text)) width += Math.round(ctx.measureText(glyph).width);
    return width;
  }

  rasterize(request: TextRasterRequest): TextMask {
    const { width, height, face, mode, aliased, lines } = request;
    const alpha = new Uint8ClampedArray(width * height);
    if (width === 0 || height === 0) return { width, height, alpha };
    const ctx = this.#context(width, height);
    ctx.font = canvasFontOf(face);
    ctx.fillStyle = "#000";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.textRendering = TEXT_RENDERING[mode];
    const snap = (value: number) => (mode === "Smooth" ? value : Math.round(value));
    const thickness = Math.max(1, Math.round(face.sizePx / 14));
    for (const line of lines) {
      if (mode === "Classic") drawGlyphsWhole(ctx, line);
      else ctx.fillText(line.text, snap(line.x), snap(line.baseline));
      if (request.underline) {
        const y = line.baseline + Math.max(1, Math.round(face.sizePx / 12));
        ctx.fillRect(snap(line.x), snap(y), line.width, thickness);
      }
      if (request.strikeout) {
        const y = line.baseline - face.sizePx * 0.3;
        ctx.fillRect(snap(line.x), snap(y), line.width, thickness);
      }
    }
    const pixels = ctx.getImageData(0, 0, width, height).data;
    for (let index = 0; index < alpha.length; index++) {
      const coverage = pixels[index * 4 + 3] ?? 0;
      alpha[index] = aliased ? (coverage >= 128 ? 255 : 0) : coverage;
    }
    return { width, height, alpha };
  }

  /** A context of the given size, with nothing drawn yet. */
  #context(width: number, height: number): Context {
    const ctx = context2d(this.#create(width, height), { willReadFrequently: true });
    if (ctx === null) throw new Error("A 2D canvas context is not available for text.");
    return ctx as Context;
  }

  /** The shared scratch context, with the face's font set for measuring. */
  #measuring(face: TextFace): Context {
    this.#scratch ??= this.#context(1, 1);
    this.#scratch.font = canvasFontOf(face);
    return this.#scratch;
  }
}

/** Draws each glyph at a whole pixel, with the advances rounded as `measure` rounds them. */
function drawGlyphsWhole(ctx: Context, line: TextRasterLine): void {
  const x = Math.round(line.x);
  const baseline = Math.round(line.baseline);
  let pen = 0;
  for (const glyph of Array.from(line.text)) {
    ctx.fillText(glyph, x + pen, baseline);
    pen += Math.round(ctx.measureText(glyph).width);
  }
}

function defaultCanvas(width: number, height: number): RenderCanvas {
  return createRenderCanvas(width, height);
}
