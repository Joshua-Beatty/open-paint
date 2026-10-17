import { expect, type Page } from "@playwright/test";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The engine canvas, without the overlays that sit on top of it. */
export const ENGINE_CANVAS = "[data-backend] canvas:not(.app-canvas-overlay)";

/**
 * Multi-touch input through the DevTools protocol (Chromium only). Each call sends the full set of
 * fingers now down; a finger missing from the next set has lifted.
 */
export class Touchscreen {
  readonly #page: Page;
  #session: Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>> | undefined;

  constructor(page: Page) {
    this.#page = page;
  }

  async #send(
    type: "touchStart" | "touchMove" | "touchEnd",
    points: readonly Point[],
  ): Promise<void> {
    this.#session ??= await this.#page.context().newCDPSession(this.#page);
    await this.#session.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((point, id) => ({ x: point.x, y: point.y, id })),
    });
  }

  start(points: readonly Point[]): Promise<void> {
    return this.#send("touchStart", points);
  }

  move(points: readonly Point[]): Promise<void> {
    return this.#send("touchMove", points);
  }

  end(): Promise<void> {
    return this.#send("touchEnd", []);
  }

  /** Moves every finger from `from` to `to` in `steps` frames, then lifts them all. */
  async drag(from: readonly Point[], to: readonly Point[], steps = 10): Promise<void> {
    await this.start(from);
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      await this.move(
        from.map((point, index) => {
          const end = to[index] ?? point;
          return { x: point.x + (end.x - point.x) * t, y: point.y + (end.y - point.y) * t };
        }),
      );
      await this.#page.waitForTimeout(16);
    }
    await this.end();
  }
}

export async function canvasBox(page: Page) {
  const canvas = page.locator(ENGINE_CANVAS);
  await expect(canvas).toHaveCount(1);
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("the engine canvas has no box");
  return box;
}

const CANVAS_ONLY =
  ".app-canvas-overlay, .app-modifier-bar, .app-sheet { visibility: hidden !important; }";

/**
 * Bounds in CSS pixels of the canvas pixels that pass `kind`: the white image, or paint darker than the light canvas background, from a screenshot of the presented canvas.
 */
export async function pixelBounds(
  page: Page,
  kind: "white" | "ink",
): Promise<{ left: number; top: number; right: number; bottom: number; count: number }> {
  const box = await canvasBox(page);
  const png = await page.screenshot({ clip: box, style: CANVAS_ONLY });
  return page.evaluate(
    async ({ data, cssWidth, kind }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
      if (context === null) throw new Error("no 2D context");
      context.drawImage(bitmap, 0, 0);
      const { width, height } = bitmap;
      const pixels = context.getImageData(0, 0, width, height).data;
      const scan = (
        test: (r: number, g: number, b: number) => boolean,
        area = { left: 0, top: 0, right: width - 1, bottom: height - 1 },
      ) => {
        let left = width;
        let top = height;
        let right = -1;
        let bottom = -1;
        let count = 0;
        for (let y = area.top; y <= area.bottom; y++) {
          for (let x = area.left; x <= area.right; x++) {
            const i = (y * width + x) * 4;
            if (!test(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0)) continue;
            count++;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
          }
        }
        return { left, top, right, bottom, count };
      };
      const white = scan((r, g, b) => Math.min(r, g, b) > 250);
      // Paint is looked for inside the image only, since the area around it can be dark too.
      const { left, top, right, bottom, count } =
        kind === "white" || white.count === 0
          ? white
          : scan((r, g, b) => Math.max(r, g, b) < 160, white);
      const scale = width / cssWidth;
      return {
        left: left / scale,
        top: top / scale,
        right: right / scale,
        bottom: bottom / scale,
        count,
      };
    },
    { data: png.toString("base64"), cssWidth: box.width, kind },
  );
}
