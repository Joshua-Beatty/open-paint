import { describe, expect, it } from "vitest";
import { DISPLAY_TILE_SIZE, type DisplayTile } from "./display-tiles";
import {
  type CanvasTheme,
  DEFAULT_CANVAS_THEME,
  type FrameInput,
  frameStyle,
  planFrame,
  uiScale,
} from "./frame";
import { FIT_VIEW, type ViewState } from "./view";

function tile(level: number, tx: number, ty: number): DisplayTile {
  return { level, tx, ty, pixels: new Uint8Array(DISPLAY_TILE_SIZE * DISPLAY_TILE_SIZE * 4) };
}

function lookupOf(tiles: DisplayTile[]): FrameInput["lookup"] {
  const map = new Map(tiles.map((t) => [`${t.level}/${t.tx}/${t.ty}`, t]));
  return (level, tx, ty) => map.get(`${level}/${tx}/${ty}`);
}

const doc = { width: 300, height: 200 };
const viewport = { width: 800, height: 600 };

function input(view: ViewState, tiles: DisplayTile[] = [], scale = 1): FrameInput {
  return {
    view,
    doc,
    viewport,
    scale,
    theme: DEFAULT_CANVAS_THEME,
    lookup: lookupOf(tiles),
  };
}

describe("planFrame", () => {
  it("lists the visible tiles that are not cached as wanted, in row-major order", () => {
    const plan = planFrame(input(FIT_VIEW));
    expect(plan.tiles).toEqual([]);
    expect(plan.wanted).toEqual([
      { level: 0, tx: 0, ty: 0 },
      { level: 0, tx: 1, ty: 0 },
      { level: 0, tx: 2, ty: 0 },
      { level: 0, tx: 0, ty: 1 },
      { level: 0, tx: 1, ty: 1 },
      { level: 0, tx: 2, ty: 1 },
    ]);
  });

  it("draws cached tiles nearest-neighbor at 100 % and above, in device pixels", () => {
    const tiles = [0, 1, 2].flatMap((tx) => [0, 1].map((ty) => tile(0, tx, ty)));
    const plan = planFrame(input(FIT_VIEW, tiles));
    expect(plan.wanted).toEqual([]);
    expect(plan.zoom).toBeCloseTo(800 / 300);
    expect(plan.tiles.every((t) => t.sampling === "nearest")).toBe(true);
    const second = plan.tiles[1];
    expect(second?.src).toEqual({ x: 0, y: 0, width: 128, height: 128 });
    expect(second?.dst).toEqual({ x: 341, y: 33, width: 342, height: 341 });
  });

  it("keeps drawing stale tiles while requesting their rebuild", () => {
    const tiles = [0, 1, 2].flatMap((tx) => [0, 1].map((ty) => tile(0, tx, ty)));
    const plan = planFrame({
      ...input(FIT_VIEW, tiles),
      stale: (level, tx, ty) => level === 0 && tx === 1 && ty === 0,
    });
    expect(plan.tiles).toHaveLength(6);
    expect(plan.wanted).toEqual([{ level: 0, tx: 1, ty: 0 }]);
  });

  it("shares edges between neighbouring tiles so no seams open", () => {
    const tiles = [0, 1, 2].flatMap((tx) => [0, 1].map((ty) => tile(0, tx, ty)));
    const row = planFrame(input(FIT_VIEW, tiles)).tiles.filter((t) => t.tile.ty === 0);
    for (let i = 0; i + 1 < row.length; i++) {
      const a = row[i]?.dst;
      const b = row[i + 1]?.dst;
      expect((a?.x ?? 0) + (a?.width ?? 0)).toBe(b?.x);
    }
  });

  it("places a document smaller than the viewport at its zoom, centered", () => {
    const plan = planFrame(input({ mode: "fixed", zoom: 2, originX: 10, originY: 20 }));
    expect(plan.canvas).toEqual({ x: 100, y: 100, width: 600, height: 400 });
    expect(plan.zoom).toBe(2);
  });

  it("clamps a larger document's origin to the viewport", () => {
    const big = { width: 2000, height: 2000 };
    const plan = planFrame({
      ...input({ mode: "fixed", zoom: 2, originX: 50, originY: -10_000 }),
      doc: big,
    });
    expect(plan.canvas).toEqual({ x: 0, y: -3400, width: 4000, height: 4000 });
  });

  it("draws the coarser mip underneath a missing tile, with its covering part as the source", () => {
    const coarse = tile(2, 0, 0);
    const view: ViewState = { mode: "fixed", zoom: 0.3, originX: 0, originY: 0 };
    const plan = planFrame(input(view, [coarse]));
    expect(plan.wanted).toEqual([
      { level: 1, tx: 0, ty: 0 },
      { level: 1, tx: 1, ty: 0 },
    ]);
    // The 300 x 200 image covers all of the first level-1 tile across, 44 of 256 pixels of the
    // second, and 200 of 256 down: only that part of each quarter is drawn.
    expect(plan.tiles.map((t) => t.src)).toEqual([
      { x: 0, y: 0, width: 64, height: 50 },
      { x: 64, y: 0, width: 11, height: 50 },
    ]);
    expect(plan.tiles.every((t) => t.tile === coarse && t.sampling === "bilinear")).toBe(true);
  });

  describe("the image covers the checkerboard exactly (UI-VIEW-02)", () => {
    const sizes = [
      { width: 300, height: 200 },
      { width: 1001, height: 777 },
      { width: 4097, height: 3001 },
      { width: 129, height: 5000 },
    ];
    const viewports = [
      { width: 800, height: 600 },
      { width: 1333, height: 911 },
      { width: 517, height: 389 },
    ];

    function cachedEverywhere(): FrameInput["lookup"] {
      return (level, tx, ty) => tile(level, tx, ty);
    }

    it("ends the edge tiles at the canvas edge, showing exactly the image's part of them", () => {
      for (const size of sizes) {
        for (const port of viewports) {
          for (const view of [
            FIT_VIEW,
            { mode: "fixed", zoom: 0.37, originX: 0, originY: 0 } as const,
            { mode: "fixed", zoom: 0.173, originX: 3, originY: 7 } as const,
          ]) {
            const plan = planFrame({
              ...input(view),
              doc: size,
              viewport: port,
              lookup: cachedEverywhere(),
            });
            const { canvas } = plan;
            const right = canvas.x + canvas.width;
            const bottom = canvas.y + canvas.height;
            for (const draw of plan.tiles) {
              const { dst, src, tile: t } = draw;
              expect(dst.x + dst.width).toBeLessThanOrEqual(right);
              expect(dst.y + dst.height).toBeLessThanOrEqual(bottom);
              const scale = 2 ** t.level;
              const docRight = t.tx * DISPLAY_TILE_SIZE * scale + (src.x + src.width) * scale;
              const docBottom = t.ty * DISPLAY_TILE_SIZE * scale + (src.y + src.height) * scale;
              // Where a dst meets the canvas edge, its source ends at the image's edge, or less than
              // a device pixel before it when the last tile's sliver rounds away.
              const pixel = 1 / plan.zoom;
              expect(docRight).toBeLessThanOrEqual(size.width + 1e-9);
              expect(docBottom).toBeLessThanOrEqual(size.height + 1e-9);
              if (dst.x + dst.width === right) expect(docRight).toBeGreaterThan(size.width - pixel);
              if (dst.y + dst.height === bottom) {
                expect(docBottom).toBeGreaterThan(size.height - pixel);
              }
            }
          }
        }
      }
    });

    it("covers every device pixel of the visible canvas once", () => {
      for (const size of sizes) {
        for (const port of viewports) {
          const plan = planFrame({
            ...input(FIT_VIEW),
            doc: size,
            viewport: port,
            lookup: cachedEverywhere(),
          });
          const { canvas } = plan;
          const area = plan.tiles.reduce((sum, { dst }) => sum + dst.width * dst.height, 0);
          expect(area).toBe(canvas.width * canvas.height);
          for (const { dst } of plan.tiles) {
            expect(dst.x).toBeGreaterThanOrEqual(canvas.x);
            expect(dst.y).toBeGreaterThanOrEqual(canvas.y);
          }
        }
      }
    });
  });

  it("plans only the tiles that overlap the viewport when zoomed in", () => {
    // Zoom 4 scrolled 1000 px right: the viewport shows document x 250-450 and y 0-150.
    const view: ViewState = { mode: "fixed", zoom: 4, originX: -1000, originY: 0 };
    const plan = planFrame({ ...input(view), doc: { width: 2000, height: 2000 } });
    expect(plan.wanted).toEqual([
      { level: 0, tx: 1, ty: 0 },
      { level: 0, tx: 2, ty: 0 },
      { level: 0, tx: 3, ty: 0 },
      { level: 0, tx: 1, ty: 1 },
      { level: 0, tx: 2, ty: 1 },
      { level: 0, tx: 3, ty: 1 },
    ]);
  });

  it("plans an empty frame for an empty document", () => {
    const plan = planFrame({ ...input(FIT_VIEW), doc: { width: 0, height: 0 } });
    expect(plan.tiles).toEqual([]);
    expect(plan.wanted).toEqual([]);
  });
});

describe("frame style (UI-VIEW-02)", () => {
  it("uses the power-of-two UI scale for the checkerboard and shadow", () => {
    expect(uiScale(0.5)).toBe(1);
    expect(uiScale(1)).toBe(1);
    expect(uiScale(1.5)).toBe(1);
    expect(uiScale(2)).toBe(2);
    expect(uiScale(3)).toBe(2);
    const style = frameStyle(DEFAULT_CANVAS_THEME, 2);
    expect(style.checker.size).toBe(8);
    expect(style.shadow.sigma).toBe(8);
  });

  it("scales the checker squares by the brightness, 255 light and 191 dark", () => {
    const theme: CanvasTheme = { ...DEFAULT_CANVAS_THEME, checkerBrightness: 0.5 };
    const style = frameStyle(theme, 1);
    expect(style.checker.light).toBe(127.5);
    expect(style.checker.dark).toBe(95.5);
  });

  it("omits the border unless a custom color is set", () => {
    expect(frameStyle(DEFAULT_CANVAS_THEME, 1).border).toBeUndefined();
    expect(frameStyle({ ...DEFAULT_CANVAS_THEME, border: [255, 0, 0] }, 1).border).toEqual([
      255, 0, 0,
    ]);
  });
});
