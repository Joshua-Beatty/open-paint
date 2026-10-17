import { describe, expect, it } from "vitest";
import { CanvasTextEngine, canvasFontOf, type TextFace } from "./text-engine";

const FACE: TextFace = { family: "Noto Sans", sizePx: 16, bold: false, italic: false };

/** A recording 2D context: every glyph paints a 2 by 2 block of coverage 200 at its origin. */
class FakeContext {
  font = "";
  fillStyle = "";
  textAlign = "";
  textBaseline = "";
  textRendering = "";
  readonly fills: string[] = [];
  readonly rects: string[] = [];
  readonly pixels: Uint8ClampedArray;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  measureText(text: string) {
    return {
      width: [...text].length * 5.4,
      fontBoundingBoxAscent: 12.2,
      fontBoundingBoxDescent: 3,
    };
  }

  fillText(text: string, x: number, y: number): void {
    this.fills.push(`${text}@${x},${y}`);
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const index = ((y - 2 + dy) * this.width + (x + dx)) * 4 + 3;
        if (index >= 0 && index < this.pixels.length) this.pixels[index] = 200;
      }
    }
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.rects.push(`${x},${y},${width},${height}`);
  }

  getImageData(_x: number, _y: number, width: number, height: number) {
    return { data: this.pixels.slice(0, width * height * 4) };
  }
}

function engineWith(contexts: FakeContext[]): CanvasTextEngine {
  return new CanvasTextEngine(
    (width, height) =>
      ({
        getContext: () => {
          const context = new FakeContext(width, height);
          contexts.push(context);
          return context;
        },
      }) as unknown as OffscreenCanvas,
  );
}

describe("canvasFontOf (WEB-FONT-02)", () => {
  it("names the family with a generic fallback, and adds the styles", () => {
    expect(canvasFontOf(FACE)).toBe('16px "Noto Sans", sans-serif');
    expect(canvasFontOf({ ...FACE, bold: true, italic: true })).toBe(
      'italic bold 16px "Noto Sans", sans-serif',
    );
  });
});

describe("CanvasTextEngine", () => {
  it("reads the font's ascent and descent in whole pixels", () => {
    const engine = engineWith([]);
    expect(engine.metrics(FACE)).toEqual({ ascent: 13, descent: 3 });
  });

  it("measures a line in each mode, and Classic rounds each advance", () => {
    const engine = engineWith([]);
    expect(engine.measure("abc", FACE, "Smooth")).toBeCloseTo(16.2, 6);
    expect(engine.measure("abc", FACE, "Classic")).toBe(15);
  });

  it("draws Smooth text at fractional positions and Sharp text at whole ones", () => {
    const contexts: FakeContext[] = [];
    const engine = engineWith(contexts);
    const line = { text: "ab", x: 1.5, baseline: 12.25, width: 10 };
    engine.rasterize({
      face: FACE,
      mode: "Smooth",
      aliased: false,
      underline: false,
      strikeout: false,
      lines: [line],
      width: 30,
      height: 20,
    });
    expect(contexts[0]?.fills).toEqual(["ab@1.5,12.25"]);
    expect(contexts[0]?.textRendering).toBe("geometricPrecision");
    engine.rasterize({
      face: FACE,
      mode: "Sharp",
      aliased: false,
      underline: false,
      strikeout: false,
      lines: [line],
      width: 30,
      height: 20,
    });
    expect(contexts[1]?.fills).toEqual(["ab@2,12"]);
    expect(contexts[1]?.textRendering).toBe("optimizeLegibility");
  });

  it("Classic draws each glyph at a whole pixel with the rounded advances", () => {
    const contexts: FakeContext[] = [];
    const engine = engineWith(contexts);
    engine.rasterize({
      face: FACE,
      mode: "Classic",
      aliased: false,
      underline: false,
      strikeout: false,
      lines: [{ text: "abc", x: 0.4, baseline: 12.6, width: 15 }],
      width: 30,
      height: 20,
    });
    expect(contexts[0]?.fills).toEqual(["a@0,13", "b@5,13", "c@10,13"]);
    expect(contexts[0]?.textRendering).toBe("optimizeSpeed");
  });

  it("returns the coverage, or bilevel coverage for aliased rendering", () => {
    const engine = engineWith([]);
    const request = {
      face: FACE,
      mode: "Smooth" as const,
      underline: false,
      strikeout: false,
      lines: [{ text: "a", x: 0, baseline: 4, width: 5 }],
      width: 8,
      height: 8,
    };
    const soft = engine.rasterize({ ...request, aliased: false });
    expect(soft.alpha[(2 * 8 + 0) * 1 + 0]).toBe(200);
    const hard = engine.rasterize({ ...request, aliased: true });
    expect(hard.alpha[2 * 8]).toBe(255);
    expect(hard.alpha[0]).toBe(0);
  });

  it("draws the underline and the strikeout as rectangles over the line", () => {
    const contexts: FakeContext[] = [];
    const engine = engineWith(contexts);
    engine.rasterize({
      face: FACE,
      mode: "Sharp",
      aliased: false,
      underline: true,
      strikeout: true,
      lines: [{ text: "ab", x: 2, baseline: 12, width: 10 }],
      width: 30,
      height: 20,
    });
    expect(contexts[0]?.rects).toEqual(["2,13,10,1", "2,7,10,1"]);
  });

  it("an empty area is an empty mask, without a canvas", () => {
    const contexts: FakeContext[] = [];
    const mask = engineWith(contexts).rasterize({
      face: FACE,
      mode: "Smooth",
      aliased: false,
      underline: false,
      strikeout: false,
      lines: [],
      width: 0,
      height: 5,
    });
    expect(mask.alpha.length).toBe(0);
    expect(contexts).toHaveLength(0);
  });
});
